'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchMedia,
  fetchMediaCounts,
  fetchMediaTree,
  type MediaCountsData,
  type MediaItem,
  type MediaTreeClient,
  type MediaTreeEquipment,
  type MediaTreeOrder,
} from '@/lib/api';

interface UseMediaCatalogOptions {
  enabled?: boolean;
  refreshKey?: number;
}

/**
 * Справочники для дерева медиа: клиенты, оборудование, заявки и счётчики.
 * Сами медиафайлы здесь не грузятся — только при выборе узла (useMediaList).
 */
export function useMediaCatalog({ enabled = true, refreshKey = 0 }: UseMediaCatalogOptions = {}) {
  const [clients, setClients] = useState<MediaTreeClient[]>([]);
  const [equipment, setEquipment] = useState<MediaTreeEquipment[]>([]);
  const [orders, setOrders] = useState<MediaTreeOrder[]>([]);
  const [counts, setCounts] = useState<MediaCountsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancelled = useRef(false);

  const load = useCallback(async () => {
    if (!enabled) return;
    void refreshKey;
    cancelled.current = false;
    setLoading(true);
    setError(null);
    try {
      const [tree, mc] = await Promise.all([fetchMediaTree(), fetchMediaCounts()]);
      if (cancelled.current) return;
      setClients(tree.clients);
      setEquipment(tree.equipment);
      setOrders(tree.orders);
      setCounts(mc);
    } catch (err) {
      if (!cancelled.current) setError(err instanceof Error ? err.message : 'Ошибка загрузки');
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

  return { clients, equipment, orders, counts, loading, error, reload: load };
}

interface UseMediaListOptions {
  enabled?: boolean;
  orderId?: number | null;
  equipmentId?: number | null;
  batchId?: string | null;
  model?: string | null;
  refreshKey?: number;
}

/** Медиафайлы конкретного узла — грузятся только когда узел выбран. */
export function useMediaList({
  enabled = true,
  orderId = null,
  equipmentId = null,
  batchId = null,
  model = null,
  refreshKey = 0,
}: UseMediaListOptions = {}) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancelled = useRef(false);

  const load = useCallback(async () => {
    if (!enabled) {
      setItems([]);
      return;
    }
    void refreshKey;
    cancelled.current = false;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMedia({
        order_id: orderId ?? undefined,
        equipment_id: equipmentId ?? undefined,
        batch_id: batchId ?? undefined,
        model: model ?? undefined,
      });
      if (!cancelled.current) setItems(data.media);
    } catch (e) {
      if (!cancelled.current) setError(e instanceof Error ? e.message : 'Ошибка загрузки');
    } finally {
      if (!cancelled.current) setLoading(false);
    }
  }, [enabled, orderId, equipmentId, batchId, model, refreshKey]);

  useEffect(() => {
    cancelled.current = false;
    load();
    return () => {
      cancelled.current = true;
    };
  }, [load]);

  return { items, loading, error, reload: load };
}
