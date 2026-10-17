'use client';

import { useCallback } from 'react';
import { Plus, X } from 'lucide-react';
import { Select } from '@/components/Select';
import type { FilterCond } from '@/lib/db';

interface FilterPanelProps {
  filters: FilterCond[];
  onChange: (filters: FilterCond[]) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onApply: () => void;
  onReset: () => void;
  onClose: () => void;
  fieldOptions: Array<{ value: string; label: string }>;
  open: boolean;
}

export function FilterPanel({
  filters,
  onChange,
  onAdd,
  onRemove,
  onApply,
  onReset,
  onClose,
  fieldOptions,
  open,
}: FilterPanelProps) {
  const handleFieldChange = useCallback(
    (index: number, value: string) => {
      onChange(
        filters.map((f, i) =>
          i === index ? { ...f, field: value } : f
        )
      );
    },
    [filters, onChange]
  );

  const handleOpChange = useCallback(
    (index: number, value: FilterCond['op']) => {
      onChange(
        filters.map((f, i) =>
          i === index ? { ...f, op: value, value: '' } : f
        )
      );
    },
    [filters, onChange]
  );

  const handleValueChange = useCallback(
    (index: number, value: string) => {
      onChange(
        filters.map((f, i) =>
          i === index ? { ...f, value } : f
        )
      );
    },
    [filters, onChange]
  );

  if (!open) return null;

  return (
    <div className="filter-panel">
      {filters.map((c, i) => (
        <div key={i} className="filter-row">
          <Select
            className="filter-select"
            value={c.field}
            options={[{ value: '', label: '— поле —' }, ...fieldOptions]}
            onChange={(v) => handleFieldChange(i, v)}
          />
          <Select
            className="filter-select"
            value={c.op}
            options={[
              { value: 'contains', label: 'содержит' },
              { value: 'equals', label: 'равно' },
              { value: 'empty', label: 'пусто' },
              { value: 'notEmpty', label: 'не пусто' },
            ]}
            onChange={(v) => handleOpChange(i, v as FilterCond['op'])}
          />
          {(c.op === 'contains' || c.op === 'equals') && (
            <input
              value={c.value ?? ''}
              onChange={(e) => handleValueChange(i, e.target.value)}
              placeholder="Значение"
            />
          )}
          <button
            className="view-button"
            aria-label="Убрать условие"
            onClick={() => onRemove(i)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <div className="filter-actions">
        <button
          className="toolbar-button"
          onClick={onAdd}
        >
          <Plus size={14} /> Условие
        </button>
        <button className="button secondary" onClick={onReset}>
          Сбросить
        </button>
        <button className="button primary" onClick={onApply}>
          Применить
        </button>
      </div>
    </div>
  );
}
