import { DatabaseSync } from 'node:sqlite';
import { absDbPath } from './path';
import { getActiveEntry } from './registry';

const pools = new Map<string, DatabaseSync>();

function openDb(absPath: string, readOnly: boolean): DatabaseSync {
  const key = `${absPath}|${readOnly ? 'ro' : 'rw'}`;
  let handle = pools.get(key);
  if (!handle) {
    handle = new DatabaseSync(absPath, { readOnly });
    try {
      handle.prepare('PRAGMA busy_timeout = 5000').get();
    } catch {
      /* ignore */
    }
    pools.set(key, handle);
  }
  return handle;
}

export function getDb(): DatabaseSync {
  return openDb(absDbPath(getActiveEntry()), true);
}

export function getWriteDb(): DatabaseSync {
  const handle = openDb(absDbPath(getActiveEntry()), false);
  handle.prepare('PRAGMA foreign_keys = ON').get();
  try {
    handle.prepare('PRAGMA journal_mode = WAL').get();
  } catch {
    /* ignore */
  }
  return handle;
}
