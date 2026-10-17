import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { getDb, getTableNames, insertMedia, listMedia } from '@/lib/db';
import {
  guessMime,
  isImageMime,
  isVideoMime,
  newMediaFileName,
  slugModel,
  writeMediaFile,
} from '@/lib/media-store';
import { logError, logInfo, withLogging } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 300 * 1024 * 1024;

function numParam(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function textParam(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s === '' ? null : s;
}

function lookupOrder(orderId: number): { clientId: number | null; eqId: number | null } {
  try {
    const db = getDb();
    if (!getTableNames(db).includes('orders')) return { clientId: null, eqId: null };
    const row = db
      .prepare(`SELECT "client_id", "equipment_id" FROM "orders" WHERE "order_id" = ?`)
      .get(orderId) as unknown as { client_id?: number; equipment_id?: number } | undefined;
    return { clientId: row?.client_id ?? null, eqId: row?.equipment_id ?? null };
  } catch {
    return { clientId: null, eqId: null };
  }
}

function lookupEquipmentClient(equipmentId: number): number | null {
  try {
    const db = getDb();
    if (!getTableNames(db).includes('equipment')) return null;
    const row = db
      .prepare(`SELECT "client_id" FROM "equipment" WHERE "equipment_id" = ?`)
      .get(equipmentId) as unknown as { client_id?: number } | undefined;
    return row?.client_id ?? null;
  } catch {
    return null;
  }
}

// Метаданные — без байтов, поэтому список дешёвый.
export const GET = withLogging('GET', '/api/media', async (req: Request) => {
  const url = new URL(req.url);
  const media = listMedia({
    order_id: numParam(url.searchParams.get('order_id')),
    equipment_id: numParam(url.searchParams.get('equipment_id')),
    batch_id: url.searchParams.get('batch_id'),
    model: url.searchParams.get('model'),
  });
  return NextResponse.json({ ok: true, media });
});

export const POST = withLogging('POST', '/api/media', async (req: Request) => {
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof Blob)) {
      return NextResponse.json({ ok: false, error: 'Прикрепите файл.' }, { status: 400 });
    }
    if (file.size === 0 || file.size > MAX_BYTES) {
      return NextResponse.json({ ok: false, error: 'Некорректный размер файла.' }, { status: 400 });
    }
    let mime = file.type || '';
    if (!isVideoMime(mime) && !isImageMime(mime)) {
      const fromName = guessMime(file instanceof File ? file.name : '');
      if (isVideoMime(fromName) || isImageMime(fromName)) mime = fromName;
    }
    const isVideo = isVideoMime(mime);
    const isImage = isImageMime(mime);
    if (!isVideo && !isImage) {
      return NextResponse.json(
        { ok: false, error: 'Поддерживаются только фото и видео.' },
        { status: 400 }
      );
    }
    const originalName = file instanceof File ? file.name : undefined;

    const orderId = numParam(form.get('order_id'));
    let equipmentId = numParam(form.get('equipment_id'));
    const model = textParam(form.get('model'));
    const explicitBatchId = textParam(form.get('batch_id'));
    const caption = textParam(form.get('caption'));
    const source = textParam(form.get('source')) ?? 'web';

    // batch_id — только для «пачек по модели». Файлы заказа к пачкам не относятся.
    const isModelBatch = orderId == null && equipmentId == null;
    const batchId = explicitBatchId ?? (isModelBatch ? crypto.randomUUID() : null);

    let dirParts: string[];
    if (orderId != null) {
      const { clientId, eqId } = lookupOrder(orderId);
      if (equipmentId == null && eqId != null) equipmentId = eqId;
      dirParts = [String(clientId ?? 'na'), String(eqId ?? 'na'), String(orderId)];
    } else if (equipmentId != null) {
      const clientId = lookupEquipmentClient(equipmentId);
      dirParts = [String(clientId ?? 'na'), String(equipmentId)];
    } else {
      dirParts = ['models', slugModel(model ?? 'unknown'), batchId ?? 'misc'];
    }

    const fileName = newMediaFileName(mime, originalName);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const saved = writeMediaFile(dirParts, fileName, bytes);

    let thumbRel: string | null = null;
    const thumb = form.get('thumb');
    if (thumb instanceof Blob && thumb.size > 0) {
      const thumbName = fileName.replace(/\.[^.]+$/, '') + '.thumb.jpg';
      thumbRel = writeMediaFile(dirParts, thumbName, new Uint8Array(await thumb.arrayBuffer())).rel;
    }

    const row = insertMedia({
      batch_id: batchId,
      model,
      order_id: orderId,
      equipment_id: equipmentId,
      kind: isVideo ? 'video' : 'photo',
      role: textParam(form.get('role')) ?? 'media',
      file_path: saved.rel,
      thumb_path: thumbRel,
      mime_type: mime,
      size_bytes: file.size,
      caption,
      source,
    });
    logInfo(`MEDIA add ${row.media_id}`, {
      kind: row.kind,
      order_id: row.order_id,
      equipment_id: row.equipment_id,
      model: row.model,
    });
    return NextResponse.json({ ok: true, media: row }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DB error';
    logError(`POST /api/media — ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
});
