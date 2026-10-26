import {
  ensureMediaTable,
  genericInsert,
  genericUpdate,
  getDb,
  insertMedia,
  listMedia,
  listRows,
  tableExists,
  type MediaRecord,
} from '../lib/db';
import { absoluteMediaPath, isInsideAllowedRoots } from '../lib/media-store';
import { config } from './config';
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Nameplate } from './vision';

export type Row = Record<string, unknown>;

export function findClients(query: string, limit = 8): Row[] {
  return listRows('clients', { search: query, page: 1, pageSize: limit }).rows;
}

export function listRecentClients(limit = 8): Row[] {
  return listRows('clients', { page: 1, pageSize: limit }).rows;
}

export function getClientById(id: number): Row | undefined {
  const { rows } = listRows('clients', {
    filters: [{ field: 'client_id', op: 'equals', value: String(id) }],
    page: 1,
    pageSize: 1,
  });
  return rows[0];
}

export function getOrderById(id: number): Row | undefined {
  const { rows } = listRows('orders', {
    filters: [{ field: 'order_id', op: 'equals', value: String(id) }],
    page: 1,
    pageSize: 1,
  });
  return rows[0];
}

export interface OrderDetails {
  order_id: number;
  client_id: number | null;
  equipment_id: number | null;
  status: string | null;
  creation_date: string | null;
  client_name: string | null;
  client_number: string | null;
  client_mail: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  comments: string | null;
  diagnostic_results: string | null;
  price: string | number | null;
}

function queryOrderRows(where: string, params: unknown[]): OrderDetails[] {
  const db = getDb();
  if (!tableExists('orders', db)) return [];
  const hasEquipment = tableExists('equipment', db);
  const hasClients = tableExists('clients', db);
  const equipmentJoin = hasEquipment
    ? 'LEFT JOIN "equipment" e ON e."equipment_id" = o."equipment_id"'
    : '';
  const clientsJoin = hasClients
    ? 'LEFT JOIN "clients" c ON c."client_id" = o."client_id"'
    : '';
  const columns = [
    'o."order_id" AS order_id',
    'o."client_id" AS client_id',
    'o."equipment_id" AS equipment_id',
    'o."status" AS status',
    'o."creation_date" AS creation_date',
    'o."comments" AS comments',
    'o."diagnostic_results" AS diagnostic_results',
    'o."price" AS price',
    hasClients ? 'c."name" AS client_name' : 'NULL AS client_name',
    hasClients ? 'c."number" AS client_number' : 'NULL AS client_number',
    hasClients ? 'c."mail" AS client_mail' : 'NULL AS client_mail',
    hasEquipment ? 'e."manufacturer" AS manufacturer' : 'NULL AS manufacturer',
    hasEquipment ? 'e."model" AS model' : 'NULL AS model',
    hasEquipment ? 'e."serial_number" AS serial_number' : 'NULL AS serial_number',
  ].join(', ');
  const rows = db
    .prepare(`SELECT ${columns} FROM "orders" o ${equipmentJoin} ${clientsJoin} ${where}`)
    .all(...params);
  return rows as unknown as OrderDetails[];
}

/** Заявка вместе с клиентом и оборудованием — для карточки в боте. */
export function getOrderDetails(orderId: number): OrderDetails | undefined {
  try {
    return queryOrderRows('WHERE o."order_id" = ? LIMIT 1', [orderId])[0];
  } catch {
    return undefined;
  }
}

/** Актуальные заявки: все, кроме закрытых («Выдано»), сначала новые. */
export function listActiveOrders(): OrderDetails[] {
  try {
    return queryOrderRows(
      `WHERE TRIM(COALESCE(o."status", '')) <> 'Выдано'
        ORDER BY o."creation_date" DESC, o."order_id" DESC`,
      []
    );
  } catch {
    return [];
  }
}

/** Записать результат диагностики в заявку. */
export function updateOrderDiagnostics(orderId: number, text: string): boolean {
  try {
    const db = getDb();
    if (!tableExists('orders', db)) return false;
    const row = db
      .prepare('SELECT rowid AS rid FROM "orders" WHERE "order_id" = ? LIMIT 1')
      .get(orderId) as unknown as { rid: number } | undefined;
    if (!row) return false;
    genericUpdate('orders', Number(row.rid), { diagnostic_results: text });
    return true;
  } catch {
    return false;
  }
}

/** Все медиафайлы заявки (включая фото шильдика и загрузки из веба). */
export function listOrderMedia(orderId: number): MediaRecord[] {
  return listMedia({ order_id: orderId, limit: 1000 });
}

export function insertClient(data: { name: string; number?: string; mail?: string }): number {
  const row = genericInsert('clients', {
    name: data.name,
    number: data.number ?? '',
    mail: data.mail ?? '',
  });
  return Number(row.client_id);
}

export function insertEquipment(clientId: number, n: Nameplate): number {
  const row = genericInsert('equipment', {
    client_id: clientId,
    manufacturer: n.manufacturer ?? '',
    model: n.model ?? '',
    serial_number: n.serial_number ?? '',
    production_date: n.production_date ?? '',
    article_number: n.article_number ?? '',
  });
  return Number(row.equipment_id);
}

export function insertOrder(clientId: number, equipmentId: number): number {
  const today = new Date().toISOString().slice(0, 10);
  const row = genericInsert('orders', {
    client_id: clientId,
    equipment_id: equipmentId,
    creation_date: today,
    status: config.orderStatus,
    comments: '',
  });
  return Number(row.order_id);
}

export function clientLabel(row: Row | undefined): string {
  if (!row) return '';
  const name = row.name ? String(row.name) : 'Без названия';
  const number = row.number ? ` · ${String(row.number)}` : '';
  return `${name}${number}`;
}

/**
 * Разовая миграция: раньше путь к фото шильдика писался текстом в orders.comments.
 * Переносим такие файлы в таблицу media, чтобы они были видны в разделе «Медиафайлы».
 * Файлы, которых нет на диске, не переносим.
 */
export function migrateLegacyOrderPhotos(database: DatabaseSync = getDb()): number {
  try {
    if (!tableExists('orders', database)) return 0;
    ensureMediaTable(database);
    const rows = database
      .prepare(
        `SELECT "order_id", "equipment_id", "comments" FROM "orders"
          WHERE "comments" LIKE '%Фото шильдика:%'`
      )
      .all() as unknown as {
      order_id: number | null;
      equipment_id: number | null;
      comments: string | null;
    }[];
    let migrated = 0;
    for (const r of rows) {
      const m = /Фото шильдика:\s*(\S+)/.exec(String(r.comments ?? ''));
      if (!m) continue;
      const rel = m[1];
      const abs = absoluteMediaPath(rel);
      if (!isInsideAllowedRoots(abs) || !fs.existsSync(abs)) continue;
      const already = database
        .prepare(`SELECT 1 FROM "media" WHERE "file_path" = ? LIMIT 1`)
        .get(rel);
      if (already) continue;
      insertMedia(
        {
          order_id: r.order_id ?? null,
          equipment_id: r.equipment_id ?? null,
          kind: 'photo',
          role: 'nameplate',
          file_path: rel,
          source: 'bot',
        },
        database
      );
      migrated += 1;
    }
    return migrated;
  } catch {
    return 0;
  }
}
