'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchOrders } from '@/lib/api';

interface UseOrdersOptions {
  enabled?: boolean;
  refreshKey?: number;
}

export function useOrders({ enabled = true, refreshKey = 0 }: UseOrdersOptions = {}) {
  const [orders, setOrders] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancelled = useRef(false);

  const load = useCallback(async () => {
    if (!enabled) return;
    // refreshKey намеренно в зависимостях: смена значения пересоздаёт load,
    // из-за чего эффект ниже перезапускает загрузку.
    void refreshKey;
    cancelled.current = false;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchOrders();
      if (!cancelled.current) setOrders(data.orders ?? []);
    } catch (e) {
      if (!cancelled.current) setError(e instanceof Error ? e.message : 'Ошибка загрузки');
    } finally {
      if (!cancelled.current) setLoading(false);
    }
  }, [enabled, refreshKey]);

  useEffect(() => {
    cancelled.current = false;
    load();
    return () => {
      cancelled.current = true;
    };
  }, [load]);

  return { orders, loading, error, reload: load };
}
