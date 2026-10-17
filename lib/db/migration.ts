import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readRegistry, writeRegistry } from './registry';
import { absDbPath } from './path';
import { getTableNames } from './schema';
import { SAFE_NAME, checkIdent, ALLOWED_TYPES, ALLOWED_FK_ACTIONS } from './schema';

export interface NewColumnDef {
  name: string;
  type: string;
  notNull?: boolean;
  pk?: boolean;
  fkTable?: string;
  fkColumn?: string;
  fkOnUpdate?: string;
  fkOnDelete?: string;
}

export interface NewTableDef {
  name: string;
  columns: NewColumnDef[];
}

export interface DbEntry {
  id: string;
  name: string;
  path: string;
}

function getDbForPath(entry: DbEntry): DatabaseSync {
  const abs = absDbPath(entry);
  return new DatabaseSync(abs, { readOnly: true });
}

function getWriteDbForPath(absPath: string): DatabaseSync {
  const handle = new DatabaseSync(absPath, { readOnly: false });
  handle.prepare('PRAGMA foreign_keys = ON').get();
  return handle;
}

export function listDatabasesInfo(): {
  active: string;
  dbs: { id: string; name: string; tables: { name: string; count: number }[]; error?: string }[];
} {
  const r = readRegistry();
  return {
    active: r.active,
    dbs: r.dbs.map((d: DbEntry) => {
      try {
        const database = getDbForPath(d);
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
    const database = getDbForPath({ id: '', name: '', path: path.relative(process.cwd(), target) });
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

  const database = getWriteDbForPath(target);
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
