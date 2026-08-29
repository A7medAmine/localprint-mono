import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_version').all().map(r => r.version)
  );

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{3}_.*\.sql$/.test(f))
    .sort();

  for (const file of files) {
    const version = parseInt(file.slice(0, 3), 10);
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(version, file);
    })();

    console.log(`✅ Migration ${file} applied`);
  }
}
