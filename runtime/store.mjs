import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export function createStore(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') chmodSync(file, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(collection,id));');
  return {
    get(collection, id) {
      const row = db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get(collection, id);
      return row ? JSON.parse(row.data) : undefined;
    },
    list(collection) {
      return db.prepare('SELECT data FROM records WHERE collection=? ORDER BY rowid').all(collection).map(row => JSON.parse(row.data));
    },
    put(collection, id, data) {
      const row = { ...data, id };
      db.prepare('INSERT INTO records(collection,id,data) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data').run(collection, id, JSON.stringify(row));
      return row;
    },
    delete(collection, id) { return db.prepare('DELETE FROM records WHERE collection=? AND id=?').run(collection, id).changes > 0; },
    close() { db.close(); },
  };
}
