import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';

const LOG_DIR = path.join(process.cwd(), 'logs');
const APP_LOG = path.join(LOG_DIR, 'app.log');
const ERROR_LOG = path.join(LOG_DIR, 'error.log');

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

function format(level: string, message: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  return `[${ts}] ${level.toUpperCase()} ${message}${
    meta !== undefined ? ' ' + safeJson(meta) : ''
  }`;
}

function append(file: string, line: string): void {
  ensureDir();
  try {
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch {
    /* never let logging break the request */
  }
}

export function logInfo(message: string, meta?: unknown): void {
  const line = format('info', message, meta);
  // eslint-disable-next-line no-console
  console.log(line);
  append(APP_LOG, line);
}

export function logWarn(message: string, meta?: unknown): void {
  const line = format('warn', message, meta);
  // eslint-disable-next-line no-console
  console.warn(line);
  append(APP_LOG, line);
}

export function logError(message: string, meta?: unknown): void {
  const line = format('error', message, meta);
  // eslint-disable-next-line no-console
  console.error(line);
  append(APP_LOG, line);
  append(ERROR_LOG, line);
}

export function logRequest(
  method: string,
  pathName: string,
  status: number,
  startedAt: number,
  meta?: unknown
): void {
  const ms = Date.now() - startedAt;
  const line = `${method} ${pathName} → ${status} (${ms}ms)`;
  if (status >= 500) logError(line, meta);
  else if (status >= 400) logWarn(line, meta);
  else logInfo(line);
}

/**
 * Оборачивает обработчик API-маршрута: пишет в лог статус ответа и время,
 * а необработанные исключения логирует и превращает в 500 JSON.
 */
export function withLogging<Req extends Request>(
  method: string,
  pathName: string,
  handler: (req: Req) => Promise<Response>
): (req: Req) => Promise<Response> {
  return async (req: Req): Promise<Response> => {
    const startedAt = Date.now();
    try {
      const res = await handler(req);
      logRequest(method, pathName, res.status, startedAt);
      return res;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logError(`${method} ${pathName} — необработанная ошибка: ${message}`, {
        stack: e instanceof Error ? e.stack : undefined,
      });
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
  };
}
