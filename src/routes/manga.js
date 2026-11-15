'use strict';
const path = require('node:path');
const { Readable } = require('node:stream');
const { rateLimit } = require('express-rate-limit');
const { createMangaEngine } = require('../manga-engine');
const { createMangaStore } = require('../manga-store');

module.exports = function registerManga({ app, dataDir, verifyToken, verifyAdmin = () => false, engine = createMangaEngine({ dataDir }), store = createMangaStore(dataDir) }) {
  const router = require('express').Router();
  const id = value => /^\d{1,10}$/.test(String(value)) && Number(value) > 0 && Number(value) <= 2147483647;
  const handle = fn => async (req, res) => {
    try { await fn(req, res); } catch (error) {
      console.warn('[manga]', error.message);
      if (!res.headersSent) res.status(502).json({ error: String(error.message).slice(0, 350) });
      else res.destroy();
    }
  };
  router.use(async (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      req.mangaUser = req.postgresUser || (token ? await verifyToken(token) : null);
      next();
    } catch { res.status(401).json({ error: '登录已过期，请重新登录' }); }
  });
  const auth = (req, res, next) => req.mangaUser ? next() : res.status(401).json({ error: '登录后即可同步书架和阅读进度' });
  const admin = (req, res, next) => verifyAdmin(req.mangaUser) ? next() : res.status(403).json({ error: '仅服务器管理员可以安装和管理图源扩展' });
  router.get('/image/:mangaId/:chapterIndex?/:page?', handle(async (req, res) => {
    if (!id(req.params.mangaId)) return res.sendStatus(400);
    const { mangaId, chapterIndex, page } = req.params;
    if ((chapterIndex !== undefined && !/^\d{1,6}$/.test(chapterIndex)) || (page !== undefined && !/^\d{1,6}$/.test(page)) || (chapterIndex === undefined) !== (page === undefined)) return res.sendStatus(400);
    await engine.ready();
    const target = chapterIndex === undefined ? `/api/v1/manga/${mangaId}/thumbnail` : `/api/v1/manga/${mangaId}/chapter/${chapterIndex}/page/${page}`;
    const upstream = await fetch(new URL(target, engine.base), { headers: engine.headers, signal: AbortSignal.timeout(90000), redirect: 'error' });
    if (!upstream.ok) { await upstream.body?.cancel(); return res.sendStatus(upstream.status); }
    const type = (upstream.headers.get('content-type') || '').replace(/^image\/jpg\b/i, 'image/jpeg');
    if (!/^image\/(jpeg|png|webp|gif|avif|bmp)(?:;|$)/i.test(type)) { await upstream.body?.cancel(); return res.status(502).end(); }
    res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    const stream = Readable.fromWeb(upstream.body);
    res.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }));
  router.use(rateLimit({ windowMs: 60000, limit: 160, standardHeaders: true, legacyHeaders: false }));
  router.get('/status', handle(async (req, res) => res.json({ ...await engine.status(), canManage: verifyAdmin(req.mangaUser) })));
  router.post('/engine/start', admin, handle(async (_req, res) => { await engine.ready(); res.json(await engine.status()); }));
  router.get('/extensions', handle(async (req, res) => res.json({ items: await engine.extensions(), canManage: verifyAdmin(req.mangaUser) })));
  router.post('/repositories/sync', admin, handle(async (_req, res) => res.json({ items: await engine.syncRepositories() })));
  router.post('/extensions/:pkg', admin, handle(async (req, res) => {
    if (!/^[\w.]{1,220}$/.test(req.params.pkg) || !['install', 'update', 'uninstall'].includes(req.body?.action)) return res.sendStatus(400);
    res.json(await engine.install(req.params.pkg, req.body.action));
  }));
  router.get('/sources', handle(async (_req, res) => res.json({ items: await engine.sources() })));
  router.get('/browse/:source', handle(async (req, res) => {
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const query = String(req.query.q || '').trim();
    if (!/^-?\d{1,20}$/.test(req.params.source) || !Number.isSafeInteger(page) || page < 1 || page > 1000 || query.length > 100) return res.sendStatus(400);
    res.json(await engine.browse(req.params.source, page, query, req.query.latest === '1'));
  }));
  router.get('/library', auth, (req, res) => res.set('Cache-Control', 'no-store').json({ items: store.list(req.mangaUser.id) }));
  router.put('/library/:id', auth, handle(async (req, res) => {
    if (!id(req.params.id)) return res.sendStatus(400);
    const input = req.body || {}, patch = {};
    if (input.chapterRead !== undefined) {
      if (typeof input.chapterRead !== 'boolean') return res.sendStatus(400);
      patch.chapterRead = input.chapterRead;
    }
    if (input.status !== undefined) {
      if (!['reading', 'wish', 'done', 'history'].includes(input.status)) return res.sendStatus(400);
      patch.status = input.status;
    }
    if (input.favorite !== undefined) {
      if (typeof input.favorite !== 'boolean') return res.sendStatus(400);
      patch.favorite = input.favorite;
    }
    if (input.notes !== undefined) {
      if (typeof input.notes !== 'string' || input.notes.length > 5000) return res.sendStatus(400);
      patch.notes = input.notes;
    }
    for (const key of ['chapterId', 'page', 'pageCount', 'bookmarkedChapter', 'bookmarkedPage']) if (input[key] !== undefined) {
      if (!Number.isSafeInteger(input[key]) || input[key] < 0 || input[key] > (['chapterId', 'bookmarkedChapter'].includes(key) ? 2147483647 : 100000)) return res.sendStatus(400);
      patch[key] = input[key];
    }
    // Fetch metadata from the engine rather than trusting client-supplied HTML or URLs.
    const manga = await engine.detail(Number(req.params.id), false);
    patch.title = manga.title;
    patch.sourceId = String(manga.sourceId);
    patch.author = manga.author;
    patch.cover = `/api/manga/image/${manga.id}`;
    if (input.downloads !== undefined) {
      if (!Array.isArray(input.downloads) || input.downloads.length > 10000 || !input.downloads.every(value => Number.isSafeInteger(value) && manga.chapters.nodes.some(chapter => chapter.id === value))) return res.sendStatus(400);
      patch.downloads = [...new Set(input.downloads)];
    }
    if (input.bookmarkedChapter && !manga.chapters.nodes.some(chapter => chapter.id === input.bookmarkedChapter)) return res.sendStatus(400);
    if (input.chapterId) {
      const chapter = manga.chapters.nodes.find(item => item.id === input.chapterId);
      if (!chapter) return res.status(400).json({ error: '章节不属于此漫画' });
      patch.chapterName = chapter.name;
      patch.lastReadAt = Date.now();
      if (!Number.isSafeInteger(input.page) || !Number.isSafeInteger(input.pageCount) || input.pageCount < 1 || input.page >= input.pageCount) return res.status(400).json({ error: '无效的阅读进度' });
    }
    res.json(store.save(req.mangaUser.id, Number(req.params.id), patch));
  }));
  router.get('/manga/:id', handle(async (req, res) => {
    if (!id(req.params.id)) return res.sendStatus(400);
    res.json(await engine.detail(Number(req.params.id), req.query.refresh !== '0'));
  }));
  router.get('/chapters/:id/pages', handle(async (req, res) => {
    if (!id(req.params.id)) return res.sendStatus(400);
    const data = await engine.pages(Number(req.params.id));
    // Construct fixed engine routes. Never accept arbitrary image URLs from the browser.
    res.json({ chapter: data.chapter, pages: data.pages.map((_page, index) => `/api/manga/image/${data.chapter.mangaId}/${data.chapter.sourceOrder}/${index}`) });
  }));
  router.post('/downloads', auth, handle(async (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every(id)) return res.sendStatus(400);
    await engine.download(ids.map(Number));
    res.json({ queued: ids.length });
  }));
  app.use('/api/manga', router);
  app.get('/manga', (_req, res) => res.sendFile(path.join(__dirname, '../../public/manga.html')));
  return { engine, store, close() { engine.close(); store.close(); } };
};
