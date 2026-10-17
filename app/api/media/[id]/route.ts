import { NextResponse } from 'next/server';
import { deleteMediaRow, getMediaById, updateMediaRow } from '@/lib/db';
import { logError, logInfo } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ ok: false, error: 'Некорректный id.' }, { status: 400 });
  }
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    if ('caption' in body) data.caption = body.caption == null ? null : String(body.caption);
    if ('model' in body) data.model = body.model == null ? null : String(body.model);
    if ('step_no' in body) {
      const n = Number(body.step_no);
      data.step_no = Number.isFinite(n) ? n : null;
    }
    if ('order_id' in body) {
      const n = Number(body.order_id);
      data.order_id = Number.isFinite(n) ? n : null;
    }
    if ('equipment_id' in body) {
      const n = Number(body.equipment_id);
      data.equipment_id = Number.isFinite(n) ? n : null;
    }
    const row = updateMediaRow(id, data);
    if (!row) {
      return NextResponse.json({ ok: false, error: 'Файл не найден.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, media: row });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DB error';
    logError(`PATCH /api/media/${params.id} — ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ ok: false, error: 'Некорректный id.' }, { status: 400 });
  }
  try {
    const existing = getMediaById(id);
    if (!existing) {
      return NextResponse.json({ ok: false, error: 'Файл не найден.' }, { status: 404 });
    }
    deleteMediaRow(id);
    logInfo(`MEDIA delete ${id}`);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DB error';
    logError(`DELETE /api/media/${params.id} — ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
