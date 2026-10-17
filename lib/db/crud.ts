import { DatabaseSync } from 'node:sqlite';
import { getWriteDb, getDb } from './connection';
import {
  fkParentProblem,
  getTableNames,
  getColumns,
  tableExists,
  ID_LIKE,
  getFkChildColumns,
} from './schema';

const knownColumns = (table: string, database: DatabaseSync): Set<string> =>
  new Set(getColumns(table).map((c) => c.name));

const getPkColumn = (table: string, database: DatabaseSync): string | null => {
  const pks = getColumns(table).filter((c) => c.pk > 0);
  if (pks.length === 1) return pks[0].name;
  return null;
};

function nextIdNumber(table: string, column: string, database: DatabaseSync): number {
  try {
    const m = database
      .prepare(`SELECT COALESCE(MAX("${column}"), 0) AS m FROM "${table}"`)
      .get() as unknown as { m: number };
    return (Number(m.m) || 0) + 1;
  } catch {
    return 1;
  }
}

function clean(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

export interface GenericInsertResult {
  row: Record<string, unknown>;
}

export function genericInsert(
  table: string,
  data: Record<string, unknown>,
  database: DatabaseSync = getWriteDb()
): Record<string, unknown> {
  if (!tableExists(table, database)) throw new Error(`Таблица «${table}» не найдена.`);
  const fkProblem = fkParentProblem(table, database);
  if (fkProblem) throw new Error(fkProblem);
  const cols = getColumns(table);
  const known = knownColumns(table, database);
  const pk = getPkColumn(table, database);
  const pkCol = pk ? cols.find((c) => c.name === pk) : undefined;
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (!known.has(k) || k === '_rowid') continue;
    payload[k] = v;
  }
  if (pkCol && (payload[pkCol.name] === undefined || String(payload[pkCol.name]).trim() === '')) {
    const t = (pkCol.type || 'TEXT').toUpperCase();
    const singlePk = cols.filter((c) => c.pk > 0).length === 1;
    if (singlePk && t.includes('TEXT')) {
      payload[pkCol.name] = crypto.randomUUID();
    } else if (singlePk && t.includes('INT')) {
      delete payload[pkCol.name];
    } else {
      throw new Error(`Поле «${pkCol.name}» обязательно для заполнения.`);
    }
  }
  const fkChildren = new Set(getFkChildColumns(table, database));
  for (const c of cols) {
    const raw = payload[c.name];
    if (raw !== undefined && String(raw).trim() !== '') continue;
    const t = (c.type || '').toUpperCase();
    if (t.includes('INT') && ID_LIKE.test(c.name) && !fkChildren.has(c.name)) {
      payload[c.name] = nextIdNumber(table, c.name, database);
    }
  }
  for (const c of cols) {
    const v = payload[c.name];
    if (c.notnull && !c.dflt_value && (v === undefined || String(v).trim() === '')) {
      throw new Error(`Поле «${c.name}» обязательно для заполнения.`);
    }
  }
  const names = Object.keys(payload);
  if (names.length === 0) throw new Error('Нет данных для вставки.');
  const cleaned = names.map((n) => {
    const v = payload[n];
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
  });
  database
    .prepare(
      `INSERT INTO "${table}"(${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
    )
    .get(...cleaned);
  const lastId = (database.prepare('SELECT last_insert_rowid() AS id').get() as unknown as { id: number }).id;
  return database.prepare(`SELECT * FROM "${table}" WHERE rowid = ?`).get(lastId) as unknown as Record<string, unknown>;
}

export function genericUpdate(
  table: string,
  rowid: number,
  data: Record<string, unknown>,
  database: DatabaseSync = getWriteDb()
): Record<string, unknown> {
  if (!tableExists(table, database)) throw new Error(`Таблица «${table}» не найдена.`);
  const known = knownColumns(table, database);
  const pk = getPkColumn(table, database);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(data ?? {})) {
    if (!known.has(k) || k === '_rowid' || k === pk) continue;
    const s = v === undefined || v === null ? null : String(v).trim();
    sets.push(`"${k}" = ?`);
    params.push(s === '' ? null : s);
  }
  if (sets.length === 0) throw new Error('Нет полей для обновления.');
  const exists = database.prepare(`SELECT 1 FROM "${table}" WHERE rowid = ?`).get(rowid);
  if (!exists) throw new Error('Запись не найдена.');
  database.prepare(`UPDATE "${table}" SET ${sets.join(', ')} WHERE rowid = ?`).get(...params, rowid);
  return database.prepare(`SELECT * FROM "${table}" WHERE rowid = ?`).get(rowid) as unknown as Record<string, unknown>;
}

export function genericDelete(
  table: string,
  rowid: number,
  database: DatabaseSync = getWriteDb()
): void {
  if (!tableExists(table, database)) throw new Error(`Таблица «${table}» не найдена.`);
  const exists = database.prepare(`SELECT 1 FROM "${table}" WHERE rowid = ?`).get(rowid);
  if (!exists) throw new Error('Запись не найдена.');
  database.prepare(`DELETE FROM "${table}" WHERE rowid = ?`).get(rowid);
}

// re-exported from schema.ts
