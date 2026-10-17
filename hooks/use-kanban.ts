'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { updateRecord } from '@/lib/api';

export const DEFAULT_STATUSES = [
  'Новая Заявка',
  'Диагностика',
  'В работе',
  'Готово к выдаче',
  'Выдано',
];

interface UseKanbanOptions {
  /** Идентификатор активной базы — ключ для localStorage. */
  activeId: string;
  orders: Record<string, unknown>[];
  notify: (message: string) => void;
  /** Вызывается после изменения данных, чтобы перезагрузить доску. */
  onChanged: () => void;
}

/**
 * Состояние канбан-доски: колонки (с сохранением в localStorage),
 * перенос карточки (меняет orders.status) и диалоги управления колонками.
 */
export function useKanban({ activeId, orders, notify, onChanged }: UseKanbanOptions) {
  const [columns, setColumns] = useState<string[]>(DEFAULT_STATUSES);
  const [statusPromptOpen, setStatusPromptOpen] = useState(false);
  const [removeColumnTarget, setRemoveColumnTarget] = useState<string | null>(null);

  const storageKey = `kanban:${activeId || 'default'}`;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr) && arr.length > 0) {
          setColumns(arr.map(String));
          return;
        }
      }
    } catch {
      /* ignore */
    }
    setColumns(DEFAULT_STATUSES);
  }, [storageKey]);

  const persist = useCallback(
    (cols: string[]) => {
      setColumns(cols);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(cols));
      } catch {
        /* ignore */
      }
    },
    [storageKey]
  );

  const moveOrder = useCallback(
    async (order: Record<string, unknown>, status: string) => {
      const rowid = Number(order._rowid);
      if (!Number.isFinite(rowid)) return;
      try {
        await updateRecord('orders', rowid, { status });
        notify(`Статус изменён: ${status}`);
        onChanged();
      } catch (e) {
        notify(e instanceof Error ? e.message : 'Ошибка обновления статуса');
      }
    },
    [notify, onChanged]
  );

  const addColumn = useCallback(
    (name?: string) => {
      const value = (name ?? '').trim();
      if (!value) {
        // Вызов из кнопки в шапке — открываем стилизованный диалог
        setStatusPromptOpen(true);
        return;
      }
      if (columns.includes(value)) {
        notify(`Статус «${value}» уже есть на доске.`);
        return;
      }
      persist([...columns, value]);
      notify(`Статус «${value}» добавлен.`);
    },
    [columns, persist, notify]
  );

  const requestRemoveColumn = useCallback((name: string) => {
    setRemoveColumnTarget(name);
  }, []);

  const confirmRemoveColumn = useCallback(() => {
    if (!removeColumnTarget) return;
    persist(columns.filter((s) => s !== removeColumnTarget));
    notify(`Статус «${removeColumnTarget}» убран с доски.`);
    setRemoveColumnTarget(null);
  }, [columns, removeColumnTarget, persist, notify]);

  const cancelRemoveColumn = useCallback(() => setRemoveColumnTarget(null), []);

  const removeColumnCount = removeColumnTarget
    ? orders.filter((o) => String(o.status ?? '').trim() === removeColumnTarget).length
    : 0;

  const activeCards = useMemo(() => {
    const done = columns[columns.length - 1];
    return orders.filter((o) => String(o.status ?? '').trim() !== done).length;
  }, [orders, columns]);

  return {
    columns,
    moveOrder,
    addColumn,
    requestRemoveColumn,
    confirmRemoveColumn,
    cancelRemoveColumn,
    removeColumnTarget,
    removeColumnCount,
    activeCards,
    statusPromptOpen,
    setStatusPromptOpen,
  };
}
