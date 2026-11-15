'use strict';

const Database = require('better-sqlite3');
const path = require('node:path');
function createAnimeStore(dataDir) {
  const db = new Database(path.join(dataDir, 'anime.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS library (user_id INTEGER NOT NULL, subject_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'history', episode REAL NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0,
      duration REAL NOT NULL DEFAULT 0, watched TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, subject_id));
    CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      author TEXT NOT NULL, subject_id INTEGER NOT NULL, episode REAL NOT NULL, content TEXT NOT NULL,
      spoiler INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS anime_comments_episode ON comments(subject_id, episode, created_at);
    CREATE TABLE IF NOT EXISTS likes (user_id INTEGER NOT NULL, comment_id INTEGER NOT NULL, PRIMARY KEY(user_id, comment_id));
    CREATE TABLE IF NOT EXISTS danmaku (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      subject_id INTEGER NOT NULL, episode REAL NOT NULL, time REAL NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS anime_danmaku_episode ON danmaku(subject_id, episode, time);
    CREATE TABLE IF NOT EXISTS source_settings (user_id INTEGER PRIMARY KEY, sources TEXT NOT NULL);
  `);
  const row = (r) => r ? { ...r, watched: JSON.parse(r.watched) } : null;
  function library(user) { return db.prepare('SELECT * FROM library WHERE user_id=? ORDER BY updated_at DESC LIMIT 500').all(user).map(row); }
  function libraryItem(user, id) { return row(db.prepare('SELECT * FROM library WHERE user_id=? AND subject_id=?').get(user, id)); }
  function save(user, id, changes) {
    const old = libraryItem(user, id) || { status: 'history', episode: 0, position: 0, duration: 0, watched: [] };
    const value = { ...old, ...changes };
    const watched = [...new Set(value.watched)].slice(-500);
    db.prepare(`INSERT INTO library(user_id,subject_id,status,episode,position,duration,watched,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,subject_id) DO UPDATE SET status=excluded.status,episode=excluded.episode,position=excluded.position,
      duration=excluded.duration,watched=excluded.watched,updated_at=excluded.updated_at`).run(user, id, value.status, value.episode, value.position, value.duration, JSON.stringify(watched), Date.now());
    return { ...value, watched, subject_id: id };
  }
  function comments(subject, episode, user, sort) {
    return db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM likes WHERE comment_id=c.id) AS likes,
      EXISTS(SELECT 1 FROM likes WHERE comment_id=c.id AND user_id=?) AS liked FROM comments c
      WHERE subject_id=? AND episode=? ORDER BY ${sort === 'hot' ? 'likes DESC,' : ''} c.id DESC LIMIT 100`).all(user || 0, subject, episode);
  }
  return { db, library, libraryItem, save, comments,
    sources(user) {
      return JSON.parse(db.prepare('SELECT sources FROM source_settings WHERE user_id=?').get(user)?.sources || '[]');
    },
    saveSources(user, sources) {
      db.prepare('INSERT INTO source_settings VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET sources=excluded.sources')
        .run(user, JSON.stringify(sources));
    },
    remove(user, id) { db.prepare('DELETE FROM library WHERE user_id=? AND subject_id=?').run(user, id); },
    comment(user, author, subject, episode, content, spoiler) { return db.prepare('INSERT INTO comments(user_id,author,subject_id,episode,content,spoiler,created_at) VALUES(?,?,?,?,?,?,?)').run(user, author, subject, episode, content, spoiler ? 1 : 0, Date.now()); },
    like(user, id) {
      if (!db.prepare('SELECT id FROM comments WHERE id=?').get(id)) return false;
      if (db.prepare('SELECT 1 FROM likes WHERE user_id=? AND comment_id=?').get(user, id)) db.prepare('DELETE FROM likes WHERE user_id=? AND comment_id=?').run(user, id);
      else db.prepare('INSERT INTO likes(user_id,comment_id) VALUES(?,?)').run(user, id);
      return true;
    },
    danmaku(subject, episode) { return db.prepare('SELECT id,time,text FROM danmaku WHERE subject_id=? AND episode=? ORDER BY time LIMIT 3000').all(subject, episode); },
    sendDanmaku(user, subject, episode, time, text) { db.prepare('INSERT INTO danmaku(user_id,subject_id,episode,time,text,created_at) VALUES(?,?,?,?,?,?)').run(user, subject, episode, time, text, Date.now()); },
    close() { db.close(); }
  };
}
module.exports = { createAnimeStore };
