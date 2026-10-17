import { DatabaseSync } from 'node:sqlite';
import { getActiveEntry } from './registry';
import { absDbPath } from './path';
import { getDb, getWriteDb } from './connection';

export interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
  fk?: boolean;
}

export interface DbEntry {
  id: string;
  name: string;
  path: string;
}

export interface OverviewRow {
  order_id: number | null;
  client_id: number | null;
  client_name: string | null;
  client_number: string | null;
  client_mail: string | null;
  client_comments: string | null;
  equipment_id: number | null;
  equipment_manufacturer: string | null;
  equipment_model: string | null;
  equipment_serial_number: string | null;
  equipment_production_date: string | null;
  equipment_article_number: string | null;
  order_creation_date: string | null;
  order_shipping_date: string | null;
  order_status: string | null;
  order_comments: string | null;
  order_diagnostic_results: string | null;
  order_price: number | null;
}

export function getDbPath(): string {
  const entry = getActiveEntry();
  return absDbPath(entry);
}

export function getDbLabel(): string {
  return getActiveEntry().name;
}

export function getTableNames(database: DatabaseSync): string[] {
  const rows = database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    )
    .all() as unknown as { name: string }[];
  return rows.map((r) => r.name);
}

export function tableExists(table: string, database: DatabaseSync = getDb()): boolean {
  return getTableNames(database).includes(table);
}

export function getColumns(table: string): ColumnInfo[] {
  const database = getWriteDb();
  return database.prepare(`PRAGMA table_info("${table}")`).all() as unknown as ColumnInfo[];
}

export function getFkChildColumns(table: string, database: DatabaseSync): string[] {
  try {
    const rows = database.prepare(`PRAGMA foreign_key_list("${table}")`).all() as unknown as {
      from: string;
    }[];
    return rows.map((r) => r.from);
  } catch {
    return [];
  }
}

export const ID_LIKE = /^id$|^id_|_id$/i;

export const SAFE_NAME = /^[\p{L}_][\p{L}\p{N}_-]*$/u;

export const ALLOWED_TYPES = ['TEXT', 'INTEGER', 'REAL', 'NUMERIC', 'DATE'];

export const ALLOWED_FK_ACTIONS = ['CASCADE', 'RESTRICT', 'SET NULL', 'NO ACTION', 'SET DEFAULT'];

export function checkIdent(name: string, what: string): void {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`${what} «${name}»: только буквы, цифры, _ и -, начинается с буквы или _.`);
  }
}

export function fkParentProblem(table: string, database: DatabaseSync): string | null {
  const fks = database.prepare(`PRAGMA foreign_key_list("${table}")`).all() as unknown as {
    table: string;
    from: string;
    to: string;
  }[];
  for (const fk of fks) {
    let parentCols: { name: string; pk: number }[] = [];
    try {
      parentCols = database.prepare(`PRAGMA table_info("${fk.table}")`).all() as unknown as {
        name: string;
        pk: number;
      }[];
    } catch {
      return `Связь «${table}.${fk.from} → ${fk.table}.${fk.to}»: таблица «${fk.table}» не найдена.`;
    }
    const parent = parentCols.find((c) => c.name === fk.to);
    if (!parent) {
      return `Связь «${table}.${fk.from} → ${fk.table}.${fk.to}»: в таблице «${fk.table}» нет поля «${fk.to}».`;
    }
    if (!(parent.pk > 0)) {
      return `Связь «${table}.${fk.from} → ${fk.table}.${fk.to}» не сработает: в таблице «${fk.table}» поле «${fk.to}» должно быть PRIMARY KEY (иначе SQLite запрещает любую вставку).`;
    }
  }
  return null;
}

export function isCompatibleDb(database: DatabaseSync = getDb()): boolean {
  try {
    const names = getTableNames(database);
    for (const t of ['clients', 'equipment', 'orders']) {
      if (!names.includes(t)) return false;
      const have = new Set(getColumns(t).map((c) => c.name));
      const required: Record<string, string[]> = {
        clients: ['client_id', 'name'],
        equipment: ['equipment_id', 'client_id'],
        orders: ['order_id', 'client_id', 'equipment_id'],
      };
      for (const c of required[t]) if (!have.has(c)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------- Overview ----------

export interface ListOverviewOptions {
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  filters?: FilterCond[];
}

export type FilterOp = 'contains' | 'equals' | 'empty' | 'notEmpty';

export interface FilterCond {
  field: string;
  op: FilterOp;
  value?: string;
}

const searchCols = [
  'c.name', 'c.mail', 'c.comments', 'c.number',
  'e.manufacturer', 'e.model', 'e.serial_number', 'e.article_number', 'e.production_date',
  'o.status', 'o.comments', 'o.diagnostic_results', 'o.creation_date', 'o.shipping_date', 'o.price',
];

export function listOverview(opts: ListOverviewOptions = {}): {
  rows: Record<string, unknown>[];
  total: number;
} {
  const database = getWriteDb();
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 50)));
  const offset = (page - 1) * pageSize;
  const search = (opts.search ?? '').trim();

  const params: unknown[] = [];
  const conds: string[] = [];
  if (search) {
    const like = `%${search}%`;
    conds.push(`(${searchCols.map((c) => `${c} LIKE ?`).join(' OR ')})`);
    searchCols.forEach(() => params.push(like));
  }
  const allowed = new Map<string, string>([
    ['client_name', 'c.name'],
    ['client_mail', 'c.mail'],
    ['manufacturer', 'e.manufacturer'],
    ['model', 'e.model'],
    ['serial_number', 'e.serial_number'],
    ['article_number', 'e.article_number'],
    ['production_date', 'e.production_date'],
    ['creation_date', 'o.creation_date'],
    ['shipping_date', 'o.shipping_date'],
    ['status', 'o.status'],
    ['diagnostic_results', 'o.diagnostic_results'],
    ['comments', 'o.comments'],
    ['price', 'o.price'],
  ]);
  const f = buildFilterClause(opts.filters, allowed);
  if (f.clause) {
    conds.push(`(${f.clause})`);
    params.push(...f.params);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const sortExpr = opts.sort ? allowed.get(opts.sort) : undefined;
  const order =
    sortExpr != null
      ? `ORDER BY (${sortExpr} IS NULL OR ${sortExpr} = '' OR ${sortExpr} = 'null'), ${sortExpr} ${opts.dir === 'desc' ? 'DESC' : 'ASC'}`
      : 'ORDER BY o.creation_date DESC';

  const totalRow = database
    .prepare(
      `SELECT COUNT(*) AS c FROM "orders" "o" LEFT JOIN "clients" "c" ON "o"."client_id" = "c"."client_id" LEFT JOIN "equipment" "e" ON "o"."equipment_id" = "e"."equipment_id" ${where}`
    )
    .get(...params) as unknown as { c: number };
  const rows = database
    .prepare(
      `SELECT "o"."order_id", "o"."client_id", "c"."name" AS "client_name", "c"."number" AS "client_number", "c"."mail" AS "client_mail", "c"."comments" AS "client_comments", "o"."equipment_id", "e"."manufacturer" AS "equipment_manufacturer", "e"."model" AS "equipment_model", "e"."serial_number" AS "equipment_serial_number", "e"."production_date" AS "equipment_production_date", "e"."article_number" AS "equipment_article_number", "o"."creation_date" AS "order_creation_date", "o"."shipping_date" AS "order_shipping_date", "o"."status" AS "order_status", "o"."comments" AS "order_comments", "o"."diagnostic_results" AS "order_diagnostic_results", "o"."price" AS "order_price" FROM "orders" "o" LEFT JOIN "clients" "c" ON "o"."client_id" = "c"."client_id" LEFT JOIN "equipment" "e" ON "o"."equipment_id" = "e"."equipment_id" ${where} ${order} LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset) as unknown as Record<string, unknown>[];

  return { rows, total: Number(totalRow.c) };
}

function buildFilterClause(
  conds: FilterCond[] | undefined,
  allowed: Map<string, string>
): { clause: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const c of conds ?? []) {
    const expr = allowed.get(c.field);
    if (!expr) continue;
    if (c.op === 'contains') {
      parts.push(`${expr} LIKE ?`);
      params.push(`%${c.value ?? ''}%`);
    } else if (c.op === 'equals') {
      parts.push(`${expr} = ?`);
      params.push(c.value ?? '');
    } else if (c.op === 'empty') {
      parts.push(`(${expr} IS NULL OR ${expr} = '' OR ${expr} = 'null')`);
    } else if (c.op === 'notEmpty') {
      parts.push(`(${expr} IS NOT NULL AND ${expr} != '' AND ${expr} != 'null')`);
    }
  }
  return { clause: parts.join(' AND '), params };
}
