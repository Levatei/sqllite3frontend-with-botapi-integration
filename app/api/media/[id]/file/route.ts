import { NextResponse } from 'next/server';
import { getMediaById } from '@/lib/db';
import { serveFile } from '@/lib/media-http';
import { logError } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ ok: false, error: 'Некорректный id.' }, { status: 400 });
  }
  try {
    const media = getMediaById(id);
    if (!media) {
      return NextResponse.json({ ok: false, error: 'Файл не найден.' }, { status: 404 });
    }
    return serveFile(req, media.file_path, media.mime_type);
  } catch (e) {
    logError(`GET /api/media/${params.id}/file — ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ ok: false, error: 'Ошибка чтения файла.' }, { status: 500 });
  }
}
