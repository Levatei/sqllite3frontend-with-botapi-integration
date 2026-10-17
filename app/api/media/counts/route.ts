import { NextResponse } from 'next/server';
import { getMediaCounts } from '@/lib/db';
import { logError, withLogging } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging('GET', '/api/media/counts', async () => {
  try {
    return NextResponse.json({ ok: true, ...getMediaCounts() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DB error';
    logError(`GET /api/media/counts — ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
});
