'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Images,
  Search,
  Wrench,
} from 'lucide-react';
import { useMediaCatalog } from '@/hooks/use-media';
import {
  type MediaTreeEquipment,
  type MediaTreeOrder,
} from '@/lib/api';
import { MediaGallery, type MediaSelection } from '@/components/MediaGallery';

interface MediaBrowserProps {
  refreshKey: number;
  onChanged: () => void;
  onNotice: (msg: string) => void;
}

function equipmentLabel(eq: MediaTreeEquipment): string {
  const label = `${String(eq.manufacturer ?? '')} ${String(eq.model ?? '')}`.trim();
  const serial = eq.serial_number ? ` · ${String(eq.serial_number)}` : '';
  return (label || `Насос #${String(eq.equipment_id)}`) + serial;
}

function nameOrDash(value: unknown): string {
  const s = value == null ? '' : String(value).trim();
  return s === '' || s === 'null' ? '' : s;
}

export function MediaBrowser({ refreshKey, onChanged, onNotice }: MediaBrowserProps) {
  const { clients, equipment, orders, counts, loading, error } = useMediaCatalog({
    enabled: true,
    refreshKey,
  });

  const [search, setSearch] = useState('');
  const [hideEmpty, setHideEmpty] = useState(false);
  const [selection, setSelection] = useState<MediaSelection | null>(null);
  const [openClients, setOpenClients] = useState<Set<number>>(new Set());
  const [openEquipment, setOpenEquipment] = useState<Set<number>>(new Set());

  const q = search.trim().toLowerCase();
  const matches = useCallback(
    (...vals: unknown[]) =>
      !q || vals.some((v) => String(v ?? '').toLowerCase().includes(q)),
    [q]
  );

  const equipmentCounts = useMemo(() => {
    const map = new Map<number, number>();
    for (const row of counts?.byEquipment ?? []) map.set(Number(row.equipment_id), Number(row.count));
    return map;
  }, [counts]);

  const orderCounts = useMemo(() => {
    const map = new Map<number, number>();
    for (const row of counts?.byOrder ?? []) map.set(Number(row.order_id), Number(row.count));
    return map;
  }, [counts]);

  // Индексы «клиент → насосы» и «насос → заявки»: строим один раз, а не на каждый рендер.
  const equipmentByClient = useMemo(() => {
    const map = new Map<number, MediaTreeEquipment[]>();
    for (const e of equipment) {
      const key = Number(e.client_id);
      const arr = map.get(key);
      if (arr) arr.push(e);
      else map.set(key, [e]);
    }
    return map;
  }, [equipment]);

  const ordersByEquipment = useMemo(() => {
    const map = new Map<number, MediaTreeOrder[]>();
    for (const o of orders) {
      const key = Number(o.equipment_id);
      const arr = map.get(key);
      if (arr) arr.push(o);
      else map.set(key, [o]);
    }
    return map;
  }, [orders]);

  const batches = useMemo(
    () => (counts?.batches ?? []).filter((b) => matches(b.model, b.batch_id)),
    [counts, matches]
  );

  // Есть ли под узлом хоть один медиафайл. Заявки учитываем отдельно:
  // медиа старого образца может быть привязано только к заказу.
  const equipmentHasMedia = useCallback(
    (equipmentId: number) => {
      if ((equipmentCounts.get(equipmentId) ?? 0) > 0) return true;
      return (ordersByEquipment.get(equipmentId) ?? []).some(
        (o) => (orderCounts.get(Number(o.order_id)) ?? 0) > 0
      );
    },
    [equipmentCounts, ordersByEquipment, orderCounts]
  );

  const clientHasMedia = useCallback(
    (clientId: number) =>
      (equipmentByClient.get(clientId) ?? []).some((e) =>
        equipmentHasMedia(Number(e.equipment_id))
      ),
    [equipmentByClient, equipmentHasMedia]
  );

  const visibleClients = useMemo(
    () =>
      clients.filter(
        (c) =>
          (!hideEmpty || clientHasMedia(Number(c.client_id))) &&
          (matches(c.name, c.number, c.mail) ||
            (equipmentByClient.get(Number(c.client_id)) ?? []).some((e) =>
              matches(e.manufacturer, e.model, e.serial_number)
            ))
      ),
    [clients, equipmentByClient, matches, hideEmpty, clientHasMedia]
  );

  const equipmentFor = useCallback(
    (clientId: unknown) => equipmentByClient.get(Number(clientId)) ?? [],
    [equipmentByClient]
  );

  const ordersFor = useCallback(
    (equipmentId: number) => ordersByEquipment.get(equipmentId) ?? [],
    [ordersByEquipment]
  );

  const toggleClient = useCallback((id: number) => {
    setOpenClients((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleEquipment = useCallback((id: number) => {
    setOpenEquipment((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectBatch = useCallback((batchId: string, model: string | null) => {
    setSelection({ type: 'batch', id: batchId, label: model || 'Пачка без названия', model });
  }, []);

  const selectEquipment = useCallback((eq: MediaTreeEquipment) => {
    setSelection({
      type: 'equipment',
      id: Number(eq.equipment_id),
      label: equipmentLabel(eq),
      model: (eq.model as string) ?? null,
    });
  }, []);

  const selectOrder = useCallback((order: MediaTreeOrder, eq: MediaTreeEquipment) => {
    setSelection({
      type: 'order',
      id: Number(order.order_id),
      label: `Заявка #${String(order.order_id)} · ${equipmentLabel(eq)}`,
      model: (eq.model as string) ?? null,
    });
  }, []);

  const isSelected = (type: MediaSelection['type'], id: number | string) =>
    selection?.type === type && String(selection.id) === String(id);

  return (
    <div className="data-layout media-layout">
      <aside className="data-panel media-tree">
        <div className="search-row">
          <div className="search-box">
            <Search size={14} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по клиентам и насосам"
            />
          </div>
        </div>
        <label className="media-tree-check">
          <input
            type="checkbox"
            checked={hideEmpty}
            onChange={(e) => setHideEmpty(e.target.checked)}
          />
          <span>Скрыть без медиафайлов</span>
        </label>

        <div className="media-tree-scroll">
          <div className="media-tree-heading">
            <Images size={13} /> По моделям
          </div>
          {batches.length === 0 ? (
            <div className="media-tree-empty">
              {loading ? 'Загрузка…' : 'Пока нет пачек из бота'}
            </div>
          ) : (
            batches.map((b) => (
              <button
                key={b.batch_id}
                className={`media-tree-item ${isSelected('batch', b.batch_id) ? 'selected' : ''}`}
                onClick={() => selectBatch(b.batch_id, b.model)}
              >
                <Images size={15} />
                <span className="media-tree-label">{b.model || 'Без названия'}</span>
                <span className="media-tree-count">{b.count}</span>
              </button>
            ))
          )}

          <div className="media-tree-heading">
            <Boxes size={13} /> По клиентам
          </div>
          {visibleClients.length === 0 ? (
            <div className="media-tree-empty">
              {loading ? 'Загрузка…' : error ?? 'Ничего не найдено'}
            </div>
          ) : (
            visibleClients.map((c) => {
              const cid = Number(c.client_id);
              const open = q ? true : openClients.has(cid);
              const allEqs = equipmentFor(c.client_id);
              const eqs = hideEmpty
                ? allEqs.filter((e) => equipmentHasMedia(Number(e.equipment_id)))
                : allEqs;
              return (
                <div key={cid} className="media-tree-group">
                  <div className="media-tree-row">
                    <button
                      className="media-tree-toggle"
                      onClick={() => toggleClient(cid)}
                      aria-label="Развернуть клиента"
                    >
                      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <button className="media-tree-label-btn" onClick={() => toggleClient(cid)}>
                      <span className="media-tree-label">{nameOrDash(c.name) || 'Без названия'}</span>
                      <span className="media-tree-count">{eqs.length}</span>
                    </button>
                  </div>

                  {open &&
                    eqs.map((eq) => {
                      const eid = Number(eq.equipment_id);
                      const eOpen = q ? true : openEquipment.has(eid);
                      const allOds = ordersFor(eid);
                      const ods = hideEmpty
                        ? allOds.filter((o) => (orderCounts.get(Number(o.order_id)) ?? 0) > 0)
                        : allOds;
                      const cnt = equipmentCounts.get(eid) ?? 0;
                      return (
                        <div key={eid} className="media-tree-sub">
                          <div className="media-tree-row level-2">
                            <button
                              className="media-tree-toggle"
                              onClick={() => toggleEquipment(eid)}
                              disabled={ods.length === 0}
                              aria-label="Развернуть заявки"
                            >
                              {ods.length === 0 ? (
                                <span className="media-tree-dot" />
                              ) : eOpen ? (
                                <ChevronDown size={14} />
                              ) : (
                                <ChevronRight size={14} />
                              )}
                            </button>
                            <button
                              className={`media-tree-label-btn ${isSelected('equipment', eid) ? 'selected' : ''}`}
                              onClick={() => selectEquipment(eq)}
                            >
                              <span className="media-tree-label">{equipmentLabel(eq)}</span>
                              {cnt > 0 && <span className="media-tree-count">{cnt}</span>}
                            </button>
                          </div>

                          {eOpen &&
                            ods.map((o) => {
                              const oid = Number(o.order_id);
                              const ocnt = orderCounts.get(oid) ?? 0;
                              return (
                                <button
                                  key={oid}
                                  className={`media-tree-item level-3 ${isSelected('order', oid) ? 'selected' : ''}`}
                                  onClick={() => selectOrder(o, eq)}
                                >
                                  <Wrench size={13} />
                                  <span className="media-tree-label">
                                    Заявка #{oid}
                                    {nameOrDash(o.status) ? ` · ${nameOrDash(o.status)}` : ''}
                                  </span>
                                  {ocnt > 0 && <span className="media-tree-count">{ocnt}</span>}
                                </button>
                              );
                            })}
                        </div>
                      );
                    })}
                </div>
              );
            })
          )}
        </div>
      </aside>

      <div className="media-gallery-wrap">
        {selection ? (
          <MediaGallery
            key={`${selection.type}:${selection.id}`}
            selection={selection}
            refreshKey={refreshKey}
            onChanged={onChanged}
            onNotice={onNotice}
          />
        ) : (
          <section className="data-panel">
            <div className="empty-state">
              <div className="empty-illustration"><Images size={25} /></div>
              <h3>Выберите насос или заказ</h3>
              <p>Медиафайлы загружаются только после выбора узла слева.</p>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
