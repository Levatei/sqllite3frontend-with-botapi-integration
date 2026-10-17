'use client';

import { AlertCircle, X } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = 'Подтвердить',
  cancelText = 'Отмена',
  danger = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 'min(440px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
        <div className="structure-header">
          <div>
            <span className="eyebrow">{danger ? 'Удаление' : 'Подтверждение'}</span>
            <h3>{title}</h3>
          </div>
          <button className="icon-button" aria-label="Закрыть" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        {message && (
          <p className="modal-text" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            {danger && <AlertCircle size={16} style={{ flex: '0 0 auto', marginTop: 1, color: '#a33' }} />}
            <span>{message}</span>
          </p>
        )}
        <div className="modal-actions">
          <button className="button secondary" onClick={onClose}>
            {cancelText}
          </button>
          <button
            className={danger ? 'button danger-solid' : 'button primary'}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
