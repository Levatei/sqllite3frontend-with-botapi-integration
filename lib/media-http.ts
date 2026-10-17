import fs from 'node:fs';
import { Readable } from 'node:stream';
import { absoluteMediaPath, guessMime, isInsideAllowedRoots } from './media-store';

/**
 * Отдаёт файл с диска: поддержка HTTP Range (нужно для перемотки видео),
 * immutable-кэш и защита от выхода за разрешённые корни.
 */
export function serveFile(req: Request, relPath: string, mime?: string | null): Response {
  const abs = absoluteMediaPath(relPath);
  if (!isInsideAllowedRoots(abs) || !fs.existsSync(abs)) {
    return new Response('Not found', { status: 404 });
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const contentType = mime && mime.trim() ? mime : guessMime(abs);
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
  };

  const range = req.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= stat.size) end = stat.size - 1;
    if (start > end || start >= stat.size) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${stat.size}` },
      });
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    headers['Content-Length'] = String(end - start + 1);
    const stream = Readable.toWeb(
      fs.createReadStream(abs, { start, end })
    ) as unknown as ReadableStream;
    return new Response(stream, { status: 206, headers });
  }

  headers['Content-Length'] = String(stat.size);
  const stream = Readable.toWeb(fs.createReadStream(abs)) as unknown as ReadableStream;
  return new Response(stream, { status: 200, headers });
}
