import { NextResponse } from 'next/server';
import { getMediaTree } from '@/lib/db';
import { logError, withLogging } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging('GET', '/api/media/tree', async () => {
  try {
    return NextResponse.json({ ok: true, ...getMediaTree() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DB error';
    logError(`GET /api/media/tree — ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
});
