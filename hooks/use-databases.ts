'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchDatabases,
  switchDb,
  type DatabasesResponse,
} from '@/lib/api';

export function useDatabases() {
  const [dbs, setDbs] = useState<DatabasesResponse['dbs']>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancelled = useRef(false);

  const load = useCallback(async () => {
    cancelled.current = false;
    setLoading(true);
    setError(null);
    try {
      const data = (await fetchDatabases()) as DatabasesResponse;
      if (!cancelled.current) {
        setDbs(data.dbs);
        setActiveId(data.active);
      }
    } catch (e) {
      if (!cancelled.current) setError(e instanceof Error ? e.message : 'Ошибка загрузки');
    } finally {
      if (!cancelled.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    cancelled.current = false;
    load();
    return () => {
      cancelled.current = true;
    };
  }, [load]);

  const switchDatabase = useCallback(async (id: string) => {
    try {
      const data = (await switchDb(id)) as { ok: boolean; db?: string };
      if (!data.ok) throw new Error('Ошибка переключения');
      setActiveId(id);
      await load();
      return data.db ?? id;
    } catch (e) {
      throw e instanceof Error ? e : new Error('Ошибка переключения базы');
    }
  }, [load]);

  return { dbs, activeId, loading, error, reload: load, switchDatabase };
}
