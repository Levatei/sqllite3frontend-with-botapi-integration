'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  Code2,
  Database,
  Images,
  LayoutDashboard,
  Menu,
  Plus,
  Users,
  Boxes,
  Wrench,
  Table2,
  X,
} from 'lucide-react';
import { fetchMediaCounts, fetchTables } from '@/lib/api';
import { useDatabases } from '@/hooks/use-databases';
import { useOrders } from '@/hooks/use-orders';
import { useKanban } from '@/hooks/use-kanban';
import { useRecordForm } from '@/hooks/use-record-form';
import { Sidebar } from '@/components/Sidebar';
import { KanbanBoard } from '@/components/KanbanBoard';
import { TableView } from '@/components/TableView';
import { MediaBrowser } from '@/components/MediaBrowser';
import { RecordModal } from '@/components/RecordModal';
import { DatabaseModal } from '@/components/DatabaseModal';
import { PromptDialog } from '@/components/PromptDialog';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ChoiceModal } from '@/components/ChoiceModal';
import { PageHeading } from '@/components/PageHeading';
import type { ColumnInfo } from '@/lib/db';

interface TableMeta {
  name: string;
  count: number;
  columns: ColumnInfo[];
}

export default function Home() {
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dbLabel, setDbLabel] = useState('mba_data.db');
  const [compatible, setCompatible] = useState(true);
  const [tables, setTables] = useState<TableMeta[]>([]);
  const [mobileNav, setMobileNav] = useState(false);

  const [activeSection, setActiveSection] = useState('home');
  const [activeTableResolved, setActiveTableResolved] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState('Главная');
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [tableTotal, setTableTotal] = useState(0);
  const [mediaTotal, setMediaTotal] = useState<number | undefined>(undefined);

  const [adminOpen, setAdminOpen] = useState(false);
  const [dbModal, setDbModal] = useState(false);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const notify = useCallback((message: string) => setNotice(message), []);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const { dbs, activeId, switchDatabase } = useDatabases();

  const loadTables = useCallback(async () => {
    try {
      setLoadError(null);
      const data = await fetchTables();
      setTables(data.tables);
      if (data.db) setDbLabel(data.db);
      if (typeof data.compatible === 'boolean') setCompatible(data.compatible);
      setConnected(true);
    } catch (e) {
      setConnected(false);
      setLoadError(e instanceof Error ? e.message : 'Не удалось подключиться к БД');
    }
  }, []);

  useEffect(() => {
    loadTables();
  }, [loadTables]);

  // Общее число медиафайлов для пункта «Медиафайлы» в сайдбаре.
  useEffect(() => {
    if (!connected || !compatible) {
      setMediaTotal(undefined);
      return;
    }
    let cancelled = false;
    fetchMediaCounts()
      .then((c) => {
        if (!cancelled) setMediaTotal(c.total);
      })
      .catch(() => {
        if (!cancelled) setMediaTotal(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, compatible, tick]);

  const sections = useMemo(() => {
    type Section = { id: string; label: string; icon: React.ElementType; table: string | null };
    const list: Section[] = [];
    if (compatible) list.push({ id: 'home', label: 'Главная', icon: LayoutDashboard, table: null });
    const STANDARD_META: Record<string, { label: string; icon: React.ElementType }> = {
      clients: { label: 'Клиенты', icon: Users },
      equipment: { label: 'Оборудование', icon: Boxes },
      orders: { label: 'Заказы', icon: Wrench },
    };
    for (const t of tables) {
      const std = STANDARD_META[t.name];
      list.push({ id: t.name, label: std?.label ?? t.name, icon: std?.icon ?? Table2, table: t.name });
    }
    if (compatible) list.push({ id: 'media', label: 'Медиафайлы', icon: Images, table: null });
    return list;
  }, [tables, compatible]);

  const selectTable = useCallback(
    (id: string) => {
      setActiveSection(id);
      if (id === 'home') {
        setActiveTableResolved(null);
        setActiveLabel('Главная');
        setColumns([]);
        return;
      }
      if (id === 'media') {
        setActiveTableResolved(null);
        setActiveLabel('Медиафайлы');
        setColumns([]);
        return;
      }
      const t = tables.find((x) => x.name === id);
      if (t) {
        setActiveTableResolved(id);
        setActiveLabel(t.name);
        setColumns(t.columns);
      }
    },
    [tables]
  );

  // Если активный раздел исчез (например, сменили БД) — переключаемся на первый.
  useEffect(() => {
    if (sections.length === 0) return;
    if (sections.find((s) => s.id === activeSection)) return;
    const first = sections[0];
    setActiveSection(first.id);
    setActiveTableResolved(first.table);
    setActiveLabel(first.label);
    setColumns(first.table ? (tables.find((t) => t.name === first.table)?.columns ?? []) : []);
  }, [sections, activeSection, tables]);

  // --- Данные ---
  const { orders, loading: ordersLoading, error: ordersError } = useOrders({
    enabled: connected && compatible && activeTableResolved === null && activeSection !== 'media',
    refreshKey: tick,
  });

  const getColumns = useCallback(
    (table: string) => tables.find((t) => t.name === table)?.columns ?? [],
    [tables]
  );

  const {
    modal,
    table: modalTable,
    columns: modalColumns,
    editingId,
    values: formValues,
    submitting,
    companies,
    equipments,
    openCreate,
    openEdit,
    close: closeForm,
    save: saveForm,
    deleteTarget,
    requestDelete,
    confirmDelete,
    cancelDelete,
  } = useRecordForm({ getColumns, notify, onSaved: bump });

  const {
    columns: kanbanColumns,
    moveOrder,
    addColumn,
    requestRemoveColumn,
    confirmRemoveColumn,
    cancelRemoveColumn,
    removeColumnTarget,
    removeColumnCount,
    activeCards,
    statusPromptOpen,
    setStatusPromptOpen,
  } = useKanban({ activeId, orders, notify, onChanged: bump });

  // --- Действия страницы ---
  const handleOpenCreate = useCallback(() => {
    if (!activeTableResolved) {
      setChoiceOpen(true);
      return;
    }
    openCreate(activeTableResolved);
  }, [activeTableResolved, openCreate]);

  const chooseClient = useCallback(() => {
    setChoiceOpen(false);
    selectTable('clients');
    openCreate('clients');
  }, [selectTable, openCreate]);

  const chooseOrder = useCallback(() => {
    setChoiceOpen(false);
    openCreate('orders');
  }, [openCreate]);

  const switchDb = async (id: string) => {
    setAdminOpen(false);
    try {
      await switchDatabase(id);
      await loadTables();
      bump();
      notify('База открыта.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Ошибка переключения');
    }
  };

  const handleAddDb = () => {
    setAdminOpen(false);
    setDbModal(true);
  };

  const handleDbSuccess = () => {
    setDbModal(false);
    loadTables();
    bump();
    notify('База открыта.');
  };

  const refreshAll = useCallback(() => {
    loadTables();
    bump();
  }, [loadTables, bump]);

  const isMedia = compatible && activeSection === 'media';

  const subtitle = isMedia ? (
    <>Фото и видео · откройте насос или заявку</>
  ) : activeTableResolved ? (
    <>Таблица <code>{activeTableResolved}</code> · {tableTotal} записей</>
  ) : (
    <>Канбан заявок по статусам · {orders.length} заявок</>
  );

  return (
    <main className="app-shell">
      <Sidebar
        activeSection={activeSection}
        onSelectSection={selectTable}
        connected={connected}
        dbLabel={dbLabel}
        loadError={loadError}
        onRefresh={loadTables}
        compatible={compatible}
        onAddDb={handleAddDb}
        homeCount={activeCards}
        mediaCount={mediaTotal}
        mobileOpen={mobileNav}
        onCloseMobile={() => setMobileNav(false)}
      />

      <section className="workspace">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Открыть меню"
            onClick={() => setMobileNav(true)}
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumbs"><span>Workspace</span><span>/</span><strong>{activeLabel}</strong></div>
          <div className="topbar-actions">
            <div className="dropdown-wrap">
              <button className="user-chip" style={{ border: 0, background: 'transparent', cursor: 'pointer', font: 'inherit' }} onClick={() => setAdminOpen(!adminOpen)} aria-label="Меню баз данных">
                <div className="avatar small">AD</div><span>Admin</span><ChevronDown size={14} />
              </button>
              {adminOpen && (
                <div className="dropdown" style={{ minWidth: 250 }}>
                  {dbs.map((d) => (
                    <button key={d.id} className={`dropdown-item ${d.id === activeId ? 'selected' : ''}`} onClick={() => switchDb(d.id)}>
                      <span title={d.name}>{d.name}</span>
                      <span>{d.id === activeId ? '●' : `${d.tables.length} табл.`}</span>
                    </button>
                  ))}
                  <button className="dropdown-item" onClick={handleAddDb}>
                    <span><Plus size={14} /> Добавить новую БД</span>
                    <span />
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="content-wrap">
          <PageHeading
            label={activeLabel}
            subtitle={subtitle}
            showAddStatus={activeTableResolved === null && compatible && !isMedia}
            showCreate={!isMedia}
            onRefresh={refreshAll}
            onAddStatus={() => addColumn()}
            onCreate={handleOpenCreate}
          />

          {isMedia ? (
            <MediaBrowser refreshKey={tick} onChanged={bump} onNotice={notify} />
          ) : activeTableResolved === null && compatible ? (
            <KanbanBoard
              orders={orders}
              columns={kanbanColumns}
              loading={ordersLoading}
              error={ordersError}
              connected={connected}
              loadError={loadError}
              onMove={moveOrder}
              onEdit={(row) => openEdit('orders', row)}
              onDelete={(row) => requestDelete('orders', row)}
              onAddColumn={addColumn}
              onRemoveColumn={requestRemoveColumn}
              onOpenCreate={handleOpenCreate}
            />
          ) : (
            <div className="data-layout">
              <section className="data-panel">
                {activeTableResolved ? (
                  <TableView
                    key={activeTableResolved}
                    table={activeTableResolved}
                    label={activeLabel}
                    columns={columns.map((c) => c.name)}
                    connected={connected}
                    loadError={loadError}
                    actionsEnabled={true}
                    onOpenCreate={handleOpenCreate}
                    onEditRow={openEdit}
                    onDeleteRow={requestDelete}
                    refreshKey={tick}
                    onTotalChange={setTableTotal}
                  />
                ) : (
                  <div className="empty-state">
                    <div className="empty-illustration"><Database size={25} /></div>
                    <h3>Выберите раздел</h3>
                    <p>Откройте раздел из бокового меню.</p>
                  </div>
                )}
              </section>
            </div>
          )}

          {/* SQL-клиент скрыт (не удалён — может пригодиться позже) */}
          {false && (
            <div className="sql-strip">
              <div className="sql-title">
                <div className="sql-icon"><Code2 size={16} /></div>
                <div><strong>SQL client</strong><span>GET /api/tables · /api/records · /api/overview</span></div>
              </div>
              <span className="sql-hint">{connected ? `${dbLabel} · сортировка по клику на заголовок` : 'Подключение к API необходимо'}</span>
              <button className="button dark" onClick={() => notify('SQL-клиент пока не реализовано.')}>
                <Code2 size={15} /> Open SQL client
              </button>
            </div>
          )}
        </div>
      </section>

      <ChoiceModal
        open={choiceOpen}
        onClose={() => setChoiceOpen(false)}
        onChooseClient={chooseClient}
        onChooseOrder={chooseOrder}
      />

      {modal === 'generic' && (
        <RecordModal
          open
          onClose={closeForm}
          table={modalTable}
          columns={modalColumns}
          editingId={editingId}
          initialValues={formValues}
          companies={companies}
          equipments={equipments}
          statusOptions={kanbanColumns}
          onSave={saveForm}
          submitting={submitting}
        />
      )}

      {dbModal && (
        <DatabaseModal
          open={dbModal}
          onClose={() => setDbModal(false)}
          onSuccess={handleDbSuccess}
          submitting={false}
        />
      )}

      <PromptDialog
        open={statusPromptOpen}
        title="Новый статус"
        label="Название статуса"
        placeholder="Например: Согласование"
        confirmText="Добавить"
        onConfirm={(value) => addColumn(value)}
        onClose={() => setStatusPromptOpen(false)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Удалить запись?"
        message="Действие необратимо. Запись будет удалена из базы данных."
        confirmText="Удалить"
        danger
        onConfirm={confirmDelete}
        onClose={cancelDelete}
      />

      <ConfirmDialog
        open={removeColumnTarget !== null}
        title={`Убрать статус «${removeColumnTarget ?? ''}»?`}
        message={
          removeColumnCount > 0
            ? `В этом статусе ${removeColumnCount} заявк(и). Заявки не удаляются — они останутся в базе и появятся отдельной колонкой.`
            : 'Статус будет убран с доски. Заявки не удаляются.'
        }
        confirmText="Убрать"
        onConfirm={confirmRemoveColumn}
        onClose={cancelRemoveColumn}
      />

      {notice && <div className="toast"><AlertCircle size={17} /><span>{notice}</span><button aria-label="Закрыть уведомление" onClick={() => setNotice(null)}><X size={15} /></button></div>}
    </main>
  );
}
