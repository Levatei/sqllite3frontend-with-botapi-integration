import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { logError, withLogging } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Терминальный статус: такие заявки считаются завершёнными и на CRM-доске не показываются
// (остаются доступны в разделе «Заказы»).
const COMPLETED_STATUS = 'Выдано';

export const GET = withLogging('GET', '/api/kanban', async () => {
  try {
    const database = getDb();
    const orders = database
      .prepare(
        `SELECT
           "o"."rowid" AS "_rowid",
           "o"."order_id" AS "order_id",
           "o"."client_id" AS "client_id",
           "o"."equipment_id" AS "equipment_id",
           "o"."creation_date" AS "creation_date",
           "o"."shipping_date" AS "shipping_date",
           "o"."status" AS "status",
           "o"."comments" AS "comments",
           "o"."diagnostic_results" AS "diagnostic_results",
           "o"."price" AS "price",
           "c"."name" AS "client_name",
           "c"."mail" AS "client_mail",
           "e"."manufacturer" AS "manufacturer",
           "e"."model" AS "model",
           "e"."serial_number" AS "serial_number"
         FROM "orders" "o"
         LEFT JOIN "clients" "c" ON "c"."client_id" = "o"."client_id"
         LEFT JOIN "equipment" "e" ON "e"."equipment_id" = "o"."equipment_id"
         WHERE COALESCE("o"."status", '') <> '${COMPLETED_STATUS}'
         ORDER BY "o"."rowid" DESC`
      )
      .all() as unknown as Record<string, unknown>[];
    return NextResponse.json({ ok: true, orders });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DB error';
    logError(`GET /api/kanban — ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
});
