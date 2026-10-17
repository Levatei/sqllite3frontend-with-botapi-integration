import fs from 'node:fs';
import { config } from './config';
import { logWarn } from './logger';

interface WhitelistEntry {
  chat_id: number | string;
  name?: string;
}

interface WhitelistFile {
  allowed?: WhitelistEntry[];
  on_unknown?: string;
}

let cache: Set<number> | null = null;
let cacheMtime = -1;

/**
 * Читает whitelist.json с кэшем по времени изменения файла,
 * поэтому список можно править на ходу без перезапуска бота.
 */
function load(): Set<number> {
  let mtime = -2;
  try {
    mtime = fs.statSync(config.whitelistFile).mtimeMs;
  } catch {
    return cache ?? new Set<number>();
  }
  if (cache && mtime === cacheMtime) return cache;

  try {
    const raw = JSON.parse(fs.readFileSync(config.whitelistFile, 'utf8')) as WhitelistFile;
    const set = new Set<number>();
    for (const entry of raw.allowed ?? []) {
      const id = Number(entry.chat_id);
      if (Number.isFinite(id)) set.add(id);
    }
    cache = set;
    cacheMtime = mtime;
    return set;
  } catch (e) {
    logWarn('Не удалось прочитать whitelist.json', { error: String(e) });
    return cache ?? new Set<number>();
  }
}

export function isAllowed(chatId: number): boolean {
  return load().has(chatId);
}

export function allowedIds(): number[] {
  return Array.from(load());
}
