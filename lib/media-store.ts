import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Файловое хранилище медиа. В базе данных лежат только метаданные и путь,
 * а сами байты — на диске. Это keeps БД лёгкой и позволяет грузить файлы
 * по одному, только когда к ним реально обратились.
 */

const PROJECT_ROOT = process.cwd();

function resolveEnvDir(key: string, fallback: string): string {
  const raw = (process.env[key] ?? '').trim();
  return path.resolve(PROJECT_ROOT, raw || fallback);
}

/** Корень для новых медиафайлов (env MEDIA_DIR). */
export function mediaRoot(): string {
  return resolveEnvDir('MEDIA_DIR', 'bot/storage/media');
}

/** Корни, из которых разрешено читать файлы (новые медиа + старые фото бота). */
export function allowedRoots(): string[] {
  return [mediaRoot(), resolveEnvDir('PHOTO_DIR', 'bot/storage/photos')];
}

export function isInsideAllowedRoots(absPath: string): boolean {
  const resolved = path.resolve(absPath);
  return allowedRoots().some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
}

/** Относительный путь из БД → абсолютный. */
export function absoluteMediaPath(relPath: string): string {
  return path.isAbsolute(relPath) ? relPath : path.resolve(PROJECT_ROOT, relPath);
}

export function toProjectRelative(absPath: string): string {
  return path.relative(PROJECT_ROOT, absPath);
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/3gpp': '3gp',
};

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  '3gp': 'video/3gpp',
};

export function extensionFor(mime: string | undefined, originalName?: string): string {
  const m = (mime ?? '').toLowerCase();
  if (EXT_BY_MIME[m]) return EXT_BY_MIME[m];
  const fromName = originalName ? path.extname(originalName).replace(/^\./, '').toLowerCase() : '';
  if (fromName && /^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  if (m.startsWith('video/')) return 'mp4';
  return 'jpg';
}

export function guessMime(absPath: string): string {
  const ext = path.extname(absPath).replace(/^\./, '').toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export function isVideoMime(mime: string | undefined): boolean {
  return (mime ?? '').toLowerCase().startsWith('video/');
}

export function isImageMime(mime: string | undefined): boolean {
  return (mime ?? '').toLowerCase().startsWith('image/');
}

/** Безопасный сегмент пути (латиница/кириллица/цифры/_/-). */
export function safeSegment(value: string): string {
  const s = (value ?? '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return s || 'misc';
}

/** Папка для «пачки по модели» из бота. */
export function slugModel(model: string): string {
  return safeSegment(model).toLowerCase();
}

export function newMediaFileName(mime: string | undefined, originalName?: string): string {
  return `${crypto.randomUUID()}.${extensionFor(mime, originalName)}`;
}

/** Сохранить файл в MEDIA_DIR/<dirParts...>/<fileName>. Возвращает rel и abs. */
export function writeMediaFile(
  dirParts: string[],
  fileName: string,
  data: Uint8Array
): { rel: string; abs: string } {
  const dir = path.join(mediaRoot(), ...dirParts.map(safeSegment));
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, fileName);
  fs.writeFileSync(abs, data);
  return { rel: toProjectRelative(abs), abs };
}

export function unlinkMediaFile(relPath?: string | null): void {
  if (!relPath) return;
  try {
    const abs = absoluteMediaPath(relPath);
    if (isInsideAllowedRoots(abs) && fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch {
    /* ignore */
  }
}
