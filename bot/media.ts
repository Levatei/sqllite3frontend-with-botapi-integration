import { insertMedia, type MediaRecord } from '../lib/db';
import { newMediaFileName, slugModel, writeMediaFile } from '../lib/media-store';

export interface SaveBotMediaInput {
  buffer: Uint8Array;
  mime: string;
  originalName?: string;
  thumbBuffer?: Uint8Array | null;
  /** Модель (для «пачки» по кнопке). */
  model?: string | null;
  batchId?: string | null;
  orderId?: number | null;
  equipmentId?: number | null;
  clientId?: number | null;
  role?: string;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

/**
 * Сохраняет медиа из бота: файлы на диск, строка в таблицу media.
 * Привязка либо к заявке (orderId), либо к «пачке по модели» (batchId + model).
 */
export function saveBotMedia(input: SaveBotMediaInput): MediaRecord {
  const isVideo = input.mime.toLowerCase().startsWith('video/');

  let dirParts: string[];
  if (input.orderId != null) {
    dirParts = [
      String(input.clientId ?? 'na'),
      String(input.equipmentId ?? 'na'),
      String(input.orderId),
    ];
  } else {
    dirParts = ['models', slugModel(input.model ?? 'unknown'), input.batchId ?? 'misc'];
  }

  const fileName = newMediaFileName(input.mime, input.originalName);
  const saved = writeMediaFile(dirParts, fileName, input.buffer);

  let thumbRel: string | null = null;
  if (input.thumbBuffer && input.thumbBuffer.length > 0) {
    const thumbName = fileName.replace(/\.[^.]+$/, '') + '.thumb.jpg';
    thumbRel = writeMediaFile(dirParts, thumbName, input.thumbBuffer).rel;
  }

  return insertMedia({
    batch_id: input.batchId ?? null,
    model: input.model ?? null,
    order_id: input.orderId ?? null,
    equipment_id: input.equipmentId ?? null,
    kind: isVideo ? 'video' : 'photo',
    role: input.role ?? 'media',
    file_path: saved.rel,
    thumb_path: thumbRel,
    mime_type: input.mime,
    size_bytes: input.buffer.length,
    width: input.width ?? null,
    height: input.height ?? null,
    duration_sec: input.duration ?? null,
    caption: input.caption ?? null,
    source: 'bot',
  });
}
