import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const BOT_LOG = path.join(LOG_DIR, 'bot.log');
const BOT_ERROR_LOG = path.join(LOG_DIR, 'bot.error.log');

function ensureDir(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function append(file: string, line: string): void {
  ensureDir();
  try {
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch {
    /* не даём логированию сломать бота */
  }
}

function format(level: string, message: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  return `[${ts}] ${level.toUpperCase()} ${message}${
    meta !== undefined ? ' ' + safeJson(meta) : ''
  }`;
}

export function logInfo(message: string, meta?: unknown): void {
  const line = format('info', message, meta);
  // eslint-disable-next-line no-console
  console.log(line);
  append(BOT_LOG, line);
}

export function logWarn(message: string, meta?: unknown): void {
  const line = format('warn', message, meta);
  // eslint-disable-next-line no-console
  console.warn(line);
  append(BOT_LOG, line);
}

export function logError(message: string, meta?: unknown): void {
  const line = format('error', message, meta);
  // eslint-disable-next-line no-console
  console.error(line);
  append(BOT_LOG, line);
  append(BOT_ERROR_LOG, line);
}
