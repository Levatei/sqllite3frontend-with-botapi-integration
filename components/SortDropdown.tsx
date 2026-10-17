'use client';

import { useCallback } from 'react';
import { ArrowDownAZ, ChevronDown, X } from 'lucide-react';

interface SortOption {
  value: string;
  label: string;
}

interface SortDropdownProps {
  options: SortOption[];
  currentSort: string | undefined | null;
  currentDir: 'asc' | 'desc';
  onSelect: (value: string) => void;
  onClear: () => void;
  open: boolean;
  onClose: () => void;
}

export function SortDropdown({
  options,
  currentSort,
  currentDir,
  onSelect,
  onClear,
  open,
  onClose,
}: SortDropdownProps) {
  const handleSelect = useCallback(
    (value: string) => {
      onSelect(value);
      onClose();
    },
    [onSelect, onClose]
  );

  if (!open) return null;

  return (
    <div className="dropdown">
      {options.map((o) => (
        <button
          key={o.value}
          className={`dropdown-item ${currentSort === o.value ? 'selected' : ''}`}
          onClick={() => handleSelect(o.value)}
        >
          <span>{o.label}</span>
          <span>
            {currentSort === o.value ? (currentDir === 'asc' ? '↑' : '↓') : ''}
          </span>
        </button>
      ))}
      {currentSort && (
        <button className="dropdown-item" onClick={onClear}>
          <span>Сбросить</span>
          <span />
        </button>
      )}
    </div>
  );
}
