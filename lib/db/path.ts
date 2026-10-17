import path from 'node:path';

export function absDbPath(entry: { path: string }): string {
  return path.isAbsolute(entry.path) ? entry.path : path.join(process.cwd(), entry.path);
}
