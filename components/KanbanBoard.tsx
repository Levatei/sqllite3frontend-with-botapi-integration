'use client';

import { useMemo, useRef, useState, type DragEvent } from 'react';
import {
  AlertCircle,
  CalendarDays,
  Coins,
  Database,
  Pencil,
  Pin,
  Plus,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';

interface KanbanBoardProps {
  orders: Record<string, unknown>[];
  columns: string[];
  loading: boolean;
  error: string | null;
  connected: boolean;
  loadError: string | null;
  onMove: (order: Record<string, unknown>, status: string) => void;
  onEdit: (order: Record<string, unknown>) => void;
  onDelete: (order: Record<string, unknown>) => void;
  onAddColumn: (name?: string) => void;
  onRemoveColumn: (name: string) => void;
  onOpenCreate: () => void;
}

function text(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s === 'null' || s === 'NULL') return '';
  return s;
}

const ACCENTS = ['#8bcf55', '#e0b341', '#4f9dd8', '#b07fe0', '#e07f7f', '#4fc6b0'];

export function KanbanBoard({
  orders,
  columns,
  loading,
  error,
  connected,
  loadError,
  onMove,
  onEdit,
  onDelete,
  onAddColumn,
  onRemoveColumn,
  onOpenCreate,
}: KanbanBoardProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [hoverCol, setHoverCol] = useState<string | null>(null);
  const dragEndedAt = useRef(0);

  const { byStatus, extraColumns } = useMemo(() => {
    const map = new Map<string, Record<string, unknown>[]>();
    for (const col of columns) map.set(col, []);
    const extra: string[] = [];
    for (const o of orders) {
      const status = text(o.status).trim() || 'Без статуса';
      if (!map.has(status)) {
        map.set(status, []);
        if (!extra.includes(status)) extra.push(status);
      }
      map.get(status)!.push(o);
    }
    return { byStatus: map, extraColumns: extra };
  }, [orders, columns]);

  const renderColumns = [...columns, ...extraColumns];

  const handleDrop = (status: string, e: DragEvent) => {
    const rowid = e.dataTransfer.getData('text/plain') || dragId;
    setDragId(null);
    setHoverCol(null);
    if (!rowid) return;
    const order = orders.find((o) => String(o._rowid) === rowid);
    if (!order) return;
    if (text(order.status).trim() === status) return;
    onMove(order, status);
  };

  if (error) {
    return (
      <div className="empty-state">
        <div className="empty-illustration"><AlertCircle size={25} /></div>
        <h3>Ошибка загрузки</h3>
        <p>{error}</p>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="empty-state">
        <div className="empty-illustration"><Database size={25} /></div>
        <h3>Подключение к базе...</h3>
        <p>{loadError ?? 'Загружаем схему SQLite.'}</p>
      </div>
    );
  }

  return (
    <div className="kanban">
      <div className="kanban-board">
        {renderColumns.map((status, idx) => {
          const cards = byStatus.get(status) ?? [];
          const isConfigured = columns.includes(status);
          return (
            <div
              key={status}
              className={`kanban-col ${hoverCol === status ? 'drop-target' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (hoverCol !== status) setHoverCol(status);
              }}
              onDragLeave={() => setHoverCol((c) => (c === status ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(status, e);
              }}
            >
              <div className="kanban-col-head">
                <span
                  className="kanban-dot"
                  style={{ background: ACCENTS[idx % ACCENTS.length] }}
                />
                <strong>{status}</strong>
                <span className="kanban-count">{cards.length}</span>
                {isConfigured ? (
                  <button
                    className="kanban-col-btn"
                    title="Удалить статус"
                    aria-label={`Удалить статус ${status}`}
                    onClick={() => onRemoveColumn(status)}
                  >
                    <X size={13} />
                  </button>
                ) : (
                  <button
                    className="kanban-col-btn"
                    title="Добавить статус в доску"
                    aria-label={`Добавить статус ${status} в доску`}
                    onClick={() => onAddColumn(status)}
                  >
                    <Pin size={13} />
                  </button>
                )}
              </div>

              <div className="kanban-cards">
                {cards.map((o) => {
                  const id = String(o._rowid);
                  const client = text(o.client_name) || 'Без клиента';
                  const equip = [text(o.manufacturer), text(o.model)]
                    .filter(Boolean)
                    .join(' ');
                  const serial = text(o.serial_number);
                  return (
                    <article
                      key={id}
                      className={`kanban-card ${dragId === id ? 'dragging' : ''}`}
                      draggable
                      role="button"
                      tabIndex={0}
                      title="Открыть заявку"
                      onClick={() => {
                        if (Date.now() - dragEndedAt.current < 250) return;
                        onEdit(o);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onEdit(o);
                        }
                      }}
                      onDragStart={(e) => {
                        setDragId(id);
                        e.dataTransfer.setData('text/plain', id);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={() => {
                        dragEndedAt.current = Date.now();
                        setDragId(null);
                        setHoverCol(null);
                      }}
                    >
                      <div className="kanban-card-head">
                        <strong title={client}>{client}</strong>
                        <div className="kanban-card-actions">
                          <button
                            className="kanban-card-btn"
                            title="Править"
                            aria-label="Править заявку"
                            onClick={(e) => {
                              e.stopPropagation();
                              onEdit(o);
                            }}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            className="kanban-card-btn danger"
                            title="Удалить"
                            aria-label="Удалить заявку"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDelete(o);
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      {equip && (
                        <div className="kanban-card-line">
                          <Wrench size={13} />
                          <span>
                            {equip}
                            {serial ? ` · ${serial}` : ''}
                          </span>
                        </div>
                      )}

                      {text(o.diagnostic_results) && (
                        <div className="kanban-card-diag">
                          <span className="kanban-card-diag-label">Результат диагностики</span>
                          <p>{text(o.diagnostic_results)}</p>
                        </div>
                      )}

                      <div className="kanban-card-foot">
                        {text(o.creation_date) && (
                          <span className="kanban-badge">
                            <CalendarDays size={12} />
                            {text(o.creation_date)}
                          </span>
                        )}
                        {text(o.price) && (
                          <span className="kanban-badge price">
                            <Coins size={12} />
                            {text(o.price)}
                          </span>
                        )}
                        <span className="kanban-order-id">
                          #{text(o.order_id)}
                        </span>
                      </div>
                    </article>
                  );
                })}

                {cards.length === 0 && (
                  <div className="kanban-empty">Перетащите сюда заявку</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {orders.length === 0 && !loading && (
        <div className="kanban-blank">
          <p>Заявок пока нет.</p>
          <button className="button primary" onClick={onOpenCreate}>
            <Plus size={16} /> Создать заявку
          </button>
        </div>
      )}
      {loading && <div className="kanban-loading">Загрузка...</div>}
    </div>
  );
}
