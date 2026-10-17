import type { Nameplate } from './vision';

export const DENY_TEXT = 'Доступ запрещён. Обратитесь к администратору.';

export const HELP_TEXT = [
  'Я читаю данные с шильдиков оборудования и завожу их в базу.',
  '',
  'Как пользоваться (кнопки внизу):',
  '📷 Фото шильдика — пришлите фото, проверьте поля, выберите клиента, подтвердите.',
  '   Каждое фото шильдика создаёт отдельную заявку.',
  '',
  '📎 Сохранить фотографию — пришлите модель насоса, затем пачку фото и видео.',
  '   Файлы сохранятся в разделе «Медиафайлы». /finish — закончить.',
  '',
  'Команды:',
  '/start — начать',
  '/finish — закончить прикрепление медиафайлов',
  '/whoami — узнать свой chat_id',
  '/cancel — отменить текущий диалог',
].join('\n');

const FIELD_LABELS: Array<[keyof Nameplate, string]> = [
  ['manufacturer', 'Производитель'],
  ['model', 'Модель'],
  ['serial_number', 'Серийный номер'],
  ['production_date', 'Дата изготовления'],
  ['article_number', 'Артикул'],
];

export function fmtNameplate(n: Nameplate): string {
  const lines = ['📋 Шильдик:', ''];
  for (const [key, label] of FIELD_LABELS) {
    lines.push(`• ${label}: ${n[key] ?? '—'}`);
  }
  return lines.join('\n');
}

export function hasAnyField(n: Nameplate): boolean {
  return Object.values(n).some((v) => v !== null && v !== '');
}
