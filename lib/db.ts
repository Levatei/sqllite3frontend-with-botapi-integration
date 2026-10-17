import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { unlinkMediaFile } from './media-store';

export const ALLOWED_TABLES = ['clients', 'equipment', 'orders'] as const;
export type AllowedTable = (typeof ALLOWED_TABLES)[number];

// Таблицы, которые не показываются в авто-списке и недоступны через generic-CRUD.
// Медиа открываются только из раздела «Медиафайлы».
export const HIDDEN_TABLES = ['media'] as const;
export function isHiddenTable(name: string): boolean {
  return (HIDDEN_TABLES as readonly string[]).includes(name);
}

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

const REGISTRY_FILE = path.join(process.cwd(), 'dblist.json');

function defaultEntry(): DbEntry {
  return { id: 'mba_data', name: 'mba_data.db', path: 'mba_data.db' };
}

export function readRegistry(): { active: string; dbs: DbEntry[] } {
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
    const r = JSON.parse(raw) as { active?: unknown; dbs?: unknown };
    if (r && Array.isArray(r.dbs) && r.dbs.length > 0) {
      const dbs = (r.dbs as DbEntry[]).filter(
        (d) => d && typeof d.id === 'string' && typeof d.path === 'string'
      );
      if (dbs.length > 0) {
        const active = typeof r.active === 'string' ? r.active : dbs[0].id;
        return { active, dbs };
      }
    }
  } catch {
    /* missing or corrupt — fall back to default */
  }
  const d = defaultEntry();
  return { active: d.id, dbs: [d] };
}

function writeRegistry(r: { active: string; dbs: DbEntry[] }): void {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(r, null, 2), 'utf8');
}

export function getActiveEntry(): DbEntry {
  const r = readRegistry();
  return r.dbs.find((d) => d.id === r.active) ?? r.dbs[0];
}

function absDbPath(entry: DbEntry): string {
  return path.isAbsolute(entry.path) ? entry.path : path.join(process.cwd(), entry.path);
}

const pools = new Map<string, DatabaseSync>();

function openDb(absPath: string, readOnly: boolean): DatabaseSync {
  const key = `${absPath}|${readOnly ? 'ro' : 'rw'}`;
  let handle = pools.get(key);
  if (!handle) {
    handle = new DatabaseSync(absPath, { readOnly });
    // Ждём освобождения блокировки вместо мгновенной ошибки SQLITE_BUSY
    // (важно, когда в один файл пишут несколько процессов — веб и бот).
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

function getWriteDb(): DatabaseSync {
  const handle = openDb(absDbPath(getActiveEntry()), false);
  handle.prepare('PRAGMA foreign_keys = ON').get();
  // WAL позволяет читать БД, пока идёт запись; режим сохраняется в файле базы.
  try {
    handle.prepare('PRAGMA journal_mode = WAL').get();
  } catch {
    /* ignore */
  }
  return handle;
}

export function isAllowedTable(name: string): name is AllowedTable {
  return (ALLOWED_TABLES as readonly string[]).includes(name);
}

export function getDbLabel(): string {
  return getActiveEntry().name;
}

// ---------- Schema introspection ----------

export function getTableNames(database: DatabaseSync = getDb()): string[] {
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
  const database = getDb();
  return database.prepare(`PRAGMA table_info("${table}")`).all() as unknown as ColumnInfo[];
}

export function getFkChildColumns(table: string, database: DatabaseSync = getDb()): string[] {
  try {
    const rows = database.prepare(`PRAGMA foreign_key_list("${table}")`).all() as unknown as {
      from: string;
    }[];
    return rows.map((r) => r.from);
  } catch {
    return [];
  }
}

const ID_LIKE = /^id$|^id_|_id$/i;

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

function fkParentProblem(table: string, database: DatabaseSync): string | null {
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

function clean(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

// ---------- List / count ----------

export interface ListOptions {
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

// ---------- Generic CRUD (works for any table incl. custom) ----------

const knownColumns = (table: string, database: DatabaseSync): Set<string> =>
  new Set(getColumns(table).map((c) => c.name));

const getPkColumn = (table: string, database: DatabaseSync): string | null => {
  const pks = getColumns(table).filter((c) => c.pk > 0);
  if (pks.length === 1) return pks[0].name;
  return null;
};

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
  // При удалении заявки подчищаем файлы её медиа (строки уйдут каскадом).
  if (table === 'orders') deleteOrderMediaFiles(rowid, database);
  database.prepare(`DELETE FROM "${table}" WHERE rowid = ?`).get(rowid);
}

// ---------- Медиафайлы (отдельная таблица, байты — на диске) ----------

export const MEDIA_TABLE = 'media';

export interface MediaRecord {
  media_id: number;
  batch_id: string | null;
  model: string | null;
  order_id: number | null;
  equipment_id: number | null;
  kind: string | null;
  role: string | null;
  file_path: string;
  thumb_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  step_no: number | null;
  caption: string | null;
  source: string | null;
  created_at: string | null;
}

export interface MediaInput {
  batch_id?: string | null;
  model?: string | null;
  order_id?: number | null;
  equipment_id?: number | null;
  kind?: string | null;
  role?: string | null;
  file_path: string;
  thumb_path?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  width?: number | null;
  height?: number | null;
  duration_sec?: number | null;
  step_no?: number | null;
  caption?: string | null;
  source?: string | null;
  created_at?: string | null;
}

/** Идемпотентно создаёт таблицу media и индексы. */
export function ensureMediaTable(database: DatabaseSync = getWriteDb()): void {
  database
    .prepare(
      `CREATE TABLE IF NOT EXISTS "media" (
        "media_id"     INTEGER PRIMARY KEY,
        "batch_id"     TEXT,
        "model"        TEXT,
        "order_id"     INTEGER REFERENCES "orders"("order_id")        ON UPDATE CASCADE ON DELETE CASCADE,
        "equipment_id" INTEGER REFERENCES "equipment"("equipment_id")  ON UPDATE CASCADE ON DELETE SET NULL,
        "kind"         TEXT,
        "role"         TEXT,
        "file_path"    TEXT NOT NULL,
        "thumb_path"   TEXT,
        "mime_type"    TEXT,
        "size_bytes"   INTEGER,
        "width"        INTEGER,
        "height"       INTEGER,
        "duration_sec" REAL,
        "step_no"      INTEGER,
        "caption"      TEXT,
        "source"       TEXT,
        "created_at"   TEXT
      )`
    )
    .get();
  database
    .prepare(`CREATE INDEX IF NOT EXISTS "idx_media_batch" ON "media"("batch_id")`)
    .get();
  database.prepare(`CREATE INDEX IF NOT EXISTS "idx_media_model" ON "media"("model")`).get();
  database.prepare(`CREATE INDEX IF NOT EXISTS "idx_media_order" ON "media"("order_id")`).get();
  database
    .prepare(`CREATE INDEX IF NOT EXISTS "idx_media_equipment" ON "media"("equipment_id")`)
    .get();
}

function nextMediaStep(input: MediaInput, database: DatabaseSync): number {
  try {
    if (input.batch_id) {
      const r = database
        .prepare(`SELECT COALESCE(MAX("step_no"), 0) AS m FROM "media" WHERE "batch_id" = ?`)
        .get(input.batch_id) as unknown as { m: number };
      return Number(r.m) + 1;
    }
    if (input.order_id != null) {
      const r = database
        .prepare(`SELECT COALESCE(MAX("step_no"), 0) AS m FROM "media" WHERE "order_id" = ?`)
        .get(input.order_id) as unknown as { m: number };
      return Number(r.m) + 1;
    }
  } catch {
    /* ignore */
  }
  return 1;
}

export function insertMedia(
  input: MediaInput,
  database: DatabaseSync = getWriteDb()
): MediaRecord {
  ensureMediaTable(database);
  const createdAt = input.created_at ?? new Date().toISOString();
  const stepNo = input.step_no ?? nextMediaStep(input, database);
  database
    .prepare(
      `INSERT INTO "media"
        ("batch_id","model","order_id","equipment_id","kind","role","file_path","thumb_path",
         "mime_type","size_bytes","width","height","duration_sec","step_no","caption","source","created_at")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .get(
      input.batch_id ?? null,
      input.model ?? null,
      input.order_id ?? null,
      input.equipment_id ?? null,
      input.kind ?? null,
      input.role ?? 'media',
      input.file_path,
      input.thumb_path ?? null,
      input.mime_type ?? null,
      input.size_bytes ?? null,
      input.width ?? null,
      input.height ?? null,
      input.duration_sec ?? null,
      stepNo,
      input.caption ?? null,
      input.source ?? 'web',
      createdAt
    );
  const id = (
    database.prepare('SELECT last_insert_rowid() AS id').get() as unknown as { id: number }
  ).id;
  return database
    .prepare(`SELECT * FROM "media" WHERE "media_id" = ?`)
    .get(id) as unknown as MediaRecord;
}

export function getMediaById(
  id: number,
  database: DatabaseSync = getDb()
): MediaRecord | null {
  if (!tableExists(MEDIA_TABLE, database)) return null;
  const row = database.prepare(`SELECT * FROM "media" WHERE "media_id" = ?`).get(id);
  return (row as unknown as MediaRecord) ?? null;
}

export interface MediaQuery {
  order_id?: number | null;
  equipment_id?: number | null;
  batch_id?: string | null;
  model?: string | null;
  limit?: number;
}

export function listMedia(
  query: MediaQuery = {},
  database: DatabaseSync = getDb()
): MediaRecord[] {
  if (!tableExists(MEDIA_TABLE, database)) return [];
  const conds: string[] = [];
  const params: unknown[] = [];
  if (query.order_id != null) {
    conds.push(`"order_id" = ?`);
    params.push(query.order_id);
  }
  if (query.equipment_id != null) {
    conds.push(`"equipment_id" = ?`);
    params.push(query.equipment_id);
  }
  if (query.batch_id) {
    conds.push(`"batch_id" = ?`);
    params.push(query.batch_id);
  }
  if (query.model) {
    conds.push(`"model" = ?`);
    params.push(query.model);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const limit = Math.min(1000, Math.max(1, Math.floor(query.limit ?? 500)));
  return database
    .prepare(
      `SELECT * FROM "media" ${where} ORDER BY COALESCE("step_no", 999999) ASC, "created_at" ASC LIMIT ?`
    )
    .all(...params, limit) as unknown as MediaRecord[];
}

export function updateMediaRow(
  id: number,
  data: Partial<Pick<MediaInput, 'caption' | 'step_no' | 'order_id' | 'equipment_id' | 'model'>>,
  database: DatabaseSync = getWriteDb()
): MediaRecord | null {
  const allowed = new Set(['caption', 'step_no', 'order_id', 'equipment_id', 'model']);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(data ?? {})) {
    if (!allowed.has(k)) continue;
    sets.push(`"${k}" = ?`);
    params.push(v ?? null);
  }
  if (sets.length === 0) return getMediaById(id, database);
  database.prepare(`UPDATE "media" SET ${sets.join(', ')} WHERE "media_id" = ?`).get(...params, id);
  return getMediaById(id, database);
}

export function deleteMediaRow(
  id: number,
  database: DatabaseSync = getWriteDb()
): MediaRecord | null {
  const row = getMediaById(id, database);
  if (!row) return null;
  database.prepare(`DELETE FROM "media" WHERE "media_id" = ?`).get(id);
  unlinkMediaFile(row.file_path);
  unlinkMediaFile(row.thumb_path);
  return row;
}

function deleteOrderMediaFiles(orderRowid: number, database: DatabaseSync): void {
  try {
    if (!tableExists(MEDIA_TABLE, database)) return;
    const order = database
      .prepare(`SELECT "order_id" FROM "orders" WHERE rowid = ?`)
      .get(orderRowid) as unknown as { order_id?: number } | undefined;
    if (!order || order.order_id == null) return;
    const files = database
      .prepare(`SELECT "file_path", "thumb_path" FROM "media" WHERE "order_id" = ?`)
      .all(order.order_id) as unknown as { file_path: string; thumb_path: string | null }[];
    for (const f of files) {
      unlinkMediaFile(f.file_path);
      unlinkMediaFile(f.thumb_path);
    }
  } catch {
    /* не мешаем удалению записи */
  }
}

export interface MediaCounts {
  total: number;
  byModel: { model: string; count: number; last_at: string | null }[];
  byEquipment: { equipment_id: number; count: number }[];
  byOrder: { order_id: number; count: number }[];
  batches: {
    batch_id: string;
    model: string | null;
    count: number;
    has_video: number;
    last_at: string | null;
  }[];
}

export function getMediaCounts(database: DatabaseSync = getDb()): MediaCounts {
  const empty: MediaCounts = { total: 0, byModel: [], byEquipment: [], byOrder: [], batches: [] };
  if (!tableExists(MEDIA_TABLE, database)) return empty;
  const totalRow = database
    .prepare(`SELECT COUNT(*) AS "count" FROM "media"`)
    .get() as { count: number } | undefined;
  const total = Number(totalRow?.count ?? 0);
  const byModel = database
    .prepare(
      `SELECT "model", COUNT(*) AS "count", MAX("created_at") AS "last_at"
         FROM "media" WHERE "model" IS NOT NULL AND "model" != ''
         GROUP BY "model" ORDER BY "last_at" DESC`
    )
    .all() as unknown as MediaCounts['byModel'];
  const byEquipment = database
    .prepare(
      `SELECT "equipment_id", COUNT(*) AS "count" FROM "media"
        WHERE "equipment_id" IS NOT NULL GROUP BY "equipment_id"`
    )
    .all() as unknown as MediaCounts['byEquipment'];
  const byOrder = database
    .prepare(
      `SELECT "order_id", COUNT(*) AS "count" FROM "media"
        WHERE "order_id" IS NOT NULL GROUP BY "order_id"`
    )
    .all() as unknown as MediaCounts['byOrder'];
  const batches = database
    .prepare(
      `SELECT "batch_id", MAX("model") AS "model", COUNT(*) AS "count",
              MAX(CASE WHEN "kind" = 'video' THEN 1 ELSE 0 END) AS "has_video",
              MAX("created_at") AS "last_at"
         FROM "media" WHERE "batch_id" IS NOT NULL
         GROUP BY "batch_id" ORDER BY "last_at" DESC`
    )
    .all() as unknown as MediaCounts['batches'];
  return { total, byModel, byEquipment, byOrder, batches };
}

export interface MediaTreeClient {
  client_id: number;
  name: string | null;
  number: string | null;
  mail: string | null;
}

export interface MediaTreeEquipment {
  equipment_id: number;
  client_id: number | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
}

export interface MediaTreeOrder {
  order_id: number;
  equipment_id: number | null;
  client_id: number | null;
  status: string | null;
  creation_date: string | null;
}

export interface MediaTree {
  clients: MediaTreeClient[];
  equipment: MediaTreeEquipment[];
  orders: MediaTreeOrder[];
}

/**
 * Лёгкое дерево для раздела «Медиафайлы»: клиенты, насосы и заявки широкими
 * срезами (id + подпись), без лимита пагинации и без медиафайлов.
 */
export function getMediaTree(database: DatabaseSync = getDb()): MediaTree {
  const pick = <T>(table: string, run: () => T[]): T[] => {
    try {
      return tableExists(table, database) ? run() : [];
    } catch {
      return [];
    }
  };
  const clients = pick<MediaTreeClient>('clients', () =>
    database
      .prepare(`SELECT "client_id", "name", "number", "mail" FROM "clients" ORDER BY "name"`)
      .all() as unknown as MediaTreeClient[]
  );
  const equipment = pick<MediaTreeEquipment>('equipment', () =>
    database
      .prepare(
        `SELECT "equipment_id", "client_id", "manufacturer", "model", "serial_number" FROM "equipment"`
      )
      .all() as unknown as MediaTreeEquipment[]
  );
  const orders = pick<MediaTreeOrder>('orders', () =>
    database
      .prepare(
        `SELECT "order_id", "equipment_id", "client_id", "status", "creation_date"
           FROM "orders" ORDER BY "creation_date" DESC, "order_id" DESC`
      )
      .all() as unknown as MediaTreeOrder[]
  );
  return { clients, equipment, orders };
}

// ---------- Overview (clean human view, no raw IDs) ----------

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

export function listOverview(opts: {
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  filters?: FilterCond[];
} = {}): {
  rows: Record<string, unknown>[];
  total: number;
} {
  const database = getDb();
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 50)));
  const offset = (page - 1) * pageSize;
  const search = (opts.search ?? '').trim();

  const searchCols = [
    'c.name', 'c.mail', 'c.comments', 'c.number',
    'e.manufacturer', 'e.model', 'e.serial_number', 'e.article_number', 'e.production_date',
    'o.status', 'o.comments', 'o.diagnostic_results', 'o.creation_date', 'o.shipping_date', 'o.price',
  ];

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

// ---------- Multi-DB management ----------

export function setActiveDb(id: string): DbEntry {
  const r = readRegistry();
  const entry = r.dbs.find((d) => d.id === id);
  if (!entry) throw new Error('База данных не найдена в списке.');
  r.active = id;
  writeRegistry(r);
  return entry;
}

export function listDatabasesInfo(): {
  active: string;
  dbs: { id: string; name: string; tables: { name: string; count: number }[]; error?: string }[];
} {
  const r = readRegistry();
  return {
    active: r.active,
    dbs: r.dbs.map((d) => {
      try {
        const database = openDb(absDbPath(d), true);
        const names = getTableNames(database);
        return {
          id: d.id,
          name: d.name,
          tables: names.map((n) => ({
            name: n,
            count: Number(
              (database.prepare(`SELECT COUNT(*) AS c FROM "${n}"`).get() as unknown as { c: number }).c
            ),
          })),
        };
      } catch (e) {
        return { id: d.id, name: d.name, tables: [], error: e instanceof Error ? e.message : 'DB error' };
      }
    }),
  };
}

const SAFE_NAME = /^[\p{L}_][\p{L}\p{N}_-]*$/u;

export function attachDatabaseFile(fileName: string, bytes: Uint8Array): DbEntry {
  const base = path.basename(fileName).replace(/\.[^.]+$/, '') || 'database';
  const safe = base.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 48) || 'database';
  const dir = path.join(process.cwd(), 'databases');
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, `${safe}.db`);
  let n = 1;
  while (fs.existsSync(target)) {
    n += 1;
    target = path.join(dir, `${safe}-${n}.db`);
  }
  fs.writeFileSync(target, bytes);
  try {
    const database = openDb(target, true);
    getTableNames(database);
  } catch (e) {
    fs.unlinkSync(target);
    throw new Error('Файл не является валидной SQLite-базой.');
  }
  const entry: DbEntry = {
    id: crypto.randomUUID(),
    name: path.basename(target),
    path: path.relative(process.cwd(), target),
  };
  const r = readRegistry();
  r.dbs.push(entry);
  r.active = entry.id;
  writeRegistry(r);
  return entry;
}

export type NewColumnDef = {
  name: string;
  type: string;
  notNull?: boolean;
  pk?: boolean;
  fkTable?: string;
  fkColumn?: string;
  fkOnUpdate?: string;
  fkOnDelete?: string;
};

export type NewTableDef = {
  name: string;
  columns: NewColumnDef[];
};

const ALLOWED_TYPES = ['TEXT', 'INTEGER', 'REAL', 'NUMERIC', 'DATE'];
const ALLOWED_FK_ACTIONS = ['CASCADE', 'RESTRICT', 'SET NULL', 'NO ACTION', 'SET DEFAULT'];

function checkIdent(name: string, what: string): void {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`${what} «${name}»: только буквы, цифры, _ и -, начинается с буквы или _.`);
  }
}

export function createDatabaseFile(dbName: string, tables: NewTableDef[]): DbEntry {
  const base = (dbName || '').trim().replace(/\.[^.]+$/, '') || 'new-database';
  if (!SAFE_NAME.test(base)) throw new Error('Некорректное имя базы данных.');
  if (!Array.isArray(tables) || tables.length === 0) throw new Error('Добавьте хотя бы одну таблицу.');
  const tableNames = tables.map((t) => (t.name || '').trim());
  if (new Set(tableNames).size !== tableNames.length) throw new Error('Имена таблиц должны быть уникальны.');
  for (const t of tables) {
    checkIdent(t.name.trim(), 'Имя таблицы');
    if (!Array.isArray(t.columns) || t.columns.length === 0) {
      throw new Error(`Таблица «${t.name}»: добавьте хотя бы одно поле.`);
    }
    const colNames = t.columns.map((c) => (c.name || '').trim());
    if (new Set(colNames).size !== colNames.length) {
      throw new Error(`Таблица «${t.name}»: имена полей должны быть уникальны.`);
    }
    for (const c of t.columns) {
      checkIdent(c.name.trim(), 'Имя поля');
      if (!ALLOWED_TYPES.includes((c.type || '').toUpperCase())) {
        throw new Error(`Поле «${c.name}»: недопустимый тип.`);
      }
    }
  }
  const colsByTable = new Map(tables.map((t) => [t.name.trim(), new Set(t.columns.map((c) => c.name.trim()))]));
  const pkByTable = new Map(tables.map((t) => [t.name.trim(), new Set(t.columns.filter((c) => c.pk).map((c) => c.name.trim()))]));
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.fkTable) {
        if (!colsByTable.has(c.fkTable) || !colsByTable.get(c.fkTable)!.has(c.fkColumn || '')) {
          throw new Error(`Поле «${c.name}»: ссылка на несуществующее поле.`);
        }
        if (!pkByTable.get(c.fkTable)?.has(c.fkColumn || '')) {
          throw new Error(`Поле «${c.name}»: в таблице «${c.fkTable}» поле «${c.fkColumn}» должно быть PRIMARY KEY, иначе SQLite запретит любую вставку в «${t.name.trim()}».`);
        }
        if (c.fkTable === t.name.trim()) throw new Error(`Поле «${c.name}»: самоссылка запрещена.`);
      }
    }
  }

  const dir = path.join(process.cwd(), 'databases');
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, `${base}.db`);
  let n = 1;
  while (fs.existsSync(target)) {
    n += 1;
    target = path.join(dir, `${base}-${n}.db`);
  }

  const database = openDb(target, false);
  const tableDefs: string[] = [];
  const indexDefs: string[] = [];
  for (const t of tables) {
    const tName = t.name.trim();
    const colDefs = t.columns.map((c) => {
      const type = (c.type || 'TEXT').toUpperCase();
      return `"${c.name.trim()}" ${type}${c.notNull ? ' NOT NULL' : ''}`;
    });
    const pkCols = t.columns.filter((c) => c.pk).map((c) => `"${c.name.trim()}"`);
    if (pkCols.length > 0) colDefs.push(`PRIMARY KEY (${pkCols.join(', ')})`);
    for (const c of t.columns) {
      if (c.fkTable && c.fkColumn) {
        const up = ALLOWED_FK_ACTIONS.includes((c.fkOnUpdate || '').toUpperCase())
          ? (c.fkOnUpdate as string).toUpperCase()
          : 'CASCADE';
        const del = ALLOWED_FK_ACTIONS.includes((c.fkOnDelete || '').toUpperCase())
          ? (c.fkOnDelete as string).toUpperCase()
          : 'RESTRICT';
        colDefs.push(
          `FOREIGN KEY ("${c.name.trim()}") REFERENCES "${c.fkTable}" ("${c.fkColumn}") ON UPDATE ${up} ON DELETE ${del}`
        );
        indexDefs.push(`CREATE INDEX "idx_${tName}_${c.name.trim()}" ON "${tName}" ("${c.name.trim()}")`);
      }
    }
    tableDefs.push(`CREATE TABLE "${tName}" (\n  ${colDefs.join(',\n  ')}\n)`);
  }
  try {
    database.prepare('BEGIN IMMEDIATE').get();
    try {
      for (const sql of tableDefs) database.prepare(sql).get();
      for (const sql of indexDefs) database.prepare(sql).get();
      database.prepare('COMMIT').get();
    } catch (e) {
      try {
        database.prepare('ROLLBACK').get();
      } catch {
        /* ignore */
      }
      throw e;
    }
  } catch (e) {
    pools.delete(`${target}|rw`);
    try {
      fs.unlinkSync(target);
    } catch {
      /* ignore */
    }
    throw new Error(e instanceof Error ? e.message : 'Не удалось создать базу данных.');
  }

  const entry: DbEntry = {
    id: crypto.randomUUID(),
    name: path.basename(target),
    path: path.relative(process.cwd(), target),
  };
  const r = readRegistry();
  r.dbs.push(entry);
  r.active = entry.id;
  writeRegistry(r);
  return entry;
}
