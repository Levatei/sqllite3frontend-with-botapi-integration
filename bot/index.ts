import crypto from 'node:crypto';
import { Bot, InlineKeyboard, Keyboard, type Context } from 'grammy';
import { assertConfig, config } from './config';
import { logError, logInfo, logWarn } from './logger';
import { isAllowed } from './whitelist';
import { extractNameplate, pingOllama, warmupModel, type Nameplate } from './vision';
import {
  clientLabel,
  findClients,
  getClientById,
  insertClient,
  insertEquipment,
  insertOrder,
  listRecentClients,
  migrateLegacyOrderPhotos,
  type Row,
} from './db';
import { saveBotMedia } from './media';
import { DENY_TEXT, HELP_TEXT, fmtNameplate, hasAnyField } from './messages';

interface NameplateSession {
  kind: 'nameplate';
  step: 'await_photo' | 'client_type' | 'client_search' | 'new_name' | 'new_number' | 'new_mail' | 'confirm';
  nameplate: Nameplate;
  photo?: { buffer: Buffer; mime: string; thumbBuffer: Buffer | null };
  clientId?: number;
  clientLabel?: string;
  newClient?: { name?: string; number?: string; mail?: string };
}

interface MediaSession {
  kind: 'media';
  step: 'await_model' | 'collecting';
  batchId: string;
  model?: string;
  count: number;
}

type Session = NameplateSession | MediaSession;

const sessions = new Map<number, Session>();

function reset(chatId: number): void {
  sessions.delete(chatId);
}

function emptyNameplate(): Nameplate {
  return {
    manufacturer: null,
    model: null,
    serial_number: null,
    production_date: null,
    article_number: null,
  };
}

// Постоянное меню снизу: две кнопки вместо команд-ссылок.
function menuKeyboard(): Keyboard {
  return new Keyboard()
    .text('📷 Фото шильдика')
    .text('📎 Сохранить фотографию')
    .resized();
}

function clientTypeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🆕 Новый клиент', 'ct:new')
    .text('🔍 Существующий клиент', 'ct:existing');
}

function confirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Записать', 'confirm:yes')
    .text('✖ Отменить', 'confirm:no');
}

function candidatesKeyboard(rows: Row[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const row of rows) {
    kb.text(clientLabel(row), `pick:${row.client_id}`).row();
  }
  kb.text('✖ Отмена', 'confirm:no');
  return kb;
}

async function deny(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId !== undefined) logWarn(`Отказано в доступе chat_id=${chatId}`, { from: ctx.from?.username });
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: DENY_TEXT, show_alert: true }).catch(() => {});
  } else {
    await ctx.reply(DENY_TEXT).catch(() => {});
  }
}

async function fetchTelegramFile(ctx: Context, fileId: string): Promise<Buffer> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram не вернул file_path');
  const url = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не удалось скачать файл: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function summaryText(session: NameplateSession, isNew: boolean): string {
  const lines: string[] = [];
  lines.push(fmtNameplate(session.nameplate));
  lines.push('');
  lines.push(isNew ? `👤 Новый клиент: ${session.newClient?.name ?? '—'}` : `👤 Клиент: ${session.clientLabel ?? '—'}`);
  if (isNew) {
    if (session.newClient?.number) lines.push(`📞 Телефон: ${session.newClient.number}`);
    if (session.newClient?.mail) lines.push(`✉️ Email: ${session.newClient.mail}`);
  }
  lines.push(`🗂 Заявка: ${config.orderStatus}`);
  lines.push('');
  lines.push('Записать в базу?');
  return lines.join('\n');
}

// ---------- Сценарий 1: фото шильдика → новая заявка ----------

async function startNameplate(ctx: Context, chatId: number): Promise<void> {
  sessions.set(chatId, { kind: 'nameplate', step: 'await_photo', nameplate: emptyNameplate() });
  await ctx.reply('📷 Пришлите фото шильдика.', { reply_markup: menuKeyboard() });
}

async function recognizeNameplate(
  ctx: Context,
  chatId: number,
  session: NameplateSession,
  photos: { file_id: string; file_unique_id: string }[]
): Promise<void> {
  const status = await ctx.reply('📷 Читаю шильдик, подождите…');

  let finished = false;
  let elapsed = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    if (finished) return;
    elapsed += 10;
    ctx.api.editMessageText(chatId, status.message_id, `⏳ Распознаю шильдик… ${elapsed} с`).catch(() => {});
    timer = setTimeout(tick, 10000);
  };
  timer = setTimeout(tick, 10000);

  const largest = photos[photos.length - 1];
  const smallest = photos[0];

  let buffer: Buffer;
  let thumbBuffer: Buffer | null = null;
  try {
    buffer = await fetchTelegramFile(ctx, largest.file_id);
  } catch (e) {
    finished = true;
    if (timer) clearTimeout(timer);
    logError(`Ошибка скачивания фото chat_id=${chatId}`, { error: String(e) });
    await ctx.api
      .editMessageText(chatId, status.message_id, '⚠️ Не удалось получить фото из Telegram. Отправьте ещё раз.')
      .catch(() => {});
    return;
  }
  if (smallest.file_id !== largest.file_id) {
    try {
      thumbBuffer = await fetchTelegramFile(ctx, smallest.file_id);
    } catch {
      thumbBuffer = null;
    }
  }

  try {
    const data = await extractNameplate(buffer.toString('base64'));
    finished = true;
    if (timer) clearTimeout(timer);
    sessions.set(chatId, {
      kind: 'nameplate',
      step: 'client_type',
      nameplate: data,
      photo: { buffer, mime: 'image/jpeg', thumbBuffer },
    });
    const header = hasAnyField(data)
      ? fmtNameplate(data)
      : 'Шильдик не распознан — поля пустые, можно заполнить вручную.';
    await ctx.api.editMessageText(
      chatId,
      status.message_id,
      `${header}\n\nЭто новый клиент или существующий?`,
      { reply_markup: clientTypeKeyboard() }
    );
    logInfo(`Шильдик распознан chat_id=${chatId}`, data);
  } catch (e) {
    finished = true;
    if (timer) clearTimeout(timer);
    logError(`Ошибка распознавания модели chat_id=${chatId}`, { error: String(e) });
    await ctx.api
      .editMessageText(
        chatId,
        status.message_id,
        '⚠️ Не удалось распознать фото: сервис модели не ответил. Подождите и отправьте ещё раз.'
      )
      .catch(() => {});
  }
}

// ---------- Сценарий 2: модель + пачка медиафайлов ----------

async function startMedia(ctx: Context, chatId: number): Promise<void> {
  sessions.set(chatId, {
    kind: 'media',
    step: 'await_model',
    batchId: crypto.randomUUID(),
    count: 0,
  });
  await ctx.reply('📎 Отправьте модель насоса (текстом).');
}

interface CollectedMedia {
  buffer: Buffer;
  mime: string;
  thumbBuffer: Buffer | null;
  originalName?: string;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

async function collectMedia(
  ctx: Context,
  chatId: number,
  session: MediaSession,
  media: CollectedMedia
): Promise<void> {
  try {
    saveBotMedia({
      buffer: media.buffer,
      mime: media.mime,
      originalName: media.originalName,
      thumbBuffer: media.thumbBuffer,
      model: session.model ?? null,
      batchId: session.batchId,
      role: 'media',
      caption: media.caption ?? null,
      width: media.width ?? null,
      height: media.height ?? null,
      duration: media.duration ?? null,
    });
    session.count += 1;
    const name = session.model ? `«${session.model}»` : '';
    await ctx.reply(`✅ Принято ${name}, файл ${session.count}. Ещё? /finish — закончить.`);
  } catch (e) {
    logError(`Ошибка сохранения медиа chat_id=${chatId}`, { error: String(e) });
    await ctx.reply('⚠️ Не удалось сохранить файл. Попробуйте ещё раз.');
  }
}

// ---------- Обработчики сообщений ----------

async function onPhoto(
  ctx: Context,
  chatId: number,
  photos: { file_id: string; file_unique_id: string }[]
): Promise<void> {
  const session = sessions.get(chatId);
  if (!session) {
    await ctx.reply('Выберите действие кнопкой внизу.', { reply_markup: menuKeyboard() });
    return;
  }
  if (session.kind === 'media') {
    if (session.step !== 'collecting') {
      await ctx.reply('Сначала пришлите модель насоса текстом.');
      return;
    }
    const largest = photos[photos.length - 1];
    const smallest = photos[0];
    try {
      const buffer = await fetchTelegramFile(ctx, largest.file_id);
      let thumbBuffer: Buffer | null = null;
      if (smallest.file_id !== largest.file_id) {
        try {
          thumbBuffer = await fetchTelegramFile(ctx, smallest.file_id);
        } catch {
          thumbBuffer = null;
        }
      }
      await collectMedia(ctx, chatId, session, {
        buffer,
        mime: 'image/jpeg',
        thumbBuffer,
        caption: ctx.message?.caption ?? null,
      });
    } catch (e) {
      logError(`Ошибка скачивания фото (медиа) chat_id=${chatId}`, { error: String(e) });
      await ctx.reply('⚠️ Не удалось получить фото из Telegram. Отправьте ещё раз.');
    }
    return;
  }
  if (session.step !== 'await_photo') {
    await ctx.reply('Отправьте фото шильдика или используйте кнопки меню.', {
      reply_markup: menuKeyboard(),
    });
    return;
  }
  await recognizeNameplate(ctx, chatId, session, photos);
}

async function onVideo(
  ctx: Context,
  chatId: number,
  video: {
    file_id: string;
    mime_type?: string;
    file_name?: string;
    width?: number;
    height?: number;
    duration?: number;
    thumbnail?: { file_id: string };
  }
): Promise<void> {
  const session = sessions.get(chatId);
  if (!session || session.kind !== 'media' || session.step !== 'collecting') {
    await ctx.reply('Видео можно приложить по кнопке «📎 Сохранить фотографию».', {
      reply_markup: menuKeyboard(),
    });
    return;
  }
  try {
    const buffer = await fetchTelegramFile(ctx, video.file_id);
    let thumbBuffer: Buffer | null = null;
    if (video.thumbnail) {
      try {
        thumbBuffer = await fetchTelegramFile(ctx, video.thumbnail.file_id);
      } catch {
        thumbBuffer = null;
      }
    }
    await collectMedia(ctx, chatId, session, {
      buffer,
      mime: video.mime_type || 'video/mp4',
      thumbBuffer,
      originalName: video.file_name,
      caption: ctx.message?.caption ?? null,
      width: video.width ?? null,
      height: video.height ?? null,
      duration: video.duration ?? null,
    });
  } catch (e) {
    logError(`Ошибка скачивания видео chat_id=${chatId}`, { error: String(e) });
    await ctx.reply(
      '⚠️ Не удалось скачать видео (возможно, больше 20 МБ — ограничение Telegram). Загрузите его через сайт в разделе «Медиафайлы».'
    );
  }
}

async function onText(ctx: Context, chatId: number, text: string): Promise<void> {
  const session = sessions.get(chatId);
  if (!session) {
    await ctx.reply('Выберите действие кнопкой внизу.', { reply_markup: menuKeyboard() });
    return;
  }
  if (session.kind === 'media') {
    if (session.step === 'await_model') {
      session.model = text;
      session.step = 'collecting';
      await ctx.reply(
        `Модель «${text}» записана. Отправьте пачку медиафайлов. /finish — закончить.`,
        { reply_markup: menuKeyboard() }
      );
      return;
    }
    await ctx.reply('Пришлите фото или видео, либо /finish.');
    return;
  }

  switch (session.step) {
    case 'client_search': {
      const found = findClients(text, 8);
      if (found.length === 0) {
        await ctx.reply('Ничего не найдено. Введите другое имя или телефон, либо /cancel.');
        return;
      }
      await ctx.reply('Выберите клиента:', { reply_markup: candidatesKeyboard(found) });
      return;
    }
    case 'new_name': {
      session.newClient = { ...(session.newClient ?? {}), name: text };
      session.step = 'new_number';
      await ctx.reply('Телефон клиента (или «-», чтобы пропустить):');
      return;
    }
    case 'new_number': {
      session.newClient = { ...(session.newClient ?? {}), number: text === '-' ? '' : text };
      session.step = 'new_mail';
      await ctx.reply('Email клиента (или «-», чтобы пропустить):');
      return;
    }
    case 'new_mail': {
      session.newClient = { ...(session.newClient ?? {}), mail: text === '-' ? '' : text };
      session.clientLabel = session.newClient.name ?? 'Новый клиент';
      session.step = 'confirm';
      await ctx.reply(summaryText(session, true), { reply_markup: confirmKeyboard() });
      return;
    }
    default:
      await ctx.reply('Отправьте фото шильдика или используйте кнопки меню.', {
        reply_markup: menuKeyboard(),
      });
  }
}

async function confirmNameplate(ctx: Context, chatId: number, session: NameplateSession): Promise<void> {
  let clientId = session.clientId;
  let createdClient = false;
  if (clientId === undefined) {
    const nc = session.newClient ?? {};
    clientId = insertClient({
      name: (nc.name ?? '').trim() || 'Без названия',
      number: nc.number,
      mail: nc.mail,
    });
    createdClient = true;
  }
  const equipmentId = insertEquipment(clientId, session.nameplate);
  const orderId = insertOrder(clientId, equipmentId);
  if (session.photo) {
    saveBotMedia({
      buffer: session.photo.buffer,
      mime: session.photo.mime,
      thumbBuffer: session.photo.thumbBuffer,
      clientId,
      equipmentId,
      orderId,
      role: 'nameplate',
    });
  }
  reset(chatId);
  await ctx
    .editMessageText(
      [
        '✅ Записано в базу.',
        `Клиент #${clientId}${createdClient ? ' (новый)' : ''}`,
        `Оборудование #${equipmentId}`,
        `Заявка #${orderId} · ${config.orderStatus}`,
      ].join('\n')
    )
    .catch(() => {});
  logInfo(`Заявка создана chat_id=${chatId}`, { clientId, equipmentId, orderId, createdClient });
}

async function reportOllamaHealth(): Promise<void> {
  if (config.llm.provider !== 'ollama' || !config.llm.healthcheckOnStart) return;
  for (const url of config.llm.ollamaUrls) {
    const health = await pingOllama(url, config.llm.ollamaModel);
    if (health.ok && health.modelPresent) {
      logInfo(`Ollama доступна: ${url} (модель ${config.llm.ollamaModel} найдена)`);
    } else if (health.ok) {
      logWarn(`Ollama доступна: ${url}, но модель ${config.llm.ollamaModel} не найдена — проверьте OLLAMA_MODEL`);
    } else {
      logWarn(`Ollama недоступна: ${url}`, { error: health.error });
    }
  }
}

async function main(): Promise<void> {
  assertConfig();
  await reportOllamaHealth();
  const migrated = migrateLegacyOrderPhotos();
  if (migrated > 0) logInfo(`Перенесено старых фото шильдиков в медиа: ${migrated}`);

  const bot = new Bot(config.telegramToken);

  bot.command('start', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || !isAllowed(chatId)) return deny(ctx);
    reset(chatId);
    await ctx.reply(
      'Привет! Выберите действие кнопкой внизу.\n\n📷 Фото шильдика — распознать и создать заявку.\n📎 Сохранить фотографию — записать модель насоса и пачку медиафайлов.',
      { reply_markup: menuKeyboard() }
    );
  });

  bot.command('help', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || !isAllowed(chatId)) return deny(ctx);
    await ctx.reply(HELP_TEXT, { reply_markup: menuKeyboard() });
  });

  bot.command('whoami', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || !isAllowed(chatId)) return deny(ctx);
    await ctx.reply(`Ваш chat_id: ${chatId}`);
  });

  bot.command('cancel', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || !isAllowed(chatId)) return deny(ctx);
    reset(chatId);
    await ctx.reply('Отменено. Выберите действие кнопкой внизу.', { reply_markup: menuKeyboard() });
  });

  bot.command('finish', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || !isAllowed(chatId)) return deny(ctx);
    const session = sessions.get(chatId);
    if (session && session.kind === 'media') {
      const info =
        session.count > 0
          ? `Сохранено файлов: ${session.count} (модель «${session.model ?? '—'}»).`
          : 'Файлы не отправлялись.';
      reset(chatId);
      await ctx.reply(`✅ Готово. ${info}`, { reply_markup: menuKeyboard() });
    } else {
      await ctx.reply('Нет активного прикрепления.', { reply_markup: menuKeyboard() });
    }
  });

  // --- Выбор типа клиента ---
  bot.callbackQuery('ct:new', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!isAllowed(chatId)) return deny(ctx);
    const session = sessions.get(chatId);
    if (!session || session.kind !== 'nameplate' || session.step !== 'client_type') {
      await ctx.answerCallbackQuery({ text: 'Устарело. Начните заново.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    session.step = 'new_name';
    session.newClient = {};
    await ctx.editMessageText(`${fmtNameplate(session.nameplate)}\n\n👤 Новый клиент`).catch(() => {});
    await ctx.reply('Введите название клиента (компании):');
  });

  bot.callbackQuery('ct:existing', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!isAllowed(chatId)) return deny(ctx);
    const session = sessions.get(chatId);
    if (!session || session.kind !== 'nameplate' || session.step !== 'client_type') {
      await ctx.answerCallbackQuery({ text: 'Устарело. Начните заново.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    session.step = 'client_search';
    await ctx.editMessageText(`${fmtNameplate(session.nameplate)}\n\n🔍 Существующий клиент`).catch(() => {});
    const recent = listRecentClients(8);
    if (recent.length > 0) {
      await ctx.reply('Последние клиенты — выберите из списка или введите имя/телефон для поиска:', {
        reply_markup: candidatesKeyboard(recent),
      });
    } else {
      await ctx.reply('Введите имя или телефон клиента для поиска:');
    }
  });

  bot.callbackQuery(/^pick:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!isAllowed(chatId)) return deny(ctx);
    const session = sessions.get(chatId);
    if (!session || session.kind !== 'nameplate') {
      await ctx.answerCallbackQuery({ text: 'Устарело. Начните заново.', show_alert: true });
      return;
    }
    const id = Number(ctx.match[1]);
    const client = getClientById(id);
    if (!client) {
      await ctx.answerCallbackQuery({ text: 'Клиент не найден.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    session.clientId = id;
    session.clientLabel = clientLabel(client);
    session.step = 'confirm';
    await ctx.reply(summaryText(session, false), { reply_markup: confirmKeyboard() });
  });

  bot.callbackQuery('confirm:yes', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!isAllowed(chatId)) return deny(ctx);
    const session = sessions.get(chatId);
    if (!session || session.kind !== 'nameplate' || session.step !== 'confirm') {
      await ctx.answerCallbackQuery({ text: 'Устарело. Начните заново.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await confirmNameplate(ctx, chatId, session);
    } catch (e) {
      logError(`Ошибка записи в БД chat_id=${chatId}`, { error: String(e) });
      await ctx.reply(`Не удалось записать: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  bot.callbackQuery('confirm:no', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!isAllowed(chatId)) return deny(ctx);
    reset(chatId);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('✖ Отменено. Выберите действие кнопкой внизу.').catch(() => {});
    await ctx.reply('Готово.', { reply_markup: menuKeyboard() });
  });

  // --- Обычные сообщения: текстовые кнопки, фото, видео, текст ---
  bot.on('message', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!isAllowed(chatId)) return deny(ctx);
    const msg = ctx.message;

    if (typeof msg.text === 'string') {
      const text = msg.text.trim();
      if (text === '📷 Фото шильдика') return startNameplate(ctx, chatId);
      if (text === '📎 Сохранить фотографию') return startMedia(ctx, chatId);
      if (text.startsWith('/')) return; // неизвестная команда
      return onText(ctx, chatId, text);
    }

    if (msg.photo && msg.photo.length > 0) {
      return onPhoto(ctx, chatId, msg.photo);
    }
    if (msg.video) {
      return onVideo(ctx, chatId, msg.video);
    }
    if (msg.document && (msg.document.mime_type ?? '').startsWith('video/')) {
      return onVideo(ctx, chatId, {
        file_id: msg.document.file_id,
        mime_type: msg.document.mime_type,
        file_name: msg.document.file_name,
        thumbnail: msg.document.thumbnail,
      });
    }
  });

  bot.catch((err) => {
    logError('Необработанная ошибка бота', { error: String(err.error) });
  });

  await bot.api
    .setMyCommands([
      { command: 'start', description: 'Начать' },
      { command: 'help', description: 'Справка' },
      { command: 'finish', description: 'Закончить прикрепление медиафайлов' },
      { command: 'whoami', description: 'Мой chat_id' },
      { command: 'cancel', description: 'Отменить текущий диалог' },
    ])
    .catch(() => {});

  logInfo(`Бот запускается. Провайдер LLM: ${config.llm.provider}`, {
    model: config.llm.provider === 'openai' ? config.llm.openaiModel : config.llm.ollamaModel,
    endpoints:
      config.llm.provider === 'openai' ? [config.llm.openaiBaseUrl] : config.llm.ollamaUrls,
    fallbackToOpenAI: config.llm.fallbackToOpenAI,
  });

  void warmupModel();

  await bot.start({
    onStart: (info) => logInfo(`Бот @${info.username} слушает апдейты (long polling)`),
  });
}

main().catch((e) => {
  logError('Фатальная ошибка запуска бота', { error: String(e) });
  process.exit(1);
});
