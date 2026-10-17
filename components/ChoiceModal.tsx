'use client';

import { Users, Wrench, X } from 'lucide-react';

interface ChoiceModalProps {
  open: boolean;
  onClose: () => void;
  onChooseClient: () => void;
  onChooseOrder: () => void;
}

export function ChoiceModal({ open, onClose, onChooseClient, onChooseOrder }: ChoiceModalProps) {
  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="structure-header">
          <div>
            <span className="eyebrow">Create</span>
            <h3>Что создаём?</h3>
          </div>
          <button className="icon-button" aria-label="Закрыть" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <p className="modal-text">Создать нового клиента или новую заявку?</p>
        <div className="choice-grid">
          <button className="choice-card" onClick={onChooseClient}>
            <Users size={22} />
            <strong>Клиент</strong>
            <span>Компания, телефон, email</span>
          </button>
          <button className="choice-card" onClick={onChooseOrder}>
            <Wrench size={22} />
            <strong>Заявка</strong>
            <span>Клиент + оборудование</span>
          </button>
        </div>
      </div>
    </div>
  );
}
