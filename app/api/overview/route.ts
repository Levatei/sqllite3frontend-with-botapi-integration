import { NextResponse } from 'next/server';
import { isCompatibleDb, listOverview, parseFilters } from '@/lib/db';
import { logError, withLogging } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging('GET', '/api/overview', async (req: Request) => {
  try {
    if (!isCompatibleDb()) {
      return NextResponse.json(
        { ok: false, error: 'Сводка доступна только для стандартной схемы (clients, equipment, orders).' },
        { status: 400 }
      );
    }
    const url = new URL(req.url);
    const search = url.searchParams.get('search') ?? '';
    const page = Number(url.searchParams.get('page') ?? '1') || 1;
    const pageSize = Number(url.searchParams.get('pageSize') ?? '50') || 50;
    const sort = url.searchParams.get('sort') ?? undefined;
    const dir = url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc';
    const filters = parseFilters(url.searchParams.get('filters'));
    const { rows, total } = listOverview({ search, page, pageSize, sort, dir, filters });
    return NextResponse.json({
      ok: true,
      page: Math.max(1, Math.floor(page)),
      pageSize: Math.min(100, Math.max(1, Math.floor(pageSize))),
      total,
      rows,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DB error';
    logError(`GET /api/overview — ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
});
