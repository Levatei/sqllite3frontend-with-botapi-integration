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
    // Превью есть не всегда: для фото отдаём сам файл, для видео без постера — 404.
    if (media.thumb_path) {
      return serveFile(req, media.thumb_path, 'image/jpeg');
    }
    if (media.kind === 'photo' || (media.mime_type ?? '').startsWith('image/')) {
      return serveFile(req, media.file_path, media.mime_type);
    }
    return NextResponse.json({ ok: false, error: 'Нет превью.' }, { status: 404 });
  } catch (e) {
    logError(`GET /api/media/${params.id}/thumb — ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ ok: false, error: 'Ошибка чтения превью.' }, { status: 500 });
  }
}
