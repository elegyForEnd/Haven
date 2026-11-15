'use strict';

const { createHash } = require('node:crypto');

function createExternalDanmaku(service, {
  appId = process.env.ANIME_DANDAN_APP_ID,
  secret = process.env.ANIME_DANDAN_APP_SECRET,
  filterUrl = process.env.ANIME_DANMAKU_FILTER_URL,
  fetchImpl = fetch
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  let filter;
  async function json(url, headers) {
    const response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(6500) });
    if (!response.ok) throw new Error('Danmaku source returned ' + response.status);
    return response.json();
  }
  function dandan(path) {
    const stamp = String(Math.floor(Date.now() / 1000));
    const url = new URL(path, 'https://api.dandanplay.net');
    const signature = createHash('sha256').update(appId + stamp + url.pathname + secret).digest('base64');
    return json(url.href, { 'X-AppId': appId, 'X-Timestamp': stamp, 'X-Signature': signature });
  }
  async function blockedWords() {
    if (!filterUrl) return [];
    if (filter?.until > Date.now()) return filter.words;
    const url = new URL(filterUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid danmaku filter URL');
    const { blockedWords } = await json(url.href);
    if (!Array.isArray(blockedWords)) throw new Error('Invalid danmaku filter');
    const words = blockedWords.slice(0, 500).filter(word => typeof word === 'string' && word.trim() && word.length <= 150)
      .map(word => word.trim().normalize('NFKC').toLowerCase());
    filter = { words, until: Date.now() + 3600000 };
    return words;
  }
  async function load(subject, sort) {
    const { items } = await service.episodes(subject);
    const episode = items.find(item => item.sort === sort);
    if (!episode) return { items: [], errors: [] };
    const providers = [['Animeko', async () => {
      const result = await json('https://danmaku-cn.myani.org/v1/danmaku/' + episode.id + '?maxCount=3000')
        .catch(() => json('https://danmaku-global.myani.org/v1/danmaku/' + episode.id + '?maxCount=3000'));
      return result.danmakuList.map(row => ({ time: row.danmakuInfo.playTime / 1000, text: row.danmakuInfo.text }));
    }]];
    if (appId && secret) providers.push(['弹弹play', async () => {
      const result = await dandan('/api/v2/bangumi/bgmtv/' + subject);
      const matches = (result.bangumi?.episodes || []).filter(row => {
        const title = String(row.episodeTitle).normalize('NFKC');
        const explicit = row.episodeNumber ?? title.match(/^(?:第\s*)?(\d+(?:\.\d+)?)(?:\s*[话話集]|[ .：:]|$)/)?.[1];
        return Number(explicit) === sort || (episode.name && title === episode.name.normalize('NFKC'));
      });
      if (matches.length !== 1 || !Number.isSafeInteger(matches[0].episodeId)) return [];
      const comments = await dandan('/api/v2/comment/' + matches[0].episodeId + '?withRelated=true&chConvert=1');
      return comments.comments.map(row => ({ time: Number(String(row.p).split(',')[0]), text: row.m }));
    }]);
    const [settled, rules] = await Promise.all([
      Promise.allSettled(providers.map(([, fetchRows]) => fetchRows())),
      blockedWords().catch(() => null)
    ]);
    const merged = [];
    const errors = rules ? [] : ['云过滤规则'];
    const seen = new Set();
    settled.forEach((result, index) => {
      const source = providers[index][0];
      if (result.status === 'rejected') { errors.push(source); return; }
      for (const row of result.value.slice(0, 3500)) {
        if (!Number.isFinite(row.time) || row.time < 0 || row.time > 86400 || typeof row.text !== 'string') continue;
        const text = row.text.trim().slice(0, 150);
        if (rules?.some(word => text.normalize('NFKC').toLowerCase().includes(word))) continue;
        const key = Math.floor(row.time / 2) + ':' + text.normalize('NFKC');
        if (!text || seen.has(key)) continue;
        seen.add(key);
        merged.push({ id: 'external-' + merged.length, time: row.time, text, source });
      }
    });
    return { items: merged.sort((a, b) => a.time - b.time).slice(0, 4000), errors };
  }
  return async (subject, sort) => {
    const key = subject + '/' + sort;
    if (cache.get(key)?.until > Date.now()) return cache.get(key).value;
    if (inflight.has(key)) return inflight.get(key);
    if (inflight.size >= 8) return { items: [], errors: ['外部弹幕'] };
    const request = load(subject, sort).then(value => {
      if (cache.size >= 80) cache.delete(cache.keys().next().value);
      cache.set(key, { until: Date.now() + (value.errors.length ? 60000 : 300000), value });
      return value;
    }).finally(() => inflight.delete(key));
    inflight.set(key, request);
    return request;
  };
}

module.exports = { createExternalDanmaku };
