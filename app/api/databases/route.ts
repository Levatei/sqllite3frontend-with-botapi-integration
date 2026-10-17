import { NextResponse } from 'next/server';
import {
  attachDatabaseFile,
  createDatabaseFile,
  listDatabasesInfo,
  readRegistry,
  setActiveDb,
  type NewTableDef,
} from '@/lib/db';
import { logError, logInfo, withLogging } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging('GET', '/api/databases', async () => {
  try {
    return NextResponse.json({ ok: true, ...listDatabasesInfo() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DB error';
    logError(`GET /api/databases — ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
});

export const PUT = withLogging('PUT', '/api/databases', async (req: Request) => {
  try {
    const body = (await req.json()) as { id?: string };
    if (!body.id) {
      return NextResponse.json({ ok: false, error: 'Нужен id базы данных.' }, { status: 400 });
    }
    const entry = setActiveDb(body.id);
    logInfo(`Переключение БД → ${entry.name}`, { id: entry.id });
    return NextResponse.json({ ok: true, active: entry.id, db: entry.name });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DB error';
    logError(`PUT /api/databases — ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
});

export const POST = withLogging('POST', '/api/databases', async (req: Request) => {
  try {
    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      if (!(file instanceof Blob)) {
        return NextResponse.json({ ok: false, error: 'Прикрепите файл базы данных.' }, { status: 400 });
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length === 0 || bytes.length > 100 * 1024 * 1024) {
        return NextResponse.json({ ok: false, error: 'Некорректный размер файла.' }, { status: 400 });
      }
      const entry = attachDatabaseFile((file as File).name || 'database.db', bytes);
      logInfo(`Загружена БД ${entry.name}`, { id: entry.id, bytes: bytes.length });
      return NextResponse.json({ ok: true, active: entry.id, db: entry.name, registry: readRegistry() }, { status: 201 });
    }
    const body = (await req.json()) as { mode?: string; name?: string; tables?: NewTableDef[] };
    if (body.mode !== 'create') {
      return NextResponse.json({ ok: false, error: 'Unknown mode.' }, { status: 400 });
    }
    const entry = createDatabaseFile(body.name ?? '', body.tables ?? []);
    logInfo(`Создана БД ${entry.name}`, { id: entry.id, tables: (body.tables ?? []).length });
    return NextResponse.json({ ok: true, active: entry.id, db: entry.name, registry: readRegistry() }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DB error';
    logError(`POST /api/databases — ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
});
