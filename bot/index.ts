import fs from 'node:fs';
import { Bot, InlineKeyboard, InputFile, Keyboard, type Context } from 'grammy';
import { assertConfig, config } from './config';
import { logError, logInfo, logWarn } from './logger';
import { isAllowed } from './whitelist';
import { extractNameplate, pingOllama, warmupModel, type Nameplate } from './vision';
import {
  clientLabel,
  findClients,
  getClientById,
  getOrderDetails,
  insertClient,
  insertEquipment,
  insertOrder,
  listActiveOrders,
  listOrderMedia,
  listRecentClients,
  migrateLegacyOrderPhotos,
  updateOrderDiagnostics,
  type OrderDetails,
  type Row,
} from './db';
import { saveBotMedia } from './media';
import {
  absoluteMediaPath,
  guessMime,
  isImageMime,
  isInsideAllowedRoots,
  isVideoMime,
} from '../lib/media-store';
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
  step: 'await_order' | 'choose' | 'collecting';
  orderId?: number;
  orderLabel?: string;
  clientId?: number | null;
  equipmentId?: number | null;
  model?: string | null;
  count: number;
}

interface DiagnosticsSession {
  kind: 'diagnostics';
  step: 'await_text';
  orderId: number;
}

type Session = NameplateSession | MediaSession | DiagnosticsSession;

const sessions = new Map<number, Session>();

// Лимиты Telegram Bot API.
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // getFile — приём файла ботом
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // sendPhoto
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // sendVideo/sendDocument
const MEDIA_PAGE_SIZE = 10;

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
const MEDIA_BUTTON = '🖼 Медиафайлы заявки';
const ACTIVE_ORDERS_BUTTON = '📋 Актуальные заявки';
const MEDIA_BUTTON_LEGACY = '📎 Сохранить фотографию';

function menuKeyboard(): Keyboard {
  return new Keyboard()
    .text('📷 Фото шильдика')
    .text(MEDIA_BUTTON)
    .row()
    .text(ACTIVE_ORDERS_BUTTON)
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

function fmtBytes(bytes: number | null | undefined): string {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / (1024 * 1024)).toFixed(1)} МБ`;
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 16).replace('T', ' ');
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** «958», «#958», «заявка 958», «заявка №958» → 958. */
function parseOrderNumber(text: string): number | null {
  const match = /^(?:заявка\s*)?[№#]?\s*(\d{1,9})$/i.exec(text.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function equipmentLabel(details: OrderDetails): string {
  const label = [details.manufacturer, details.model]
    .map((v) => (v ?? '').trim())
    .filter(Boolean)
    .join(' ');
  return label || 'оборудование без названия';
}

function orderCardText(details: OrderDetails, mediaCount: number): string {
  const lines = [
    `🗂 Заявка #${details.order_id} · ${equipmentLabel(details)}`,
  ];
  if (details.serial_number) lines.push(`🔢 Серийный номер: ${details.serial_number}`);
  if (details.client_name) {
    const phone = details.client_number ? ` · ${details.client_number}` : '';
    lines.push(`👤 Клиент: ${details.client_name}${phone}`);
  }
  if (details.status) lines.push(`📌 Статус: ${details.status}`);
  if (details.creation_date) lines.push(`📅 Создана: ${fmtDay(details.creation_date)}`);
  lines.push(`📎 Медиафайлов: ${mediaCount}`);
  return lines.join('\n');
}

function orderMediaKeyboard(orderId: number, mediaCount: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(`🖼 Показать медиафайлы (${mediaCount})`, `mo:show:${orderId}:0`)
    .row()
    .text('⬆️ Загрузить медиафайлы', `mo:up:${orderId}`)
    .row()
    .text('✖ Отмена', 'mo:no');
}

function fmtDay(value: string | null | undefined): string {
  if (!value) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : value;
}

function truncateText(text: string, max: number): string {
  const s = text.trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Убираем легаси-строки «Фото шильдика: путь» из комментария заявки. */
function cleanComment(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^фото шильдика\s*:/i.test(line))
    .join('\n')
    .trim();
}

function activeOrderText(order: OrderDetails): string {
  const lines = [`🗂 Заявка #${order.order_id} · ${order.status?.trim() || 'без статуса'}`];
  lines.push(`📅 ${fmtDay(order.creation_date)}`);

  const client = (order.client_name ?? '').trim() || '—';
  const phone = (order.client_number ?? '').trim();
  lines.push(`👤 ${client}${phone ? ` · ${phone}` : ''}`);

  const serial = (order.serial_number ?? '').trim();
  lines.push(`🔧 ${equipmentLabel(order)}${serial ? ` · S/N ${serial}` : ''}`);

  const comment = truncateText(cleanComment(order.comments), 500);
  if (comment) lines.push(`💬 Комментарий: ${comment}`);

  const diagnostics = truncateText(order.diagnostic_results ?? '', 1000);
  if (diagnostics) lines.push(`🩺 Диагностика: ${diagnostics}`);

  const price = order.price == null ? '' : String(order.price).trim();
  if (price) lines.push(`💰 Цена: ${price}`);

  return lines.join('\n');
}

function activeOrderKeyboard(orderId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('🖼 Медиафайлы', `mo:show:${orderId}:0`)
    .text('🩺 Результат диагностики', `ao:diag:${orderId}`);
}

async function startActiveOrders(ctx: Context, chatId: number): Promise<void> {
  reset(chatId);
  const orders = listActiveOrders();
  if (orders.length === 0) {
    await ctx.reply('Актуальных заявок нет — все закрыты.', { reply_markup: menuKeyboard() });
    return;
  }
  await ctx.reply(`📋 Актуальные заявки: ${orders.length}`, { reply_markup: menuKeyboard() });
  for (let i = 0; i < orders.length; i += 1) {
    const order = orders[i];
    await ctx
      .reply(activeOrderText(order), { reply_markup: activeOrderKeyboard(order.order_id) })
      .catch((e) => logError('Ошибка отправки заявки', { orderId: order.order_id, error: String(e) }));
    if (i + 1 < orders.length) await sleep(120);
  }
  logInfo(`Показаны актуальные заявки chat_id=${chatId}`, { count: orders.length });
}

async function showOrPromptDiagnostics(ctx: Context, chatId: number, orderId: number): Promise<void> {
  const details = getOrderDetails(orderId);
  if (!details) {
    await ctx.reply(`Заявка #${orderId} не найдена — возможно, её удалили.`);
    return;
  }
  const diagnostics = (details.diagnostic_results ?? '').trim();
  if (diagnostics) {
    await ctx.reply(
      `🩺 Результат диагностики · заявка #${orderId}\n\n${truncateText(diagnostics, 3500)}`,
      { reply_markup: menuKeyboard() }
    );
    return;
  }
  sessions.set(chatId, { kind: 'diagnostics', step: 'await_text', orderId });
  await ctx.reply(
    `🩺 У заявки #${orderId} результат диагностики пока не заполнен.\n` +
      'Введите текст результата (или /cancel).',
    { reply_markup: menuKeyboard() }
  );
}

function mediaRoleLabel(role: string | null): string {
  const map: Record<string, string> = {
    nameplate: 'шильдик',
    media: 'медиа',
    photo: 'фото',
    video: 'видео',
  };
  return role ? map[role] ?? role : 'медиа';
}

/** Файл существует и лежит внутри разрешённых корней. */
function existingMediaPath(relPath: string): string | null {
  const abs = absoluteMediaPath(relPath);
  if (!isInsideAllowedRoots(abs) || !fs.existsSync(abs)) return null;
  return abs;
}

function tooBigNotice(size: number | null | undefined): string {
  return `⚠️ Файл ${fmtBytes(size)} — больше 20 МБ. Бот не может его скачать, загрузите через веб-консоль.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// ---------- Сценарий 2: медиафайлы заявки ----------

async function startMedia(ctx: Context, chatId: number): Promise<void> {
  sessions.set(chatId, { kind: 'media', step: 'await_order', count: 0 });
  await ctx.reply('🖼 Введите номер заявки (например, 958). /cancel — отмена.', {
    reply_markup: menuKeyboard(),
  });
}

async function handleOrderNumber(
  ctx: Context,
  chatId: number,
  session: MediaSession,
  text: string
): Promise<void> {
  const orderId = parseOrderNumber(text);
  if (orderId == null) {
    await ctx.reply('Не понял номер. Введите число, например 958 (или /cancel).');
    return;
  }
  const details = getOrderDetails(orderId);
  if (!details) {
    await ctx.reply(`Заявка #${orderId} не найдена. Проверьте номер (или /cancel).`);
    return;
  }
  const mediaCount = listOrderMedia(orderId).length;
  session.orderId = details.order_id;
  session.orderLabel = equipmentLabel(details);
  session.clientId = details.client_id;
  session.equipmentId = details.equipment_id;
  session.model = details.model;
  session.step = 'choose';
  await ctx.reply(`${orderCardText(details, mediaCount)}\n\nЧто сделать?`, {
    reply_markup: orderMediaKeyboard(details.order_id, mediaCount),
  });
}

async function startOrderUpload(ctx: Context, chatId: number, orderId: number): Promise<void> {
  const details = getOrderDetails(orderId);
  if (!details) {
    await ctx.reply(`Заявка #${orderId} не найдена — возможно, её удалили.`);
    reset(chatId);
    return;
  }
  sessions.set(chatId, {
    kind: 'media',
    step: 'collecting',
    orderId: details.order_id,
    orderLabel: equipmentLabel(details),
    clientId: details.client_id,
    equipmentId: details.equipment_id,
    model: details.model,
    count: 0,
  });
  await ctx.reply(
    `⬆️ Заявка #${details.order_id} · ${equipmentLabel(details)}\n` +
      'Присылайте фото или видео. /finish — закончить.',
    { reply_markup: menuKeyboard() }
  );
}

function uploadOnlyKeyboard(orderId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('⬆️ Загрузить медиафайлы', `mo:up:${orderId}`)
    .row()
    .text('✖ Отмена', 'mo:no');
}

function showPageKeyboard(orderId: number, page: number, totalPages: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (page > 0) kb.text('⬅️ Назад', `mo:show:${orderId}:${page - 1}`);
  if (page + 1 < totalPages) kb.text(`Показать ещё ${MEDIA_PAGE_SIZE}`, `mo:show:${orderId}:${page + 1}`);
  if (page > 0 || page + 1 < totalPages) kb.row();
  kb.text('⬆️ Загрузить медиафайлы', `mo:up:${orderId}`).row();
  kb.text('✖ Отмена', 'mo:no');
  return kb;
}

async function sendOrderMediaFile(
  ctx: Context,
  media: { file_path: string; mime_type: string | null; role: string | null; step_no: number | null; caption: string | null; created_at: string | null },
  index: number,
  total: number
): Promise<void> {
  const abs = existingMediaPath(media.file_path);
  if (!abs) {
    await ctx.reply(`⚠️ Файл ${index}/${total} не найден на диске.`).catch(() => {});
    return;
  }
  let size = 0;
  try {
    size = fs.statSync(abs).size;
  } catch {
    await ctx.reply(`⚠️ Файл ${index}/${total} недоступен.`).catch(() => {});
    return;
  }
  const mime = media.mime_type || guessMime(abs);
  const lines = [
    `#${media.step_no ?? index} · ${mediaRoleLabel(media.role)} · ${fmtDate(media.created_at)} · ${fmtBytes(size)}`,
  ];
  if (media.caption) lines.push(media.caption);
  lines.push(`Файл ${index} из ${total}`);
  const caption = lines.join('\n').slice(0, 1024);

  try {
    if (isVideoMime(mime)) {
      if (size > MAX_UPLOAD_BYTES) {
        await ctx.reply(
          `🎬 Видео ${index}/${total} (${fmtBytes(size)}) больше 50 МБ — Telegram не даст боту его отправить. Откройте в веб-консоли.`
        );
        return;
      }
      await ctx.replyWithVideo(new InputFile(abs), { caption, supports_streaming: true });
      return;
    }
    if (isImageMime(mime)) {
      if (size <= MAX_PHOTO_BYTES) {
        await ctx.replyWithPhoto(new InputFile(abs), { caption });
        return;
      }
      if (size <= MAX_UPLOAD_BYTES) {
        await ctx.replyWithDocument(new InputFile(abs), { caption });
        return;
      }
      await ctx.reply(
        `🖼 Файл ${index}/${total} (${fmtBytes(size)}) больше 50 МБ — откройте в веб-консоли.`
      );
      return;
    }
    if (size <= MAX_UPLOAD_BYTES) {
      await ctx.replyWithDocument(new InputFile(abs), { caption });
      return;
    }
    await ctx.reply(`📄 Файл ${index}/${total} (${fmtBytes(size)}) больше 50 МБ — откройте в веб-консоли.`);
  } catch (e) {
    logError(`Ошибка отправки медиа ${media.file_path}`, { error: String(e) });
    await ctx.reply(`⚠️ Не удалось отправить файл ${index}/${total}.`).catch(() => {});
  }
}

async function showOrderMedia(
  ctx: Context,
  chatId: number,
  orderId: number,
  page: number
): Promise<void> {
  const details = getOrderDetails(orderId);
  if (!details) {
    await ctx.reply(`Заявка #${orderId} не найдена — возможно, её удалили.`);
    return;
  }
  const rows = listOrderMedia(orderId);
  if (rows.length === 0) {
    await ctx.reply(
      `${orderCardText(details, 0)}\n\nУ этой заявки пока нет медиафайлов.`,
      { reply_markup: uploadOnlyKeyboard(orderId) }
    );
    return;
  }
  const available = rows.filter((row) => existingMediaPath(row.file_path) !== null);
  const missing = rows.length - available.length;
  if (available.length === 0) {
    await ctx.reply(
      `${orderCardText(details, rows.length)}\n\n⚠️ Записи есть, но файлы не найдены на диске (${missing}).`,
      { reply_markup: uploadOnlyKeyboard(orderId) }
    );
    return;
  }
  const totalPages = Math.ceil(available.length / MEDIA_PAGE_SIZE);
  const current = Math.min(Math.max(0, Math.floor(page)), totalPages - 1);
  const slice = available.slice(current * MEDIA_PAGE_SIZE, (current + 1) * MEDIA_PAGE_SIZE);
  const from = current * MEDIA_PAGE_SIZE + 1;
  const to = from + slice.length - 1;

  const header = [
    orderCardText(details, rows.length),
    `\nПоказываю файлы ${from}–${to} из ${available.length}.`,
  ];
  if (missing > 0) header.push(`⚠️ Недоступно на диске: ${missing}.`);

  await ctx.reply(header.join('\n'), {
    reply_markup: showPageKeyboard(orderId, current, totalPages),
  });
  for (let i = 0; i < slice.length; i += 1) {
    await sendOrderMediaFile(ctx, slice[i], from + i, available.length);
    if (i + 1 < slice.length) await sleep(150);
  }
  logInfo(`Показаны медиа заявки chat_id=${chatId}`, {
    orderId,
    page: current + 1,
    totalPages,
    sent: slice.length,
  });
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

async function collectOrderMedia(
  ctx: Context,
  chatId: number,
  session: MediaSession,
  media: CollectedMedia
): Promise<void> {
  if (session.orderId == null) {
    await ctx.reply('Сначала укажите номер заявки.');
    return;
  }
  const details = getOrderDetails(session.orderId);
  if (!details) {
    reset(chatId);
    await ctx.reply(`Заявка #${session.orderId} больше не существует. Начните заново.`, {
      reply_markup: menuKeyboard(),
    });
    return;
  }
  try {
    saveBotMedia({
      buffer: media.buffer,
      mime: media.mime,
      originalName: media.originalName,
      thumbBuffer: media.thumbBuffer,
      orderId: details.order_id,
      equipmentId: details.equipment_id,
      clientId: details.client_id,
      model: details.model,
      role: 'media',
      caption: media.caption ?? null,
      width: media.width ?? null,
      height: media.height ?? null,
      duration: media.duration ?? null,
    });
    session.count += 1;
    session.equipmentId = details.equipment_id;
    session.clientId = details.client_id;
    session.model = details.model;
    const total = listOrderMedia(details.order_id).length;
    await ctx.reply(
      `✅ Заявка #${details.order_id}: файл ${session.count} сохранён (${fmtBytes(media.buffer.length)}).` +
        `\nВсего у заявки: ${total}. Ещё? /finish — закончить.`
    );
  } catch (e) {
    logError(`Ошибка сохранения медиа chat_id=${chatId}`, { error: String(e) });
    await ctx.reply('⚠️ Не удалось сохранить файл. Попробуйте ещё раз.');
  }
}

// ---------- Обработчики сообщений ----------

async function onPhoto(
  ctx: Context,
  chatId: number,
  photos: { file_id: string; file_unique_id: string; file_size?: number }[]
): Promise<void> {
  const session = sessions.get(chatId);
  if (!session) {
    await ctx.reply('Выберите действие кнопкой внизу.', { reply_markup: menuKeyboard() });
    return;
  }
  if (session.kind === 'diagnostics') {
    await ctx.reply('Введите результат диагностики текстом (или /cancel).');
    return;
  }
  if (session.kind === 'media') {
    if (session.step === 'await_order') {
      await ctx.reply('Сначала введите номер заявки (например, 958). /cancel — отмена.');
      return;
    }
    if (session.step === 'choose') {
      await ctx.reply('Выберите «⬆️ Загрузить медиафайлы» кнопкой выше.', {
        reply_markup: menuKeyboard(),
      });
      return;
    }
    const largest = photos[photos.length - 1];
    const smallest = photos[0];
    if ((largest.file_size ?? 0) > MAX_DOWNLOAD_BYTES) {
      await ctx.reply(tooBigNotice(largest.file_size));
      return;
    }
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
      await collectOrderMedia(ctx, chatId, session, {
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
    file_size?: number;
    width?: number;
    height?: number;
    duration?: number;
    thumbnail?: { file_id: string };
  }
): Promise<void> {
  const session = sessions.get(chatId);
  if (session?.kind === 'diagnostics') {
    await ctx.reply('Введите результат диагностики текстом (или /cancel).');
    return;
  }
  if (!session || session.kind !== 'media' || session.step !== 'collecting') {
    await ctx.reply('Видео можно приложить по кнопке «🖼 Медиафайлы заявки».', {
      reply_markup: menuKeyboard(),
    });
    return;
  }
  if ((video.file_size ?? 0) > MAX_DOWNLOAD_BYTES) {
    await ctx.reply(tooBigNotice(video.file_size));
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
    await collectOrderMedia(ctx, chatId, session, {
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

async function onImageDocument(
  ctx: Context,
  chatId: number,
  doc: {
    file_id: string;
    mime_type?: string;
    file_name?: string;
    file_size?: number;
    thumbnail?: { file_id: string };
  }
): Promise<void> {
  const session = sessions.get(chatId);
  if (session?.kind === 'diagnostics') {
    await ctx.reply('Введите результат диагностики текстом (или /cancel).');
    return;
  }
  if (!session || session.kind !== 'media' || session.step !== 'collecting') {
    await ctx.reply('Фото пришлите как изображение или откройте «🖼 Медиафайлы заявки».', {
      reply_markup: menuKeyboard(),
    });
    return;
  }
  if ((doc.file_size ?? 0) > MAX_DOWNLOAD_BYTES) {
    await ctx.reply(tooBigNotice(doc.file_size));
    return;
  }
  try {
    const buffer = await fetchTelegramFile(ctx, doc.file_id);
    let thumbBuffer: Buffer | null = null;
    if (doc.thumbnail) {
      try {
        thumbBuffer = await fetchTelegramFile(ctx, doc.thumbnail.file_id);
      } catch {
        thumbBuffer = null;
      }
    }
    await collectOrderMedia(ctx, chatId, session, {
      buffer,
      mime: doc.mime_type || 'image/jpeg',
      thumbBuffer,
      originalName: doc.file_name,
      caption: ctx.message?.caption ?? null,
    });
  } catch (e) {
    logError(`Ошибка скачивания фото-документа chat_id=${chatId}`, { error: String(e) });
    await ctx.reply('⚠️ Не удалось получить файл из Telegram. Отправьте ещё раз.');
  }
}

async function onText(ctx: Context, chatId: number, text: string): Promise<void> {
  const session = sessions.get(chatId);
  if (!session) {
    await ctx.reply('Выберите действие кнопкой внизу.', { reply_markup: menuKeyboard() });
    return;
  }
  if (session.kind === 'media') {
    if (session.step === 'await_order') {
      await handleOrderNumber(ctx, chatId, session, text);
      return;
    }
    if (session.step === 'choose') {
      if (parseOrderNumber(text) != null) {
        await handleOrderNumber(ctx, chatId, session, text);
        return;
      }
      await ctx.reply('Выберите действие кнопкой: «🖼 Показать медиафайлы» или «⬆️ Загрузить медиафайлы».');
      return;
    }
    await ctx.reply('Пришлите фото или видео, либо /finish — закончить.');
    return;
  }
  if (session.kind === 'diagnostics') {
    const diagnostics = text.trim();
    if (!diagnostics) {
      await ctx.reply('Введите результат диагностики текстом (или /cancel).');
      return;
    }
    const orderId = session.orderId;
    const saved = updateOrderDiagnostics(orderId, diagnostics);
    reset(chatId);
    if (!saved) {
      await ctx.reply(`Заявка #${orderId} не найдена — результат не сохранён.`, {
        reply_markup: menuKeyboard(),
      });
      return;
    }
    await ctx.reply(
      `✅ Результат диагностики сохранён в заявку #${orderId}.\n\n🩺 ${truncateText(diagnostics, 3500)}`,
      { reply_markup: menuKeyboard() }
    );
    logInfo(`Результат диагностики сохранён chat_id=${chatId}`, { orderId });
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
      'Привет! Выберите действие кнопкой внизу.\n\n📷 Фото шильдика — распознать и создать заявку.\n🖼 Медиафайлы заявки — посмотреть или загрузить фото/видео по номеру заявки.\n📋 Актуальные заявки — все незакрытые заявки с контактами и диагностикой.',
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
    if (session && session.kind === 'media' && session.step === 'collecting') {
      const info =
        session.count > 0
          ? `В заявку #${session.orderId} сохранено файлов: ${session.count}.`
          : 'Файлы не отправлялись.';
      reset(chatId);
      await ctx.reply(`✅ Готово. ${info}`, { reply_markup: menuKeyboard() });
    } else {
      await ctx.reply('Нет активной загрузки медиафайлов.', { reply_markup: menuKeyboard() });
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

  // --- Медиафайлы заявки ---
  bot.callbackQuery(/^mo:show:(\d+):(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!isAllowed(chatId)) return deny(ctx);
    const orderId = Number(ctx.match[1]);
    const page = Number(ctx.match[2]);
    await ctx.answerCallbackQuery();
    reset(chatId);
    try {
      await showOrderMedia(ctx, chatId, orderId, page);
    } catch (e) {
      logError(`Ошибка показа медиа заявки chat_id=${chatId}`, { orderId, error: String(e) });
      await ctx.reply('⚠️ Не удалось показать медиафайлы. Попробуйте ещё раз.');
    }
  });

  bot.callbackQuery(/^mo:up:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!isAllowed(chatId)) return deny(ctx);
    const orderId = Number(ctx.match[1]);
    await ctx.answerCallbackQuery();
    await startOrderUpload(ctx, chatId, orderId);
  });

  bot.callbackQuery('mo:no', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!isAllowed(chatId)) return deny(ctx);
    reset(chatId);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('✖ Отменено. Выберите действие кнопкой внизу.').catch(() => {});
    await ctx.reply('Готово.', { reply_markup: menuKeyboard() });
  });

  // --- Результат диагностики из списка актуальных заявок ---
  bot.callbackQuery(/^ao:diag:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!isAllowed(chatId)) return deny(ctx);
    const orderId = Number(ctx.match[1]);
    await ctx.answerCallbackQuery();
    reset(chatId);
    try {
      await showOrPromptDiagnostics(ctx, chatId, orderId);
    } catch (e) {
      logError(`Ошибка диагностики chat_id=${chatId}`, { orderId, error: String(e) });
      await ctx.reply('⚠️ Не удалось получить результат диагностики. Попробуйте ещё раз.');
    }
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
      if (text === MEDIA_BUTTON || text === MEDIA_BUTTON_LEGACY) return startMedia(ctx, chatId);
      if (text === ACTIVE_ORDERS_BUTTON) return startActiveOrders(ctx, chatId);
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
        file_size: msg.document.file_size,
        thumbnail: msg.document.thumbnail,
      });
    }
    if (msg.document && (msg.document.mime_type ?? '').startsWith('image/')) {
      return onImageDocument(ctx, chatId, {
        file_id: msg.document.file_id,
        mime_type: msg.document.mime_type,
        file_name: msg.document.file_name,
        file_size: msg.document.file_size,
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
