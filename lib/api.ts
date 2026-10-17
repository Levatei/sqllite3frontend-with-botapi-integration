import type {
  FilterCond,
  ListOptions,
} from '@/lib/db';

export type { FilterCond };

interface ApiError extends Error {
  status?: number;
}

async function request(
  input: string,
  init?: RequestInit
): Promise<unknown> {
  const res = await fetch(input, { ...init, cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: ApiError = new Error(
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error?: unknown }).error)
        : `HTTP ${res.status}`
    );
    err.status = res.status;
    throw err;
  }
  return data;
}

export interface TableInfo {
  name: string;
  count: number;
  columns: Array<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
    fk?: boolean;
  }>;
}

export interface TablesResponse {
  ok: true;
  db: string;
  dbId: string;
  compatible?: boolean;
  tables: TableInfo[];
}

export interface DatabasesResponse {
  ok: true;
  active: string;
  dbs: Array<{
    id: string;
    name: string;
    tables: Array<{ name: string; count: number }>;
    error?: string;
  }>;
}

export interface RecordsResponse {
  ok: true;
  table: string;
  page: number;
  pageSize: number;
  total: number;
  rows: Record<string, unknown>[];
}

export interface OverviewResponse {
  ok: true;
  page: number;
  pageSize: number;
  total: number;
  rows: Record<string, unknown>[];
}

export interface OrdersResponse {
  ok: true;
  orders: Record<string, unknown>[];
}

export interface DbSwitchResult {
  ok: true;
  active: string;
  db: string;
}

export interface DbCreateResult {
  ok: true;
  active: string;
  db: string;
}

export async function fetchTables(): Promise<TablesResponse> {
  return request('/api/tables') as Promise<TablesResponse>;
}

export async function fetchDatabases(): Promise<DatabasesResponse> {
  return request('/api/databases') as Promise<DatabasesResponse>;
}

export async function fetchRecords(
  table: string,
  opts?: Partial<{
    search: string;
    page: number;
    pageSize: number;
    sort: string;
    dir: 'asc' | 'desc';
    filters: FilterCond[];
  }>
): Promise<RecordsResponse> {
  const params = new URLSearchParams();
  if (opts?.search) params.set('search', opts.search);
  if (opts?.page != null) params.set('page', String(opts.page));
  if (opts?.pageSize != null) params.set('pageSize', String(opts.pageSize));
  if (opts?.sort) params.set('sort', opts.sort);
  if (opts?.dir) params.set('dir', opts.dir);
  if (opts?.filters?.length) params.set('filters', JSON.stringify(opts.filters));
  return request(`/api/records?table=${encodeURIComponent(table)}&${params.toString()}`) as Promise<RecordsResponse>;
}

export async function fetchOrders(): Promise<OrdersResponse> {
  return request('/api/kanban') as Promise<OrdersResponse>;
}

export async function fetchOverview(
  opts?: Partial<{
    search: string;
    page: number;
    pageSize: number;
    sort: string;
    dir: 'asc' | 'desc';
    filters: FilterCond[];
  }>
): Promise<OverviewResponse> {
  const params = new URLSearchParams();
  if (opts?.search) params.set('search', opts.search);
  if (opts?.page != null) params.set('page', String(opts.page));
  if (opts?.pageSize != null) params.set('pageSize', String(opts.pageSize));
  if (opts?.sort) params.set('sort', opts.sort);
  if (opts?.dir) params.set('dir', opts.dir);
  if (opts?.filters?.length) params.set('filters', JSON.stringify(opts.filters));
  return request(`/api/overview?${params.toString()}`) as Promise<OverviewResponse>;
}

export async function createRecord(
  table: string,
  data: Record<string, unknown>
): Promise<{ ok: true; row: Record<string, unknown> }> {
  return request('/api/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'generic', table, data }),
  }) as Promise<{ ok: true; row: Record<string, unknown> }>;
}

export async function updateRecord(
  table: string,
  rowid: number,
  data: Record<string, unknown>
): Promise<{ ok: true; row: Record<string, unknown> }> {
  return request('/api/records', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'generic', table, rowid, data }),
  }) as Promise<{ ok: true; row: Record<string, unknown> }>;
}

export async function deleteRecord(
  table: string,
  rowid: number
): Promise<{ ok: true }> {
  return request(
    `/api/records?kind=generic&table=${encodeURIComponent(table)}&rowid=${rowid}`,
    { method: 'DELETE' }
  ) as Promise<{ ok: true }>;
}

export async function switchDb(id: string): Promise<DbSwitchResult> {
  return request('/api/databases', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  }) as Promise<DbSwitchResult>;
}

export async function uploadDb(file: File): Promise<DbCreateResult> {
  const form = new FormData();
  form.append('file', file);
  return request('/api/databases', { method: 'POST', body: form }) as Promise<DbCreateResult>;
}

export interface NewColumnDef {
  name: string;
  type: string;
  notNull?: boolean;
  pk?: boolean;
  fkTable?: string;
  fkColumn?: string;
  fkOnUpdate?: string;
  fkOnDelete?: string;
}

export interface NewTableDef {
  name: string;
  columns: NewColumnDef[];
}

export async function createDb(
  name: string,
  tables: NewTableDef[]
): Promise<DbCreateResult> {
  return request('/api/databases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'create', name, tables }),
  }) as Promise<DbCreateResult>;
}

// ---------- Медиафайлы ----------

export interface MediaItem {
  media_id: number;
  batch_id: string | null;
  model: string | null;
  order_id: number | null;
  equipment_id: number | null;
  kind: string | null;
  role: string | null;
  file_path: string;
  thumb_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  step_no: number | null;
  caption: string | null;
  source: string | null;
  created_at: string | null;
}

export interface MediaListResponse {
  ok: true;
  media: MediaItem[];
}

export interface MediaCountsData {
  total: number;
  byModel: { model: string; count: number; last_at: string | null }[];
  byEquipment: { equipment_id: number; count: number }[];
  byOrder: { order_id: number; count: number }[];
  batches: {
    batch_id: string;
    model: string | null;
    count: number;
    has_video: number;
    last_at: string | null;
  }[];
}

export interface MediaCountsResponse extends MediaCountsData {
  ok: true;
}

export async function fetchMedia(query: {
  order_id?: number;
  equipment_id?: number;
  batch_id?: string;
  model?: string;
}): Promise<MediaListResponse> {
  const params = new URLSearchParams();
  if (query.order_id != null) params.set('order_id', String(query.order_id));
  if (query.equipment_id != null) params.set('equipment_id', String(query.equipment_id));
  if (query.batch_id) params.set('batch_id', query.batch_id);
  if (query.model) params.set('model', query.model);
  return request(`/api/media?${params.toString()}`) as Promise<MediaListResponse>;
}

export async function fetchMediaCounts(): Promise<MediaCountsResponse> {
  return request('/api/media/counts') as Promise<MediaCountsResponse>;
}

export interface MediaTreeClient {
  client_id: number;
  name: string | null;
  number: string | null;
  mail: string | null;
}
export interface MediaTreeEquipment {
  equipment_id: number;
  client_id: number | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
}
export interface MediaTreeOrder {
  order_id: number;
  equipment_id: number | null;
  client_id: number | null;
  status: string | null;
  creation_date: string | null;
}
export interface MediaTreeResponse {
  ok: true;
  clients: MediaTreeClient[];
  equipment: MediaTreeEquipment[];
  orders: MediaTreeOrder[];
}

export async function fetchMediaTree(): Promise<MediaTreeResponse> {
  return request('/api/media/tree') as Promise<MediaTreeResponse>;
}

export async function uploadMedia(
  form: FormData
): Promise<{ ok: true; media: MediaItem }> {
  return request('/api/media', { method: 'POST', body: form }) as Promise<{
    ok: true;
    media: MediaItem;
  }>;
}

export async function updateMedia(
  id: number,
  data: { caption?: string | null; step_no?: number | null }
): Promise<{ ok: true; media: MediaItem }> {
  return request(`/api/media/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }) as Promise<{ ok: true; media: MediaItem }>;
}

export async function deleteMedia(id: number): Promise<{ ok: true }> {
  return request(`/api/media/${id}`, { method: 'DELETE' }) as Promise<{ ok: true }>;
}
