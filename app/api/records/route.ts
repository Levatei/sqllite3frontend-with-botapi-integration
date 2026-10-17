import { NextResponse } from 'next/server';
import {
  genericDelete,
  genericInsert,
  genericUpdate,
  isHiddenTable,
  listRows,
  parseFilters,
  tableExists,
} from '@/lib/db';
import { logError, logInfo, withLogging } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging('GET', '/api/records', async (req: Request) => {
  try {
    const url = new URL(req.url);
    const tableParam = url.searchParams.get('table') ?? '';
    if (!tableExists(tableParam) || isHiddenTable(tableParam)) {
      return NextResponse.json(
        { ok: false, error: 'Unknown table.' },
        { status: 400 }
      );
    }
    const search = url.searchParams.get('search') ?? '';
    const page = Number(url.searchParams.get('page') ?? '1') || 1;
    const pageSize = Number(url.searchParams.get('pageSize') ?? '20') || 20;
    const sort = url.searchParams.get('sort') ?? undefined;
    const dir = url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc';
    const filters = parseFilters(url.searchParams.get('filters'));

    const { rows, total } = listRows(tableParam, { search, page, pageSize, sort, dir, filters });
    return NextResponse.json({
      ok: true,
      table: tableParam,
      page: Math.max(1, Math.floor(page)),
      pageSize: Math.min(100, Math.max(1, Math.floor(pageSize))),
      total,
      rows,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DB error';
    logError(`GET /api/records — ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
});

export const POST = withLogging('POST', '/api/records', async (req: Request) => {
  try {
    const body = (await req.json()) as { kind?: string; table?: string; data?: Record<string, unknown> };
    if (body.kind === 'generic') {
      const table = String(body.table ?? '');
      if (isHiddenTable(table)) {
        return NextResponse.json({ ok: false, error: 'Unknown table.' }, { status: 400 });
      }
      const { __table, _rowid, ...rest } = body.data ?? {};
      void __table;
      void _rowid;
      const row = genericInsert(table, rest as Record<string, unknown>);
      logInfo(`INSERT ${table}`, { row });
      return NextResponse.json({ ok: true, row }, { status: 201 });
    }
    return NextResponse.json(
      { ok: false, error: 'Unknown kind. Use "generic".' },
      { status: 400 }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DB error';
    logError(`POST /api/records — ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
});

export const PUT = withLogging('PUT', '/api/records', async (req: Request) => {
  try {
    const body = (await req.json()) as { kind?: string; table?: string; rowid?: number; data?: Record<string, unknown> };
    if (body.kind === 'generic') {
      if (!body.table || body.rowid === undefined || body.rowid === null) {
        return NextResponse.json({ ok: false, error: 'Нужно: table и rowid.' }, { status: 400 });
      }
      if (isHiddenTable(body.table)) {
        return NextResponse.json({ ok: false, error: 'Unknown table.' }, { status: 400 });
      }
      const { _rowid, ...rest } = body.data ?? {};
      void _rowid;
      const row = genericUpdate(body.table, Number(body.rowid), rest as Record<string, unknown>);
      logInfo(`UPDATE ${body.table} #${body.rowid}`, { row });
      return NextResponse.json({ ok: true, row });
    }
    return NextResponse.json(
      { ok: false, error: 'Unknown kind. Use "generic".' },
      { status: 400 }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DB error';
    logError(`PUT /api/records — ${msg}`);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: /не найдена/.test(msg) ? 404 : 400 }
    );
  }
});

export const DELETE = withLogging('DELETE', '/api/records', async (req: Request) => {
  try {
    const url = new URL(req.url);
    if (url.searchParams.get('kind') === 'generic') {
      const table = url.searchParams.get('table') ?? '';
      const rowid = Number(url.searchParams.get('rowid'));
      if (!table || !Number.isFinite(rowid) || isHiddenTable(table)) {
        return NextResponse.json({ ok: false, error: 'Нужны table и rowid.' }, { status: 400 });
      }
      genericDelete(table, rowid);
      logInfo(`DELETE ${table} #${rowid}`);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ ok: false, error: 'Unknown kind.' }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'DB error';
    logError(`DELETE /api/records — ${msg}`);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: /не найдена/.test(msg) ? 404 : 400 }
    );
  }
});
