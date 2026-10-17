'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export interface SearchSelectOption {
  value: string;
  label: string;
}

interface SearchSelectProps {
  value: string;
  options: SearchSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  disabledHint?: string;
}

export function SearchSelect({
  value,
  options,
  onChange,
  placeholder,
  emptyLabel = '— не выбрано —',
  disabled = false,
  disabledHint,
}: SearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => options.find((o) => o.value === value),
    [options, value]
  );

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  if (disabled) {
    return (
      <input
        className="combo-input"
        value=""
        placeholder={disabledHint ?? placeholder}
        disabled
        readOnly
      />
    );
  }

  return (
    <div className="combo" ref={wrapRef}>
      <input
        className="combo-input"
        value={open ? query : selected?.label ?? ''}
        placeholder={selected ? undefined : placeholder ?? emptyLabel}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter' && open && filtered.length > 0) {
            e.preventDefault();
            pick(filtered[0].value);
          }
        }}
      />
      {open && (
        <div className="combo-list">
          <button
            type="button"
            className="combo-item muted"
            onMouseDown={(e) => {
              e.preventDefault();
              pick('');
            }}
          >
            {emptyLabel}
          </button>
          {filtered.length === 0 ? (
            <div className="combo-empty">Ничего не найдено</div>
          ) : (
            filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`combo-item ${o.value === value ? 'selected' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o.value);
                }}
              >
                {o.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
