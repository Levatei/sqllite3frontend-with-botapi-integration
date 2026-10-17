// re-export everything from split db modules for backwards compatibility
export {
  readRegistry,
  writeRegistry,
  getActiveEntry,
  setActiveDb,
  type DbEntry,
} from './registry';

export {
  absDbPath,
} from './path';

export {
  getDb,
  getWriteDb,
} from './connection';

export {
  getDbLabel,
  getDbPath,
} from './schema';

export type {
  ColumnInfo,
} from './schema';

export {
  getTableNames,
  tableExists,
  getColumns,
  getFkChildColumns,
  fkParentProblem,
  isCompatibleDb,
  ID_LIKE,
  SAFE_NAME,
  checkIdent,
  ALLOWED_TYPES,
  ALLOWED_FK_ACTIONS,
  type ListOverviewOptions,
  type FilterOp,
  type FilterCond,
  listOverview,
  type OverviewRow,
} from './schema';

export {
  genericInsert,
  genericUpdate,
  genericDelete,
} from './crud';

export {
  parseFilters,
  getCount,
  listRows,
  type ListOptions,
} from './list';

export {
  createDatabaseFile,
  attachDatabaseFile,
  listDatabasesInfo,
  type NewColumnDef,
  type NewTableDef,
} from './migration';
