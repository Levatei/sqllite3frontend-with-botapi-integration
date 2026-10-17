import { NextResponse } from 'next/server';
import {
  ensureMediaTable,
  getActiveEntry,
  getColumns,
  getCount,
  getDb,
  getDbLabel,
  getFkChildColumns,
  getTableNames,
  isCompatibleDb,
  isHiddenTable,
} from '@/lib/db';
import { logError, withLogging } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging('GET', '/api/tables', async () => {
  try {
    const database = getDb();
    const compatible = isCompatibleDb(database);
    // Таблицу медиа создаём только для стандартной схемы и не показываем в списке.
    if (compatible) {
      try {
        ensureMediaTable();
      } catch {
        /* ignore */
      }
    }
    const names = getTableNames(database).filter((n) => !isHiddenTable(n));
    const tables = names.map((name) => {
      const fk = new Set(getFkChildColumns(name, database));
      return {
        name,
        count: getCount(name),
        columns: getColumns(name).map((c) => ({ ...c, fk: fk.has(c.name) })),
      };
    });
    const entry = getActiveEntry();
    return NextResponse.json({
      ok: true,
      db: getDbLabel(),
      dbId: entry.id,
      compatible,
      tables,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DB error';
    logError(`GET /api/tables — ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
});
