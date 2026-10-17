'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  Code2,
  Database,
  Images,
  LayoutDashboard,
  Plus,
  RefreshCw,
  Settings2,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { fetchTables } from '@/lib/api';
import type { TableInfo } from '@/lib/api';

interface Section {
  id: string;
  label: string;
  icon: React.ElementType;
  table: string | null;
}

const STANDARD_META: Record<string, { label: string; icon: React.ElementType }> = {
  clients: { label: 'Клиенты', icon: Users },
  equipment: { label: 'Оборудование', icon: Boxes },
  orders: { label: 'Заказы', icon: Wrench },
};

interface SidebarProps {
  activeSection: string;
  onSelectSection: (id: string) => void;
  connected: boolean;
  dbLabel: string;
  loadError: string | null;
  onRefresh: () => void;
  compatible: boolean;
  onAddDb: () => void;
  homeCount?: number;
  mediaCount?: number;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}

export function Sidebar({
  activeSection,
  onSelectSection,
  connected,
  dbLabel,
  loadError,
  onRefresh,
  compatible,
  onAddDb,
  homeCount,
  mediaCount,
  mobileOpen = false,
  onCloseMobile,
}: SidebarProps) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);

  const loadTables = useCallback(async () => {
    setTablesLoading(true);
    try {
      const data = await fetchTables();
      setTables(data.tables);
    } catch {
      /* handled by connection status */
    } finally {
      setTablesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connected) loadTables();
  }, [connected, loadTables]);

  const sections: Section[] = useMemo(() => {
    const list: Section[] = [];
    if (compatible) list.push({ id: 'home', label: 'Главная', icon: LayoutDashboard, table: null });
    for (const t of tables) {
      const std = STANDARD_META[t.name];
      list.push({ id: t.name, label: std?.label ?? t.name, icon: std?.icon ?? Boxes, table: t.name });
    }
    if (compatible) list.push({ id: 'media', label: 'Медиафайлы', icon: Images, table: null });
    return list;
  }, [tables, compatible]);

  const tableCount = (id: string) => {
    if (id === 'home') return homeCount ?? '—';
    if (id === 'media') return mediaCount ?? '—';
    return tables.find((t) => t.name === id)?.count ?? '—';
  };

  return (
    <>
      <aside className="rail" aria-label="Основная навигация">
        <div className="brand-mark"><Database size={19} strokeWidth={2.4} /></div>
        <nav className="rail-nav">
          {sections.slice(0, 5).map((s) => {
            const Icon = s.icon as React.ElementType;
            return (
              <button
                key={s.id}
                className={`rail-item ${activeSection === s.id ? 'active' : ''}`}
                aria-label={s.label}
                onClick={() => onSelectSection(s.id)}
              >
                <Icon size={18} />
              </button>
            );
          })}
          {/* SQL-клиент скрыт (не удалён — может пригодиться) */}
          {false && (
            <button
              className="rail-item"
              aria-label="SQL-клиент"
              onClick={() => {
                // noop — handled by parent notice
              }}
            >
              <Code2 size={18} />
            </button>
          )}
        </nav>
        <div className="rail-bottom">
          <button className="rail-item" aria-label="Настройки">
            <Settings2 size={18} />
          </button>
          <div className="avatar">DB</div>
        </div>
      </aside>

      <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
        <div className="sidebar-topline">
          <div>
            <p className="eyebrow">Workspace</p>
            <h1>Data console</h1>
          </div>
          <button
            className="icon-button mobile-menu"
            aria-label="Закрыть меню"
            onClick={() => onCloseMobile?.()}
          >
            <X size={18} />
          </button>
        </div>

        <div className="connection-card">
          <span
            className={`status-dot ${connected ? 'online' : ''}`}
          />
          <div>
            <strong>SQLite database</strong>
            <span>
              {connected ? `Подключена · ${dbLabel}` : loadError ?? 'Подключение...'}
            </span>
          </div>
          <button
            className="tiny-action"
            aria-label="Обновить подключение"
            onClick={onRefresh}
          >
            <RefreshCw size={14} />
          </button>
        </div>

        <div className="sidebar-section-header">
          <span>Tables</span>
          <button
            className="tiny-action"
            aria-label="Добавить таблицу"
            onClick={onAddDb}
          >
            <Plus size={15} />
          </button>
        </div>

        <div className="table-list">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`table-nav ${activeSection === id ? 'selected' : ''}`}
              onClick={() => {
                onSelectSection(id);
                onCloseMobile?.();
              }}
            >
              <Icon size={16} />
              <span>{label}</span>
              <span className="table-count">{tableCount(id)}</span>
            </button>
          ))}
        </div>

        <div className="status-list">
          <div className="status-row">
            <span className={`status-dot ${connected ? 'online' : ''}`} />
            <span className="status-label">База</span>
            <span className="status-value" title={dbLabel}>
              {connected ? dbLabel : '—'}
            </span>
          </div>
          <div className="status-row">
            <span className={`status-dot ${connected && tables.length ? 'online' : ''}`} />
            <span className="status-label">Таблицы</span>
            <span className="status-value">{connected ? tables.length : '—'}</span>
          </div>
          <div className="status-row">
            <span className={`status-dot ${connected ? 'online' : ''}`} />
            <span className="status-label">API</span>
            <span className="status-value">{connected ? 'Online' : 'Offline'}</span>
          </div>
        </div>

      </aside>

      {mobileOpen && (
        <div
          className="sidebar-overlay"
          aria-hidden="true"
          onClick={() => onCloseMobile?.()}
        />
      )}
    </>
  );
}
