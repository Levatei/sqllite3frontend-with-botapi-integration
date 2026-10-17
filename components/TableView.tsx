'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Database,
  Pencil,
  Search,
  SlidersHorizontal,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import { useRecords } from '@/hooks/use-records';
import { FilterPanel } from '@/components/FilterPanel';
import { SortDropdown } from '@/components/SortDropdown';
import type { FilterCond } from '@/lib/db';

function displayValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  const s = String(v);
  if (s === '' || s === 'null' || s === 'NULL') return '—';
  return s;
}

function shortValue(v: unknown): string {
  const s = displayValue(v);
  if (s.length > 32) return s.slice(0, 32) + '…';
  return s;
}

interface TableViewProps {
  table: string;
  label: string;
  columns: string[];
  connected: boolean;
  loadError: string | null;
  actionsEnabled: boolean;
  onOpenCreate: () => void;
  onEditRow: (table: string, row: Record<string, unknown>) => void;
  onDeleteRow: (table: string, row: Record<string, unknown>) => void;
  refreshKey?: number;
  /** Сообщает наверх общее количество записей (для заголовка страницы). */
  onTotalChange?: (total: number) => void;
}

export function TableView({
  table,
  label,
  columns,
  connected,
  loadError,
  actionsEnabled,
  onOpenCreate,
  onEditRow,
  onDeleteRow,
  refreshKey = 0,
  onTotalChange,
}: TableViewProps) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<string | undefined>(undefined);
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [filters, setFilters] = useState<FilterCond[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);

  const pageSize = 15;
  const { rows, total, loading, error, reload } = useRecords({
    table,
    search,
    page,
    pageSize,
    sort,
    dir,
    filters,
    enabled: connected,
    refreshKey,
  });

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    onTotalChange?.(total);
  }, [total, onTotalChange]);

  const toggleSort = (col: string) => {
    if (sort !== col) {
      setSort(col);
      setDir('asc');
    } else if (dir === 'asc') {
      setDir('desc');
    } else {
      setSort(undefined);
    }
    setPage(1);
    setSortOpen(false);
  };

  const clearSort = () => {
    setSort(undefined);
    setSortOpen(false);
  };

  const currentSort = sort;
  const currentDir = dir;

  const sortOptions = useMemo(
    () => columns.map((c) => ({ value: c, label: c })),
    [columns]
  );

  const filterFieldOptions = useMemo(
    () => columns.map((c) => ({ value: c, label: c })),
    [columns]
  );

  const appliedFilters = filters;

  const openFilterPanel = () => {
    setFilterOpen(!filterOpen);
    setSortOpen(false);
  };

  const applyDraftFilters = (draft: FilterCond[]) => {
    const clean = draft.filter((f) => f.field);
    setFilters(clean);
    setPage(1);
    setFilterOpen(false);
  };

  const resetDraftFilters = () => {
    setFilters([]);
    setPage(1);
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

  return (
    <>
      <div className="search-row">
        <div className="search-box">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder={`Поиск в ${label.toLowerCase()}...`}
          />
          <kbd>⌘ K</kbd>
        </div>
        <button className="view-button active">
          <Table2 size={16} />
        </button>
        <button className="view-button">
          <SlidersHorizontal size={16} />
        </button>
      </div>

      {!connected ? (
        <div className="empty-state">
          <div className="empty-illustration"><Database size={25} /></div>
          <h3>Подключение к базе...</h3>
          <p>{loadError ?? 'Загружаем схему SQLite.'}</p>
        </div>
      ) : rows.length === 0 && !loading ? (
        <div className="empty-state">
          <div className="empty-illustration"><Database size={25} /></div>
          <h3>Нет данных для отображения</h3>
          <p>
            {search ? 'По вашему запросу ничего не найдено.' : 'В таблице пока нет записей.'}
          </p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr>
                {columns.map((col) => (
                  <th
                    key={col}
                    onClick={() => toggleSort(col)}
                    title="Сортировать"
                    style={{
                      textAlign: 'left',
                      padding: '10px 12px',
                      borderBottom: '1px solid var(--line)',
                      whiteSpace: 'nowrap',
                      cursor: 'pointer',
                      color: sort === col ? 'var(--ink)' : '#888985',
                      background: sort === col ? '#efefeb' : 'transparent',
                    }}
                  >
                    {col}
                    {sort === col ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </th>
                ))}
                {actionsEnabled && (
                  <th
                    style={{
                      textAlign: 'right',
                      padding: '10px 12px',
                      borderBottom: '1px solid var(--line)',
                      whiteSpace: 'nowrap',
                      width: 76,
                    }}
                  >
                    Действия
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #efefeb' }}>
                  {columns.map((col) => (
                    <td
                      key={col}
                      title={displayValue(row[col])}
                      style={{
                        padding: '9px 12px',
                        whiteSpace: 'nowrap',
                        maxWidth: 220,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        color:
                          displayValue(row[col]) === '—' ? '#b3b4af' : 'inherit',
                      }}
                    >
                      {shortValue(row[col])}
                    </td>
                  ))}
                  {actionsEnabled && (
                    <td style={{ padding: '5px 12px', whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <button
                        className="view-button"
                        aria-label="Править"
                        title="Править"
                        onClick={() => onEditRow(table, row)}
                      >
                        <Pencil size={14} />
                      </button>{' '}
                      <button
                        className="view-button"
                        aria-label="Удалить"
                        title="Удалить"
                        onClick={() => onDeleteRow(table, row)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div style={{ padding: 10, fontSize: 11, color: '#888985' }}>Загрузка...</div>}
        </div>
      )}

      <div className="table-footer">
        <span>Показано {rows.length} из {total} записей</span>
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          Страница {page} из {totalPages}
          <button
            className="view-button"
            aria-label="Назад"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft size={14} />
          </button>
          <button
            className="view-button"
            aria-label="Вперед"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight size={14} />
          </button>
        </span>
      </div>

      {filterOpen && (
        <FilterPanel
          filters={filters}
          onChange={setFilters}
          onAdd={() => {
            setFilters([...filters, { field: '', op: 'contains', value: '' }]);
          }}
          onRemove={(index) => {
            setFilters(filters.filter((_, j) => j !== index));
          }}
          onApply={() => applyDraftFilters(filters)}
          onReset={resetDraftFilters}
          onClose={() => setFilterOpen(false)}
          fieldOptions={filterFieldOptions}
          open={filterOpen}
        />
      )}

      {sortOpen && (
        <SortDropdown
          options={sortOptions}
          currentSort={currentSort}
          currentDir={currentDir}
          onSelect={toggleSort}
          onClear={clearSort}
          open={sortOpen}
          onClose={() => setSortOpen(false)}
        />
      )}
    </>
  );
}
