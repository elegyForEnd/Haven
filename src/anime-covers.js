'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const { openPublic } = require('./anime-media');

const PREFIX = '/api/anime/covers/';
const PLACEHOLDER = '/img/anime/cover-placeholder.svg';
const COVER_PATH = /^(?:\/r\/(?:100|200|400|800))?\/pic\/cover\/[lcmsg]\/[\w/-]+\.(?:jpe?g|png|webp|gif)$/i;
const WEEK = 7 * 86400000;
const MAX_ACTIVE = 8;
const MAX_WAITING = 64;
const WAIT_MS = 4000;
const TIMEOUT_RETRIES = 3;
const MAX_COVER_BYTES = 12 * 1024 * 1024;

function coverUrl(value) {
  if (!value) return PLACEHOLDER;
  try {
    const url = new URL(value);
    if (url.hostname === 'lain.bgm.tv' && /^https?:$/.test(url.protocol) &&
        !url.username && !url.password && !url.port && COVER_PATH.test(url.pathname)) {
      return PREFIX + url.pathname.slice(1);
    }
  } catch {}
  return PLACEHOLDER;
}

function createCoverCache(dataDir, open = openPublic) {
  const db = new Database(path.join(dataDir, 'anime-covers.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS covers (key TEXT PRIMARY KEY, body BLOB, type TEXT, fetched INTEGER, used INTEGER)');
  const get = db.prepare('SELECT * FROM covers WHERE key=?');
  const fetched = db.prepare('SELECT fetched FROM covers WHERE key=?');
  const touch = db.prepare('UPDATE covers SET used=? WHERE key=?');
  const save = db.prepare('INSERT OR REPLACE INTO covers VALUES(?,?,?,?,?)');
  const size = db.prepare('SELECT COALESCE(SUM(length(body)),0) AS bytes FROM covers');
  const oldest = db.prepare('SELECT key,length(body) AS bytes FROM covers ORDER BY used LIMIT 1');
  const remove = db.prepare('DELETE FROM covers WHERE key=?');
  const write = db.transaction((key, body, type) => {
    const now = Date.now();
    save.run(key, body, type, now, now);
    let bytes = size.get().bytes;
    while (bytes > 128 * 1024 * 1024) {
      const row = oldest.get();
      remove.run(row.key);
      bytes -= row.bytes;
    }
  });
  const pending = new Map();
  const failures = new Map();
  const waiting = new Set();
  let active = 0;
  function acquire() {
    if (active < MAX_ACTIVE) {
      active++;
      return Promise.resolve(true);
    }
    if (waiting.size >= MAX_WAITING) return Promise.resolve(false);
    return new Promise(resolve => {
      const next = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiting.delete(next);
        resolve(false);
      }, WAIT_MS);
      waiting.add(next);
    });
  }
  function release() {
    const next = waiting.values().next().value;
    if (!next) {
      active--;
      return;
    }
    waiting.delete(next);
    next();
  }
  async function fetchCover(key) {
    for (let attempt = 0; ; attempt++) {
      if (!await acquire()) {
        if (attempt < TIMEOUT_RETRIES) continue;
        return null;
      }
      const signal = AbortSignal.timeout(8000);
      try {
        return await downloadCover(key, signal);
      } catch (error) {
        if (!signal.aborted || attempt >= TIMEOUT_RETRIES) throw error;
      } finally {
        release();
      }
    }
  }
  async function downloadCover(key, signal) {
    const { response } = await open('https://lain.bgm.tv/' + key, {
      'User-Agent': 'Ciacord/1.0', Accept: 'image/*'
    }, { signal });
    const type = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
    if (response.statusCode !== 200 || !/^image\/(?:jpeg|png|webp|gif)$/.test(type)) {
      response.destroy();
      throw new Error('Invalid cover response');
    }
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > MAX_COVER_BYTES) {
        response.destroy();
        throw new Error('Cover exceeds size limit');
      }
      chunks.push(chunk);
    }
    if (!bytes) throw new Error('Empty cover');
    const body = Buffer.concat(chunks);
    write(key, body, type);
    return { body, type };
  }
  function refresh(key) {
    if (pending.has(key)) return pending.get(key);
    if (failures.get(key) > Date.now()) return Promise.resolve(null);
    const task = fetchCover(key).catch(() => {
      if (failures.size >= 512) failures.delete(failures.keys().next().value);
      failures.set(key, Date.now() + 60000);
      return null;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  async function handle(req, res) {
    const key = req.params[0];
    if (!COVER_PATH.test('/' + key)) return res.sendStatus(404);
    let row = get.get(key);
    if (row) {
      if (Date.now() - row.used > 3600000) touch.run(Date.now(), key);
      if (Date.now() - row.fetched > WEEK) void refresh(key);
    } else row = await refresh(key);
    if (!row) return res.set('Cache-Control', 'no-store').redirect(302, PLACEHOLDER);
    res.set('Cache-Control', 'public, max-age=' + (row.fetched && Date.now() - row.fetched > WEEK ? 60 : 86400));
    res.set('X-Content-Type-Options', 'nosniff');
    res.type(row.type).send(row.body);
  }

  async function warm(urls) {
    for (const url of new Set(urls)) {
      if (!url?.startsWith(PREFIX)) continue;
      const key = url.slice(PREFIX.length);
      if (!COVER_PATH.test('/' + key)) continue;
      const row = fetched.get(key);
      if (!row || Date.now() - row.fetched > WEEK) await refresh(key);
    }
  }

  return { handle, warm, close: () => db.close() };
}

module.exports = { coverUrl, createCoverCache };
