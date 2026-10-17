'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchRecords,
  type RecordsResponse,
  type FilterCond,
} from '@/lib/api';

interface UseRecordsOptions {
  table: string;
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  filters?: FilterCond[];
  enabled?: boolean;
  refreshKey?: number;
}

export function useRecords({
  table,
  search = '',
  page = 1,
  pageSize = 15,
  sort,
  dir = 'asc',
  filters = [],
  enabled = true,
  refreshKey = 0,
}: UseRecordsOptions) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancelled = useRef(false);

  const load = useCallback(async () => {
    if (!enabled || !table) return;
    // refreshKey намеренно в зависимостях: смена значения пересоздаёт load,
    // из-за чего эффект ниже перезапускает загрузку.
    void refreshKey;
    cancelled.current = false;
    setLoading(true);
    setError(null);
    try {
      const data = (await fetchRecords(table, {
        search,
        page,
        pageSize,
        sort,
        dir,
        filters,
      })) as RecordsResponse;
      if (!cancelled.current) {
        setRows(data.rows);
        setTotal(data.total);
      }
    } catch (e) {
      if (!cancelled.current) setError(e instanceof Error ? e.message : 'Ошибка загрузки');
    } finally {
      if (!cancelled.current) setLoading(false);
    }
  }, [enabled, table, search, page, pageSize, sort, dir, filters, refreshKey]);

  useEffect(() => {
    cancelled.current = false;
    load();
    return () => {
      cancelled.current = true;
    };
  }, [load]);

  return { rows, total, loading, error, reload: load };
}
