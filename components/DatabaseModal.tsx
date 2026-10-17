'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { Select } from '@/components/Select';
import { uploadDb, createDb, type NewTableDef, type NewColumnDef } from '@/lib/api';

interface DatabaseModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  submitting: boolean;
}

const emptyNewCol = (): NewColumnDef => ({
  name: '',
  type: 'TEXT',
  notNull: false,
  pk: false,
  fkTable: '',
  fkColumn: '',
});

export function DatabaseModal({
  open,
  onClose,
  onSuccess,
  submitting,
}: DatabaseModalProps) {
  const [attachTab, setAttachTab] = useState<'upload' | 'create'>('upload');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dbFormError, setDbFormError] = useState<string | null>(null);
  const [newDbName, setNewDbName] = useState('');
  const [newTables, setNewTables] = useState<NewTableDef[]>([
    { name: '', columns: [emptyNewCol()] },
  ]);

  const handleUploadDb = async () => {
    if (!uploadFile) {
      setDbFormError('Выберите файл базы данных (.db, .sqlite).');
      return;
    }
    setUploading(true);
    setDbFormError(null);
    try {
      await uploadDb(uploadFile);
      setDbModalClosed();
      onSuccess();
    } catch (e) {
      setDbFormError(e instanceof Error ? e.message : 'Ошибка загрузки');
    } finally {
      setUploading(false);
    }
  };

  const emptyNewTable = (): NewTableDef => ({
    name: '',
    columns: [emptyNewCol()],
  });

  const handleCreateDb = async () => {
    setDbFormError(null);
    try {
      const name = newDbName.trim();
      if (!name) throw new Error('Укажите имя базы данных.');
      const tablesPayload = newTables.map((t) => ({
        name: t.name.trim(),
        columns: t.columns.map((c) => ({
          name: c.name.trim(),
          type: c.type,
          notNull: c.notNull,
          pk: c.pk,
          fkTable: c.fkTable || undefined,
          fkColumn: c.fkColumn?.trim() || undefined,
        })),
      }));
      await createDb(name, tablesPayload);
      setDbModalClosed();
      onSuccess();
    } catch (e) {
      setDbFormError(e instanceof Error ? e.message : 'Ошибка создания базы');
    }
  };

  const setDbModalClosed = () => {
    setUploadFile(null);
    setNewDbName('');
    setNewTables([emptyNewTable()]);
    setDbFormError(null);
    setAttachTab('upload');
    onClose();
  };

  const SAFE_NAME = /^[\p{L}_][\p{L}\p{N}_-]*$/u;

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={() => !submitting && !uploading && onClose()}>
      <div className="modal" style={{ width: 'min(640px, 96vw)' }} onClick={(e) => e.stopPropagation()}>
        <div className="structure-header">
          <div>
            <span className="eyebrow">Admin · Databases</span>
            <h3>Добавить новую БД</h3>
          </div>
          <button className="icon-button" aria-label="Закрыть" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button
            className={`toolbar-button ${attachTab === 'upload' ? 'active' : ''}`}
            onClick={() => setAttachTab('upload')}
          >
            Загрузить файл
          </button>
          <button
            className={`toolbar-button ${attachTab === 'create' ? 'active' : ''}`}
            onClick={() => setAttachTab('create')}
          >
            Создать с нуля
          </button>
        </div>

        {attachTab === 'upload' && (
          <>
            <label className="field">
              <span>Файл SQLite (.db, .sqlite)</span>
              <input
                type="file"
                accept=".db,.sqlite,.sqlite3"
                onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
              />
            </label>
            {uploadFile && <p className="modal-text">Выбран: {uploadFile.name}</p>}
            {dbFormError && <p className="form-error">{dbFormError}</p>}
            <div className="modal-actions">
              <button className="button secondary" disabled={uploading} onClick={onClose}>
                Отмена
              </button>
              <button
                className="button primary"
                disabled={uploading}
                onClick={handleUploadDb}
              >
                {uploading ? 'Загрузка...' : 'Добавить и открыть'}
              </button>
            </div>
          </>
        )}

        {attachTab === 'create' && (
          <>
            <label className="field">
              <span>Имя базы данных *</span>
              <input
                value={newDbName}
                onChange={(e) => setNewDbName(e.target.value)}
                placeholder="shop"
              />
            </label>
            {newTables.map((t, ti) => (
              <div key={ti} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, marginTop: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    value={t.name}
                    onChange={(e) => setNewTables(newTables.map((x, j) => (j === ti ? { ...x, name: e.target.value } : x)))}
                    placeholder="Название таблицы"
                    style={{ flex: 1, border: '1px solid var(--line)', borderRadius: 7, padding: '7px 9px', fontSize: 12 }}
                  />
                  <button className="view-button" aria-label="Удалить таблицу" onClick={() => setNewTables(newTables.filter((_, j) => j !== ti))}>
                    <Trash2 size={14} />
                  </button>
                </div>
                {t.columns.map((c, ci) => (
                  <div key={ci} className="filter-row" style={{ marginTop: 8 }}>
                    <input
                      value={c.name}
                      onChange={(e) => setNewTables(newTables.map((x, j) => (j === ti ? { ...x, columns: x.columns.map((y, k) => (k === ci ? { ...y, name: e.target.value } : y)) } : x)))}
                      placeholder="поле"
                      style={{ flex: 2 }}
                    />
                    <Select
                      className="select-sm"
                      value={c.type}
                      options={['TEXT', 'INTEGER', 'REAL', 'NUMERIC', 'DATE'].map((tp) => ({ value: tp, label: tp }))}
                      onChange={(v) => setNewTables(newTables.map((x, j) => (j === ti ? { ...x, columns: x.columns.map((y, k) => (k === ci ? { ...y, type: v } : y)) } : x)))}
                    />
                    <label title="NOT NULL" style={{ fontSize: 10, display: 'flex', gap: 3, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={c.notNull}
                        onChange={(e) => setNewTables(newTables.map((x, j) => (j === ti ? { ...x, columns: x.columns.map((y, k) => (k === ci ? { ...y, notNull: e.target.checked } : y)) } : x)))}
                      />
                      NN
                    </label>
                    <label title="PRIMARY KEY" style={{ fontSize: 10, display: 'flex', gap: 3, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={c.pk}
                        onChange={(e) => setNewTables(newTables.map((x, j) => (j === ti ? { ...x, columns: x.columns.map((y, k) => (k === ci ? { ...y, pk: e.target.checked } : y)) } : x)))}
                      />
                      PK
                    </label>
                    <button className="view-button" aria-label="Убрать поле" onClick={() => setNewTables(newTables.map((x, j) => (j === ti ? { ...x, columns: x.columns.filter((_, k) => k !== ci) } : x)))}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
                {t.columns.map((c, ci) => (
                  <div key={ci} className="filter-row" style={{ marginTop: 6 }}>
                    <span style={{ fontSize: 10, color: '#888985', minWidth: 90 }}>Связь: {c.name || '—'}</span>
                    <Select
                      className="select-sm"
                      value={c.fkTable ?? ''}
                      options={[
                        { value: '', label: '— без связи —' },
                        ...newTables
                          .filter((ot, oi) => oi !== ti && ot.name.trim())
                          .map((ot) => ({ value: ot.name.trim(), label: ot.name.trim() })),
                      ]}
                      onChange={(v) => setNewTables(newTables.map((x, j) => (j === ti ? { ...x, columns: x.columns.map((y, k) => (k === ci ? { ...y, fkTable: v, fkColumn: '' } : y)) } : x)))}
                    />
                    <input
                      value={c.fkColumn ?? ''}
                      onChange={(e) => setNewTables(newTables.map((x, j) => (j === ti ? { ...x, columns: x.columns.map((y, k) => (k === ci ? { ...y, fkColumn: e.target.value } : y)) } : x)))}
                      placeholder="поле таблицы"
                      style={{ flex: 1 }}
                    />
                  </div>
                ))}
                <button className="toolbar-button" style={{ marginTop: 8 }} onClick={() => setNewTables(newTables.map((x, j) => (j === ti ? { ...x, columns: [...x.columns, emptyNewCol()] } : x)))}>
                  <Plus size={14} /> Поле
                </button>
              </div>
            ))}
            <button className="toolbar-button" style={{ marginTop: 10 }} onClick={() => setNewTables([...newTables, emptyNewTable()])}>
              <Plus size={14} /> Таблица
            </button>
            {dbFormError && <p className="form-error">{dbFormError}</p>}
            <div className="modal-actions">
              <button className="button secondary" onClick={onClose}>Отмена</button>
              <button className="button primary" onClick={handleCreateDb}>Создать и открыть</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
