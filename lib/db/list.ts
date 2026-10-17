import { DatabaseSync } from 'node:sqlite';
import { getDb } from './connection';
import { getColumns, tableExists } from './schema';

export type FilterOp = 'contains' | 'equals' | 'empty' | 'notEmpty';

export interface FilterCond {
  field: string;
  op: FilterOp;
  value?: string;
}

export interface ListOptions {
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  filters?: FilterCond[];
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

export function parseFilters(raw: string | null): FilterCond[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as FilterCond[];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((c) => c && typeof c.field === 'string' && typeof c.op === 'string')
      .map((c) => ({ field: c.field, op: c.op as FilterOp, value: String(c.value ?? '') }));
  } catch {
    return [];
  }
}

export function getCount(table: string, search?: string, filters?: FilterCond[]): number {
  const database = getDb();
  const columns = getColumns(table);
  const colNames = columns.map((c) => c.name);
  const conds: string[] = [];
  const params: unknown[] = [];
  if (search) {
    const like = `%${search}%`;
    conds.push(`(${colNames.map((n) => `"${n}" LIKE ?`).join(' OR ')})`);
    colNames.forEach(() => params.push(like));
  }
  const allowed = new Map(colNames.map((n) => [n, `"${n}"`]));
  const f = buildFilterClause(filters, allowed);
  if (f.clause) {
    conds.push(`(${f.clause})`);
    params.push(...f.params);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const row = database.prepare(`SELECT COUNT(*) AS c FROM "${table}" ${where}`).get(...params) as unknown as { c: number };
  return Number(row.c);
}

export function listRows(table: string, opts: ListOptions = {}): {
  rows: Record<string, unknown>[];
  total: number;
} {
  const database = getDb();
  const columns = getColumns(table);
  const colNames = columns.map((c) => c.name);

  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 20)));
  const offset = (page - 1) * pageSize;

  const search = (opts.search ?? '').trim();
  const params: unknown[] = [];
  const conds: string[] = [];
  if (search) {
    const like = `%${search}%`;
    conds.push(`(${colNames.map((n) => `"${n}" LIKE ?`).join(' OR ')})`);
    colNames.forEach(() => params.push(like));
  }
  const allowed = new Map(colNames.map((n) => [n, `"${n}"`]));
  const f = buildFilterClause(opts.filters, allowed);
  if (f.clause) {
    conds.push(`(${f.clause})`);
    params.push(...f.params);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  let order = '';
  if (opts.sort && colNames.includes(opts.sort)) {
    const dir = opts.dir === 'desc' ? 'DESC' : 'ASC';
    order = `ORDER BY ("${opts.sort}" IS NULL OR "${opts.sort}" = '' OR "${opts.sort}" = 'null'), "${opts.sort}" ${dir}`;
  }

  const total = getCount(table, search || undefined, opts.filters);
  const selectWithRowId = `SELECT *, "rowid" AS "_rowid" FROM "${table}" ${where} ${order} LIMIT ? OFFSET ?`;
  const selectPlain = `SELECT * FROM "${table}" ${where} ${order} LIMIT ? OFFSET ?`;
  let rows: Record<string, unknown>[];
  try {
    rows = database.prepare(selectWithRowId).all(...params, pageSize, offset) as unknown as Record<string, unknown>[];
  } catch {
    rows = database.prepare(selectPlain).all(...params, pageSize, offset) as unknown as Record<string, unknown>[];
  }

  return { rows, total };
}
