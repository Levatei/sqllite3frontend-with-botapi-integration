'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

interface PromptDialogProps {
  open: boolean;
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}

export function PromptDialog({
  open,
  title,
  label,
  defaultValue = '',
  placeholder,
  confirmText = 'Добавить',
  onConfirm,
  onClose,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    if (open) setValue(defaultValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 'min(440px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
        <div className="structure-header">
          <div>
            <span className="eyebrow">Настройка</span>
            <h3>{title}</h3>
          </div>
          <button className="icon-button" aria-label="Закрыть" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <label className="field">
          {label && <span>{label}</span>}
          <input
            autoFocus
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
              if (e.key === 'Escape') onClose();
            }}
          />
        </label>
        <div className="modal-actions">
          <button className="button secondary" onClick={onClose}>
            Отмена
          </button>
          <button className="button primary" disabled={!value.trim()} onClick={submit}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
