'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Plus, X } from 'lucide-react';
import {
  createRecord,
  updateRecord,
  type NewColumnDef,
} from '@/lib/api';
import { SearchSelect, type SearchSelectOption } from '@/components/SearchSelect';
import { Select } from '@/components/Select';
import { DateField } from '@/components/DateField';
import type { ColumnInfo } from '@/lib/db';

interface RecordModalProps {
  open: boolean;
  onClose: () => void;
  table: string;
  columns: ColumnInfo[];
  editingId: number | null;
  initialValues: Record<string, string>;
  companies: Record<string, unknown>[];
  equipments: Record<string, unknown>[];
  statusOptions?: string[];
  onSave: (values: Record<string, string>) => Promise<{ ok: boolean; error?: string }>;
  submitting: boolean;
}

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

export function RecordModal({
  open,
  onClose,
  table,
  columns,
  editingId,
  initialValues,
  companies,
  equipments,
  statusOptions = [],
  onSave,
  submitting,
}: RecordModalProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      const init: Record<string, string> = { ...initialValues };
      const hasStatus = columns.some((c) => c.name === 'status');
      if (hasStatus && !init.status && statusOptions.length > 0) {
        init.status = statusOptions[0];
      }
      setValues(init);
      setFormError(null);
    }
    // Инициализируем форму только при открытии, чтобы ввод не сбрасывался
    // при перерисовке родителя (initialValues — новая ссылка на объект).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isClientFk = (name: string) => name === 'client_id';
  const isEquipFk = (name: string) => name === 'equipment_id';
  const isDate = (type: string) => type.toUpperCase().includes('DATE');

  const isAuto = useMemo(() => {
    const singlePk = columns.filter((c) => c.pk > 0).length === 1;
    return new Set(
      columns.filter((c) => {
        const t = (c.type || '').toUpperCase();
        return (
          (singlePk && c.pk > 0 && (t.includes('TEXT') || t.includes('INT'))) ||
          (t.includes('INT') &&
            /^id$|^id_|_id$/i.test(c.name) &&
            !c.fk)
        );
      }).map((c) => c.name)
    );
  }, [columns]);

  const clientOptions: SearchSelectOption[] = useMemo(
    () =>
      companies.map((cl) => {
        const mail = displayValue(cl.mail);
        return {
          value: String(cl.client_id),
          label: `${displayValue(cl.name)}${mail !== '—' ? ' · ' + mail : ''}`,
        };
      }),
    [companies]
  );

  const selectedClientId = values['client_id'] ?? '';

  const equipmentOptions: SearchSelectOption[] = useMemo(() => {
    if (!selectedClientId) return [];
    return equipments
      .filter((eq) => String(eq.client_id) === String(selectedClientId))
      .map((eq) => {
        const serial = shortValue(eq.serial_number);
        return {
          value: String(eq.equipment_id),
          label: `${displayValue(eq.manufacturer)} ${displayValue(eq.model)}${
            serial !== '—' ? ' · ' + serial : ''
          }`.trim(),
        };
      });
  }, [equipments, selectedClientId]);

  const setClient = (clientId: string) => {
    setValues((prev) => {
      const next: Record<string, string> = { ...prev, client_id: clientId };
      const currentEquip = prev['equipment_id'];
      if (currentEquip) {
        const stillValid = equipments.some(
          (eq) =>
            String(eq.equipment_id) === String(currentEquip) &&
            String(eq.client_id) === String(clientId)
        );
        if (!stillValid) next['equipment_id'] = '';
      }
      return next;
    });
  };

  const handleSave = async () => {
    setFormError(null);
    try {
      const res = await onSave(values);
      if (!res.ok) throw new Error(res.error ?? 'Ошибка сохранения');
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Ошибка сохранения');
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="structure-header">
          <div>
            <span className="eyebrow">
              {editingId !== null ? 'Редактирование' : 'Новая запись'}
            </span>
            <h3>{table} · {editingId !== null ? 'править' : 'создать'}</h3>
          </div>
          <button className="icon-button" aria-label="Закрыть" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        {columns.map((c) => {
          const t = (c.type || '').toUpperCase();
          const auto = isAuto.has(c.name);
          // при создании скрываем авто-ID колонки (генерируются автоматически)
          if (editingId === null && auto) return null;
          const required = c.notnull && !c.dflt_value && !auto;
          return (
            <label key={c.name} className="field">
              <span>
                {c.name}{required ? ' *' : ''}{auto ? ' (заполнится само)' : ''}
              </span>
              {isClientFk(c.name) ? (
                <SearchSelect
                  value={values[c.name] ?? ''}
                  options={clientOptions}
                  onChange={setClient}
                  placeholder="Начните вводить имя клиента..."
                  emptyLabel="— выберите клиента —"
                />
              ) : isEquipFk(c.name) ? (
                <SearchSelect
                  value={values[c.name] ?? ''}
                  options={equipmentOptions}
                  onChange={(v) =>
                    setValues((prev) => ({ ...prev, [c.name]: v }))}
                  placeholder="Выберите оборудование клиента"
                  emptyLabel="— выберите оборудование —"
                  disabled={!selectedClientId}
                  disabledHint="Сначала выберите клиента"
                />
              ) : c.name === 'status' ? (
                <Select
                  value={values[c.name] ?? ''}
                  options={(
                    statusOptions.includes(values[c.name] ?? '')
                      ? statusOptions
                      : ([values[c.name], ...statusOptions].filter(Boolean) as string[])
                  ).map((s) => ({ value: s, label: s }))}
                  onChange={(v) =>
                    setValues((prev) => ({ ...prev, [c.name]: v }))}
                  placeholder="— выберите статус —"
                />
              ) : isDate(t) ? (
                <DateField
                  value={values[c.name] ?? ''}
                  onChange={(v) =>
                    setValues((prev) => ({ ...prev, [c.name]: v }))}
                />
              ) : (
                <input
                  value={values[c.name] ?? ''}
                  disabled={auto && editingId === null}
                  onChange={(e) =>
                    setValues({ ...values, [c.name]: e.target.value })}
                  placeholder={auto ? 'авто' : c.type || 'TEXT'}
                />
              )}
            </label>
          );
        })}
        {formError && <p className="form-error">{formError}</p>}
        <div className="modal-actions">
          <button
            className="button secondary"
            disabled={submitting}
            onClick={onClose}
          >
            Отмена
          </button>
          <button
            className="button primary"
            disabled={submitting}
            onClick={handleSave}
          >
            {submitting ? 'Сохранение...' : editingId !== null ? 'Сохранить' : 'Создать'}
          </button>
        </div>
      </div>
    </div>
  );
}
