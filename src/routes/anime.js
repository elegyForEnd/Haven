'use strict';

const path = require('node:path');
const { rateLimit } = require('express-rate-limit');
const { createAnimeService, matchName } = require('../anime-service');
const { createTorrentSources } = require('../anime-torrent');
const { createPikPakAccount } = require('../anime-pikpak-account');
const { createLibrarySources } = require('../anime-library-sources');
const { createMediaRelay } = require('../anime-media');
const { createAnimeStore } = require('../anime-store');
const { createBangumiSync } = require('../anime-bangumi');
const { createExternalDanmaku } = require('../anime-danmaku');
const { createCoverCache } = require('../anime-covers');
const { createTmdbArtwork } = require('../anime-tmdb');

module.exports = function registerAnime({ app, dataDir, verifyToken, verifyAdmin = () => false, service = createAnimeService(), store = createAnimeStore(dataDir), relay = createMediaRelay(), pikpak = createPikPakAccount(dataDir) }) {
  const api = require('express').Router();
  const readLimit = rateLimit({ windowMs: 60000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const writeLimit = rateLimit({ windowMs: 60000, limit: 45, standardHeaders: true, legacyHeaders: false });
  const resolveLimit = rateLimit({ windowMs: 60000, limit: 12, standardHeaders: true, legacyHeaders: false });
  const torrent = createTorrentSources({ dataDir, subject: service.subject, normalize: matchName, pikpak });
  const libraries = createLibrarySources();
  const bangumi = createBangumiSync(service, store);
  const externalDanmaku = createExternalDanmaku(service);
  const covers = createCoverCache(dataDir);
  const tmdb = createTmdbArtwork();
  let warmedHome;
  const id = v => /^\d{1,9}$/.test(String(v)) && Number(v) > 0;
  const ep = v => Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 10000;
  const handler = fn => async (req, res) => { try { await fn(req, res); } catch (e) { console.warn('[anime]', e.message); if (!res.headersSent) res.status(502).json({ error: '服务暂时不可用，请稍后重试' }); } };
  api.use(async (req, res, next) => {
    try { const token = req.headers.authorization?.replace(/^Bearer /, ''); req.animeUser = req.postgresUser || (token ? await verifyToken(token) : null); next(); }
    catch { res.status(401).json({ error: '登录已过期，请重新登录' }); }
  });
  const auth = (req, res, next) => req.animeUser ? next() : res.status(401).json({ error: '登录后即可同步追番、发送弹幕和参与讨论' });
  api.get('/media/:key', relay.handle);
  api.get('/torrent/:key', torrent.handle);
  api.get('/covers/*', handler(covers.handle));
  api.use(readLimit);
  api.get('/pikpak', (req, res) => {
    res.set('Cache-Control', 'no-store').json(verifyAdmin(req.animeUser)
      ? { canManage: true, ...pikpak.status() } : { canManage: false });
  });
  const managePikPak = (req, res, next) => verifyAdmin(req.animeUser)
    ? next() : res.status(403).json({ error: '仅服务器管理员可以管理 PikPak' });
  const pikpakLimit = rateLimit({ windowMs: 60000, limit: 5, standardHeaders: true, legacyHeaders: false });
  api.put('/pikpak', managePikPak, pikpakLimit, async (req, res) => {
    const { username, password, folderId } = req.body || {};
    if (typeof username !== 'string' || !username.trim() || username.length > 254 ||
      typeof password !== 'string' || !password || password.length > 1024) {
      return res.status(400).json({ error: '请输入 PikPak 账号和密码' });
    }
    if (typeof folderId !== 'string' || !/^[\w-]{1,128}$/.test(folderId.trim())) {
      return res.status(400).json({ error: '请输入有效的 PikPak 目录 ID' });
    }
    try {
      await pikpak.connect(username.trim(), password, folderId.trim());
      return res.json(pikpak.status());
    } catch (error) {
      if (error.invalidFolder) return res.status(400).json({ error: '找不到此目录，请核对目录 ID 和 PikPak 账号' });
      return res.status(502).json({ error: 'PikPak 连接失败，请核对账号密码，并在 PikPak 完成账号验证后重试' });
    }
  });
  api.delete('/pikpak', managePikPak, pikpakLimit, handler(async (_req, res) => {
    pikpak.disconnect();
    res.json(pikpak.status());
  }));
  api.post('/pikpak/test', managePikPak, pikpakLimit, async (_req, res) => {
    try {
      if (!(await pikpak.test())) return res.status(400).json({ error: '请先登录 PikPak 账号' });
      return res.json({ connected: true });
    } catch {
      return res.status(502).json({ error: 'PikPak 连接不可用，请重新登录后重试' });
    }
  });
  api.get('/home', handler(async (_req, res) => {
    const home = await service.home();
    res.json(home);
    const weekday = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' });
    const today = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday) + 1;
    if (warmedHome?.home === home && warmedHome.today === today) return;
    warmedHome = { home, today };
    const selected = [...home.featured, ...(home.calendar?.find(day => day.weekday === today)?.items || [])];
    void covers.warm(selected.map(show => show.image)).catch(() => {});
  }));
  api.get('/calendar', handler(async (_req, res) => res.json(await service.calendar())));
  api.get('/rankings', handler(async (req, res) => {
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) return res.status(400).json({ error: '无效页码' });
    res.json(await service.rankings(page));
  }));
  api.get('/search', handler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q || q.length > 100) return res.status(400).json({ error: '请输入 1–100 字的搜索关键词' });
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) return res.status(400).json({ error: '无效页码' });
    res.json(await service.search(q, ['match', 'rank', 'heat', 'score'].includes(req.query.sort) ? req.query.sort : 'match', page));
  }));
  api.get('/subjects/:id', handler(async (req, res) => {
    if (!id(req.params.id)) return res.status(400).json({ error: '无效番剧编号' });
    res.json(await service.subject(Number(req.params.id)));
  }));
  api.get('/subjects/:id/episodes', handler(async (req, res) => {
    if (!id(req.params.id)) return res.status(400).json({ error: '无效番剧编号' });
    res.json(await service.episodes(Number(req.params.id)));
  }));
  api.get('/subjects/:id/details', handler(async (req, res) => {
    if (!id(req.params.id)) return res.status(400).json({ error: '无效番剧编号' });
    res.json(await service.details(Number(req.params.id)));
  }));
  api.get('/subjects/:id/artwork', handler(async (req, res) => {
    if (!id(req.params.id)) return res.status(400).json({ error: '无效番剧编号' });
    if (!tmdb.enabled) return res.json({ source: null, posters: [], backdrops: [] });
    res.json(await tmdb.artwork(await service.subject(Number(req.params.id))));
  }));
  api.get('/subjects/:id/specials', handler(async (req, res) => {
    if (!id(req.params.id)) return res.status(400).json({ error: '无效番剧编号' });
    res.json(await service.episodes(Number(req.params.id), 1));
  }));
  api.get('/subjects/:id/play/:episode', resolveLimit, handler(async (req, res) => {
    if (!id(req.params.id) || !ep(req.params.episode)) return res.status(400).json({ error: '无效集数' });
    if (req.query.type === 'torrent') {
      const personal = req.animeUser ? store.sources(req.animeUser.id) : [];
      const cloud = req.animeUser && !req.animeUser.isGuest ? pikpak.generation() : false;
      return res.json(await torrent.resolve(Number(req.params.id), Number(req.params.episode), personal, cloud));
    }
    const resolve = req.query.type === 'web' ? service.resolveWeb : service.resolve;
    const subjectId = Number(req.params.id);
    const episode = Number(req.params.episode);
    const result = await resolve(subjectId, episode);
    if (req.query.type !== 'web' && req.animeUser && libraries.enabled) {
      const extra = await libraries.resolve(await service.subject(subjectId), episode);
      result.streams = [...result.streams, ...extra.streams.map(stream => ({ ...stream, relayOnly: true, category: 'library' }))];
      result.errors = [...result.errors, ...extra.errors];
    }
    res.json({ ...result, streams: result.streams.map(({ url, referer, userAgent, headers, relayOnly, ...s }) => ({
      ...s, url: relay.issue(url, referer, userAgent, headers),
      ...(!relayOnly && !headers && { directUrl: url })
    })) });
  }));
  api.get('/sources', auth, (req, res) => res.json({ items: store.sources(req.animeUser.id) }));
  api.put('/sources', auth, writeLimit, (req, res) => {
    const sources = req.body?.items;
    if (!Array.isArray(sources) || sources.length > 5 || JSON.stringify(sources).length > 24000 ||
        sources.some(source => source?.factoryId !== 'rss' ||
          typeof source.arguments?.name !== 'string' || !source.arguments.name.trim() ||
          typeof source.arguments.searchConfig?.searchUrl !== 'string' ||
          !/^https:\/\//i.test(source.arguments.searchConfig.searchUrl) ||
          !source.arguments.searchConfig.searchUrl.includes('{keyword}'))) {
      return res.status(400).json({ error: '请输入最多 5 条带有 {keyword} 的 HTTPS RSS 源。CSS 源由服务器配置。' });
    }
    store.saveSources(req.animeUser.id, sources);
    res.json({ ok: true });
  });
  api.get('/library', auth, (req, res) => res.json({ items: store.library(req.animeUser.id) }));
  api.post('/bangumi', auth, resolveLimit, handler(async (req, res) => {
    const { accessToken, direction, subjectId } = req.body || {};
    if (typeof accessToken !== 'string' || !/^[\x21-\x7e]{8,2048}$/.test(accessToken) ||
        !['collections', 'pull', 'push'].includes(direction) || (direction !== 'collections' && !id(subjectId))) {
      return res.status(400).json({ error: '请填写有效的 Bangumi 访问令牌和同步范围' });
    }
    res.set('Cache-Control', 'no-store');
    try {
      const user = req.animeUser.id;
      res.json(direction === 'collections' ? await bangumi.pull(accessToken, user)
        : await bangumi.syncEpisode(accessToken, user, Number(subjectId), direction));
    } catch (error) {
      if (error.status === 403) return res.status(403).json({ error: error.message });
      throw error;
    }
  }));
  api.put('/library/:id', auth, writeLimit, (req, res) => {
    if (!id(req.params.id)) return res.status(400).json({ error: '无效番剧编号' });
    const b = req.body || {}; const changes = {};
    if ('status' in b) {
      if (!['wish', 'doing', 'done', 'history'].includes(b.status)) return res.status(400).json({ error: '无效收藏状态' });
      changes.status = b.status;
    }
    for (const key of ['episode', 'position', 'duration']) if (key in b) {
      if (typeof b[key] !== 'number' || !Number.isFinite(b[key]) || b[key] < 0 || b[key] > (key === 'episode' ? 10000 : 86400)) return res.status(400).json({ error: '无效观看进度' });
      changes[key] = b[key];
    }
    if ('watched' in b) {
      if (!Array.isArray(b.watched) || b.watched.length > 500 || b.watched.some(v => typeof v !== 'number' || !ep(v))) return res.status(400).json({ error: '无效已看集数' });
      changes.watched = b.watched;
    }
    res.json(store.save(req.animeUser.id, Number(req.params.id), changes));
  });
  api.delete('/library/:id', auth, (req, res) => {
    if (!id(req.params.id)) return res.status(400).json({ error: '无效番剧编号' });
    store.remove(req.animeUser.id, Number(req.params.id)); res.json({ ok: true });
  });
  api.get('/subjects/:id/comments/:episode', (req, res) => {
    if (!id(req.params.id) || !ep(req.params.episode)) return res.status(400).json({ error: '无效集数' });
    res.json({ items: store.comments(Number(req.params.id), Number(req.params.episode), req.animeUser?.id, req.query.sort) });
  });
  api.post('/subjects/:id/comments/:episode', auth, writeLimit, (req, res) => {
    const text = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!id(req.params.id) || !ep(req.params.episode) || !text || text.length > 2000) return res.status(400).json({ error: '评论须为 1–2000 字' });
    store.comment(req.animeUser.id, req.animeUser.displayName || req.animeUser.username, Number(req.params.id), Number(req.params.episode), text, req.body.spoiler === true);
    res.status(201).json({ ok: true });
  });
  api.post('/comments/:id/like', auth, writeLimit, (req, res) => {
    if (!id(req.params.id) || !store.like(req.animeUser.id, Number(req.params.id))) return res.status(404).json({ error: '评论不存在' });
    res.json({ ok: true });
  });
  api.get('/subjects/:id/danmaku/:episode', (req, res) => {
    if (!id(req.params.id) || !ep(req.params.episode)) return res.status(400).json({ error: '无效集数' });
    res.json({ items: store.danmaku(Number(req.params.id), Number(req.params.episode)) });
  });
  api.get('/subjects/:id/danmaku/:episode/external', handler(async (req, res) => {
    if (!id(req.params.id) || !ep(req.params.episode)) return res.status(400).json({ error: '无效集数' });
    res.json(await externalDanmaku(Number(req.params.id), Number(req.params.episode)));
  }));
  api.post('/subjects/:id/danmaku/:episode', auth, writeLimit, (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''; const time = req.body?.time;
    if (!id(req.params.id) || !ep(req.params.episode) || !text || text.length > 100 || typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time > 86400) return res.status(400).json({ error: '请输入 1–100 字弹幕' });
    store.sendDanmaku(req.animeUser.id, Number(req.params.id), Number(req.params.episode), time, text);
    res.status(201).json({ ok: true });
  });
  app.use('/api/anime', api);
  app.get('/anime', (_req, res) => res.sendFile(path.join(__dirname, '../../public/anime.html')));
  app.use('/vendor/anime-hls', require('express').static(path.join(__dirname, '../../node_modules/hls.js/dist'), { index: false, dotfiles: 'deny' }));
  return { store, covers };
};
