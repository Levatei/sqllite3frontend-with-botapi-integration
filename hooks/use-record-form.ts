'use client';

import { useCallback, useRef, useState } from 'react';
import { createRecord, deleteRecord, fetchRecords, updateRecord } from '@/lib/api';
import type { ColumnInfo } from '@/lib/db';

export type RecordModalMode = 'closed' | 'generic';

interface UseRecordFormOptions {
  /** Колонки таблицы (для отрисовки полей формы). */
  getColumns: (table: string) => ColumnInfo[];
  notify: (message: string) => void;
  /** Вызывается после успешного создания/обновления/удаления. */
  onSaved: () => void;
}

/**
 * Форма создания/редактирования записи и подтверждение удаления.
 * Работает с любой таблицей через общий /api/records.
 */
export function useRecordForm({ getColumns, notify, onSaved }: UseRecordFormOptions) {
  const [modal, setModal] = useState<RecordModalMode>('closed');
  const [table, setTable] = useState('');
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [companies, setCompanies] = useState<Record<string, unknown>[]>([]);
  const [equipments, setEquipments] = useState<Record<string, unknown>[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<{
    table: string;
    row: Record<string, unknown>;
  } | null>(null);
  const savingRef = useRef(false);

  const loadLists = useCallback(async () => {
    try {
      const [c, e] = await Promise.all([
        fetchRecords('clients', { page: 1, pageSize: 200 }),
        fetchRecords('equipment', { page: 1, pageSize: 200 }),
      ]);
      setCompanies(c.rows);
      setEquipments(e.rows);
    } catch {
      notify('Не удалось загрузить справочники.');
    }
  }, [notify]);

  const openCreate = useCallback(
    (target: string) => {
      setTable(target);
      setColumns(getColumns(target));
      setEditingId(null);
      setValues({});
      setModal('generic');
      loadLists();
    },
    [getColumns, loadLists]
  );

  const openEdit = useCallback(
    (target: string, row: Record<string, unknown>) => {
      setTable(target);
      setColumns(getColumns(target));
      setEditingId(Number(row._rowid));
      const init: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k === '_rowid') continue;
        init[k] = v === null || v === undefined || v === 'null' ? '' : String(v);
      }
      setValues(init);
      setModal('generic');
      loadLists();
    },
    [getColumns, loadLists]
  );

  const close = useCallback(() => {
    setModal('closed');
    setEditingId(null);
    setValues({});
  }, []);

  const save = useCallback(
    async (data: Record<string, string>) => {
      if (savingRef.current) return { ok: false as const, error: 'Сохранение...' };
      savingRef.current = true;
      setSubmitting(true);
      try {
        const isEdit = editingId !== null;
        if (isEdit) await updateRecord(table, editingId, data);
        else await createRecord(table, data);
        close();
        onSaved();
        notify(isEdit ? 'Запись обновлена.' : 'Запись создана.');
        return { ok: true as const };
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Ошибка сохранения';
        return { ok: false as const, error: msg };
      } finally {
        savingRef.current = false;
        setSubmitting(false);
      }
    },
    [editingId, table, close, onSaved, notify]
  );

  const requestDelete = useCallback((target: string, row: Record<string, unknown>) => {
    if (!Number.isFinite(Number(row._rowid))) return;
    setDeleteTarget({ table: target, row });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deleteRecord(deleteTarget.table, Number(deleteTarget.row._rowid));
      onSaved();
      notify('Запись удалена.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Ошибка удаления');
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, onSaved, notify]);

  const cancelDelete = useCallback(() => setDeleteTarget(null), []);

  return {
    modal,
    table,
    columns,
    editingId,
    values,
    submitting,
    companies,
    equipments,
    openCreate,
    openEdit,
    close,
    save,
    deleteTarget,
    requestDelete,
    confirmDelete,
    cancelDelete,
  };
}
