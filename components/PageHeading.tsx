'use client';

import { Plus, RefreshCw } from 'lucide-react';

interface PageHeadingProps {
  label: string;
  subtitle: React.ReactNode;
  showAddStatus: boolean;
  showCreate?: boolean;
  onRefresh: () => void;
  onAddStatus: () => void;
  onCreate: () => void;
}

export function PageHeading({
  label,
  subtitle,
  showAddStatus,
  showCreate = true,
  onRefresh,
  onAddStatus,
  onCreate,
}: PageHeadingProps) {
  return (
    <div className="page-heading">
      <div>
        <div className="heading-kicker"><span className="live-indicator" /> Live workspace</div>
        <h2>{label}</h2>
        <p>{subtitle}</p>
      </div>
      <div className="heading-actions">
        <button className="button secondary" onClick={onRefresh}>
          <RefreshCw size={16} /> Обновить
        </button>
        {showAddStatus && (
          <button className="button secondary" onClick={onAddStatus}>
            <Plus size={16} /> Добавить статус
          </button>
        )}
        {showCreate && (
          <button className="button primary" onClick={onCreate}>
            <Plus size={16} /> Create
          </button>
        )}
      </div>
    </div>
  );
}
