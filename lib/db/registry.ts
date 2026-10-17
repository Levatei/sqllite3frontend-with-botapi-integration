import fs from 'node:fs';
import path from 'node:path';

export interface DbEntry {
  id: string;
  name: string;
  path: string;
}

const REGISTRY_FILE = path.join(process.cwd(), 'dblist.json');

function defaultEntry(): DbEntry {
  return { id: 'mba_data', name: 'mba_data.db', path: 'mba_data.db' };
}

export function readRegistry(): { active: string; dbs: DbEntry[] } {
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
    const r = JSON.parse(raw) as { active?: unknown; dbs?: unknown };
    if (r && Array.isArray(r.dbs) && r.dbs.length > 0) {
      const dbs = (r.dbs as DbEntry[]).filter(
        (d) => d && typeof d.id === 'string' && typeof d.path === 'string'
      );
      if (dbs.length > 0) {
        const active = typeof r.active === 'string' ? r.active : dbs[0].id;
        return { active, dbs };
      }
    }
  } catch {
    /* missing or corrupt — fall back to default */
  }
  const d = defaultEntry();
  return { active: d.id, dbs: [d] };
}

export function writeRegistry(r: { active: string; dbs: DbEntry[] }): void {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(r, null, 2), 'utf8');
}

export function getActiveEntry(): DbEntry {
  const r = readRegistry();
  return r.dbs.find((d) => d.id === r.active) ?? r.dbs[0];
}

export function setActiveDb(id: string): DbEntry {
  const r = readRegistry();
  const entry = r.dbs.find((d) => d.id === id);
  if (!entry) throw new Error('База данных не найдена в списке.');
  r.active = id;
  writeRegistry(r);
  return entry;
}
