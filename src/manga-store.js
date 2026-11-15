'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function createMangaStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'manga.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS manga_library (
    user_id TEXT NOT NULL, manga_id INTEGER NOT NULL, data TEXT NOT NULL,
    updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, manga_id));`);
  const get = db.prepare('SELECT data FROM manga_library WHERE user_id=? AND manga_id=?');
  const list = db.prepare('SELECT data FROM manga_library WHERE user_id=? ORDER BY updated_at DESC');
  const put = db.prepare('INSERT INTO manga_library VALUES(?,?,?,?) ON CONFLICT(user_id,manga_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at');
  return {
    list: user => list.all(String(user)).map(row => JSON.parse(row.data)),
    save(user, mangaId, patch) {
      const previous = JSON.parse(get.get(String(user), mangaId)?.data || '{}');
      const data = { ...previous, ...patch, id: mangaId, updatedAt: Date.now() };
      if (patch.chapterId) data.progress = { ...previous.progress, [patch.chapterId]: { page: patch.page, pageCount: patch.pageCount, read: Boolean(patch.chapterRead || previous.progress?.[patch.chapterId]?.read || patch.page >= patch.pageCount - 1) } };
      put.run(String(user), mangaId, JSON.stringify(data), data.updatedAt);
      return data;
    },
    close: () => db.close(),
  };
}
module.exports = { createMangaStore };
