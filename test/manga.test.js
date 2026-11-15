'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { createMangaStore } = require('../src/manga-store');
const { createMangaEngine, REPOSITORIES, resolveRuntime } = require('../src/manga-engine');
const register = require('../src/routes/manga');

test('Mihon source IDs survive beyond 53 bits and GraphQL receives original strings', async () => {
  const source = '6696312508930833206', calls = [];
  const engine = createMangaEngine({ baseUrl: 'http://127.0.0.1:12345', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return { ok: true, text: async () => body.query.includes('__typename') ? '{"data":{"__typename":"Query"}}' : `{"data":{"fetchSourceManga":{"hasNextPage":false,"mangas":[{"id":1,"sourceId":${source},"title":"作品"}]}}}` };
  } });
  const result = await engine.browse(source, 2, '作品');
  assert.equal(result.mangas[0].sourceId, source);
  assert.equal(calls.at(-1).variables.input.source, source);
  assert.equal(calls.at(-1).variables.input.type, 'SEARCH');
  assert.equal(REPOSITORIES.length, 4);
  assert.ok(REPOSITORIES.find(repo => repo.name === 'Cursed').url.endsWith('index.pb'));
  assert.ok(REPOSITORIES[0].url.endsWith('/index.json'));
});

test('runtime pairs the server with its bundled Java, never the launcher or cached CEF helper', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'haven-manga-runtime-'));
  try {
    for (const file of ['qa/bin/kcef/java.exe', 'distribution/Suwayomi-Launcher.jar', 'distribution/bin/Suwayomi-Server.jar', 'distribution/jre/bin/java.exe']) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await fs.writeFile(path.join(dir, file), 'fixture');
    }
    const runtime = resolveRuntime(dir);
    assert.equal(runtime.jar, path.join(dir, 'distribution/bin/Suwayomi-Server.jar'));
    assert.equal(runtime.java, path.join(dir, 'distribution/jre/bin/java.exe'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('image relay normalizes image/jpg, rejects executable images, and uses fixed engine paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'haven-manga-images-'));
  const requests = [];
  const upstream = express();
  upstream.get('/api/v1/manga/:id/thumbnail', (req, res) => { requests.push(req.path); res.set('Content-Type', 'image/jpg').send(Buffer.from([255, 216, 255])); });
  upstream.get('/api/v1/manga/:id/chapter/:chapter/page/:page', (req, res) => { requests.push(req.path); res.type('image/svg+xml').send('<svg/>'); });
  const upstreamServer = upstream.listen(0, '127.0.0.1'); await new Promise(resolve => upstreamServer.once('listening', resolve));
  const app = express();
  const workspace = register({ app, dataDir: dir, verifyToken: async () => null, engine: { base: new URL(`http://127.0.0.1:${upstreamServer.address().port}`), headers: {}, ready: async () => {}, close() {} } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/manga/image`;
  try {
    const cover = await fetch(base + '/10?url=http://127.0.0.1/private');
    assert.equal(cover.status, 200); assert.equal(cover.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await cover.arrayBuffer()), Buffer.from([255, 216, 255]));
    assert.equal((await fetch(base + '/10/2/0')).status, 502);
    assert.deepEqual(requests, ['/api/v1/manga/10/thumbnail', '/api/v1/manga/10/chapter/2/page/0']);
  } finally {
    await new Promise(resolve => server.close(resolve)); await new Promise(resolve => upstreamServer.close(resolve));
    workspace.close(); await fs.rm(dir, { recursive: true, force: true });
  }
});

test('manga progress persists across restart and is isolated by account and chapter', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'haven-manga-store-'));
  let store = createMangaStore(dir);
  try {
    store.save(1, 10, { favorite: true, notes: 'one', chapterId: 101, page: 2, pageCount: 3 });
    store.save(1, 10, { chapterId: 102, page: 0, pageCount: 8 });
    store.save(2, 10, { notes: 'two' });
    store.close(); store = createMangaStore(dir);
    assert.equal(store.list(1)[0].notes, 'one');
    assert.equal(store.list(1)[0].progress[101].read, true);
    assert.equal(store.list(1)[0].progress[102].page, 0);
    assert.equal(store.list(2)[0].notes, 'two');
    assert.equal(store.list(3).length, 0);
  } finally { store.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('manga HTTP routes enforce management permissions, own-account state, chapter ownership, and fixed image paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'haven-manga-routes-'));
  const calls = [];
  const manga = { id: 10, title: '<作品>', sourceId: '6696312508930833206', author: '作者', chapters: { nodes: [{ id: 101, name: '第 1 话', sourceOrder: 1 }] } };
  const engine = {
    status: async () => ({ connected: true, repositories: REPOSITORIES }),
    sources: async () => [{ id: '6696312508930833206', name: '拷贝' }],
    extensions: async () => [], install: async (...args) => { calls.push(args); return { isInstalled: true }; },
    syncRepositories: async () => REPOSITORIES, detail: async () => manga,
    pages: async () => ({ chapter: { mangaId: 10, sourceOrder: 1 }, pages: ['https://untrusted.invalid/image'] }),
    download: async ids => calls.push(ids), browse: async (...args) => { calls.push(args); return { mangas: [] }; },
    close() {}, ready: async () => { throw new Error('invalid image routes must never reach engine'); },
  };
  const app = express(); app.use(express.json());
  const workspace = register({ app, dataDir: dir, engine, verifyToken: async token => token === 'bad' ? Promise.reject(new Error('bad')) : ({ id: token, isAdmin: token === 'admin' }), verifyAdmin: user => user?.isAdmin || false });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/manga`;
  const request = (route, user, body, method = body ? 'POST' : 'GET') => fetch(url + route, { method, headers: { ...(user ? { Authorization: `Bearer ${user}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await request('/library')).status, 401);
    assert.equal((await request('/status', 'bad')).status, 401);
    assert.equal((await request('/repositories/sync', 'reader', {})).status, 403);
    assert.equal((await request('/extensions/valid.pkg', 'reader', { action: 'install' })).status, 403);
    assert.equal((await request('/extensions/valid.pkg', 'admin', { action: 'install' })).status, 200);
    assert.equal((await request('/extensions/valid.pkg', 'admin', { action: 'anything' })).status, 400);
    let response = await request('/library/10', 'one', { favorite: true, title: '<script>', cover: 'http://127.0.0.1/private', chapterId: 101, page: 1, pageCount: 4 }, 'PUT');
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.title, '<作品>');
    assert.equal(saved.cover, '/api/manga/image/10');
    assert.equal(saved.chapterName, '第 1 话');
    assert.equal((await (await request('/library', 'two')).json()).items.length, 0);
    assert.equal((await (await request('/library', 'one')).json()).items.length, 1);
    assert.equal((await request('/library/10', 'one', { chapterId: 999, page: 0, pageCount: 4 }, 'PUT')).status, 400);
    assert.equal((await request('/library/10', 'one', { chapterId: 101, page: 4, pageCount: 4 }, 'PUT')).status, 400);
    assert.equal((await request('/downloads', 'one', { ids: ['bad'] })).status, 400);
    assert.equal((await request('/downloads', 'one', { ids: [101] })).status, 200);
    const pages = await (await request('/chapters/101/pages')).json();
    assert.deepEqual(pages.pages, ['/api/manga/image/10/1/0']);
    assert.equal((await request('/image/10/1/not-a-page')).status, 400);
    assert.equal((await request('/browse/6696312508930833206?page=-1')).status, 400);
    assert.equal((await request('/browse/6696312508930833206?page=1')).status, 200);
    assert.equal(calls.at(-1)[0], '6696312508930833206');
  } finally { await new Promise(resolve => server.close(resolve)); workspace.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
