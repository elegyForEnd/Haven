'use strict';

const { resolveWebSource } = require('./anime-web-source');
const { coverUrl } = require('./anime-covers');

const SUBSCRIPTION = 'https://sub.creamycake.org/v1/css1.json';
const BANGUMI = 'https://api.bgm.tv';
const BANGUMI_TRENDING = 'https://next.bgm.tv/p1/trending/subjects?type=2&limit=16';
const UA = 'Ciacord/1.0 (https://github.com/open-ani/animeko)';

function normalizeSubject(s) {
  return { id: s.id, name: s.name_cn || s.name, originalName: s.name, summary: s.summary || '',
    image: coverUrl(s.images?.large || s.images?.common || s.images?.medium),
    largeImage: coverUrl(s.images?.large || s.images?.common || s.images?.medium),
    score: Number(s.rating?.score || 0), rank: s.rating?.rank || s.rank || 0,
    episodes: s.eps || s.eps_count || s.total_episodes || 0, date: s.date || s.air_date || '',
    popularity: Object.values(s.collection || {}).reduce((a,v) => a + (Number(v) || 0), 0),
    tags: (s.tags || []).slice(0, 8).map(t => typeof t === 'string' ? t : t.name), type: s.type };
}

// Restricted JSONPath subset used by Animeko's public json-api subscription.
// No eval, scripts, recursive descent or executable expressions.
function select(data, path) {
  if (!path || path === '$') return [data];
  if (!/^\$(?:\.[\w-]+|\[\*\]|\[\d+\])*$/.test(path)) throw new Error('不支持的数据源字段路径');
  const parts = path.slice(1).match(/\.[\w-]+|\[\*\]|\[\d+\]/g) || [];
  return parts.reduce((rows, part) => rows.flatMap(v => {
    if (part === '[*]') return Array.isArray(v) ? v : [];
    const key = part.startsWith('.') ? part.slice(1) : Number(part.slice(1, -1));
    return v?.[key] === undefined ? [] : [v[key]];
  }), [data]);
}
const one = (data, path) => select(data, path)[0];
function template(text, vars, mode = 'url') {
  return String(text || '').replace(/\{(\w+)\}/g, (_, key) => {
    const v = vars[key] ?? '';
    return mode === 'json' ? JSON.stringify(String(v)).slice(1, -1) : encodeURIComponent(v);
  });
}
function parseHeaders(text) {
  return Object.fromEntries(String(text || '').split('\n').filter(x => x.includes(':')).map(x => {
    const p = x.indexOf(':'); return [x.slice(0, p).trim(), x.slice(p + 1).trim()];
  }));
}
function matchName(text) {
  return String(text).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function createAnimeService({ fetchImpl = fetch } = {}) {
  const cache = new Map();
  const inflight = new Map();
  async function json(url, options = {}, ttl = 300000) {
    const key = url + (options.body || '');
    if (cache.get(key)?.until > Date.now()) return cache.get(key).data;
    if (inflight.has(key)) return inflight.get(key);
    const task = (async () => {
      const response = await fetchImpl(url, { ...options, headers: { 'User-Agent': UA, 'Accept': 'application/json', ...options.headers }, signal: AbortSignal.timeout(18000) });
      if (!response.ok) throw new Error(`上游服务暂时不可用 (${response.status})`);
      const data = await response.json();
      if (ttl) { if (cache.size > 500) cache.delete(cache.keys().next().value); cache.set(key, { data, until: Date.now() + ttl }); }
      return data;
    })();
    inflight.set(key, task);
    try { return await task; } finally { inflight.delete(key); }
  }
  async function subject(id) {
    const data = await json(`${BANGUMI}/v0/subjects/${id}`, {}, 3600000);
    if (data.type !== 2) throw new Error('该条目不是动画');
    const info = (data.infobox || []).filter(field => ['动画制作', '导演', '原作', '官方网站'].includes(field.key))
      .map(({ key, value }) => ({ key, value: Array.isArray(value) ? value.map(item => item.v).filter(Boolean).join('、') : String(value || '') }))
      .filter(field => field.value);
    return { ...normalizeSubject(data), platform: data.platform || '', info };
  }
  async function details(id) {
    const [show, cast, relations] = await Promise.all([
      subject(id),
      json(`${BANGUMI}/v0/subjects/${id}/characters`, {}, 3600000).catch(() => []),
      json(`${BANGUMI}/v0/subjects/${id}/subjects`, {}, 3600000).catch(() => []),
    ]);
    return {
      ...show,
      characters: cast.slice(0, 8).map(character => ({
        id: character.id, name: character.name, role: character.relation,
        image: character.images?.large || character.images?.medium || '',
        actors: (character.actors || []).map(actor => actor.name),
      })),
      related: relations.filter(item => item.type === 2 || item.relation === '原作' || item.relation === '改编')
        .slice(0, 12).map(item => ({ ...normalizeSubject(item), relation: item.relation })),
    };
  }
  async function calendar() {
    return (await json(`${BANGUMI}/calendar`, {}, 1800000)).map(day => ({ weekday: day.weekday, items: day.items.filter(s => s.type === 2).map(normalizeSubject) }));
  }
  let homepage;
  let refreshing;
  async function refreshHome() {
    const [featured, days] = await Promise.all([
      trending(), calendar().catch(() => [])
    ]);
    return { featured, calendar: days.length ? days : homepage?.data.calendar || [], attribution: 'Bangumi · Animeko 数据源', subscription: SUBSCRIPTION };
  }
  async function trending() {
    const { data } = await json(BANGUMI_TRENDING, {}, 0);
    const entries = (data || []).map(row => row.subject)
      .filter(s => s?.type === 2 && !s.nsfw && Number.isSafeInteger(s.id));
    if (!entries.length) throw new Error('Bangumi 热度榜暂时无法加载，请稍后重试');
    return Promise.all(entries.map(s => subject(s.id).catch(() =>
      normalizeSubject({ ...s, name_cn: s.nameCN, tags: s.metaTags })
    )));
  }
  async function rankings(page) {
    const pageSize = 20;
    const url = new URL(BANGUMI_TRENDING);
    url.searchParams.set('limit', pageSize);
    const fetchPage = number => {
      url.searchParams.set('offset', (number - 1) * pageSize);
      return json(url.href, {}, 1800000);
    };
    let { data, total } = await fetchPage(page);
    if (!Array.isArray(data) || !Number.isSafeInteger(total)) throw new Error('Bangumi 热度榜暂时无法加载，请稍后重试');
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (page > pages) {
      page = pages;
      ({ data } = await fetchPage(page));
    }
    const items = data.flatMap(({ subject: s }, index) =>
      s?.type === 2 && !s.nsfw && Number.isSafeInteger(s.id)
        ? [{ ...normalizeSubject({ ...s, name_cn: s.nameCN, tags: s.metaTags }), position: (page - 1) * pageSize + index + 1 }]
        : []
    );
    return { items, total, page, pages };
  }
  async function home() {
    if (homepage?.until > Date.now()) return homepage.data;
    refreshing ||= refreshHome().then(data => {
      homepage = { data, until: Date.now() + 1800000 };
      return data;
    }).catch(error => {
      if (!homepage) throw error;
      homepage.until = Date.now() + 60000;
      return homepage.data;
    }).finally(() => { refreshing = null; });
    if (homepage) {
      void refreshing;
      return homepage.data;
    }
    return refreshing;
  }
  async function search(keyword, sort = 'match', page = 1) {
    const pageSize = 20;
    const tag = ['治愈','奇幻','青春','恋爱','日常','科幻','冒险','音乐','搞笑'].includes(keyword);
    const options = {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: tag ? '' : keyword, sort: tag && sort === 'match' ? 'heat' : sort, filter: { type: [2], nsfw: false, ...(tag ? { tag: [keyword] } : {}) } })
    };
    const fetchPage = number => json(`${BANGUMI}/v0/search/subjects?limit=${pageSize}&offset=${(number - 1) * pageSize}`, options);
    let data = await fetchPage(page);
    const pages = Math.max(1, Math.ceil(data.total / pageSize));
    if (page > pages) {
      page = pages;
      data = await fetchPage(page);
    }
    if (page === 1 && !data.total && !tag) {
      try {
        const characters = await json(`${BANGUMI}/v0/search/characters?limit=3`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyword, filter: { nsfw: false } })
        });
        const related = await Promise.all(characters.data.map(c => json(`${BANGUMI}/v0/characters/${c.id}/subjects`)));
        const shows = [...new Map(related.flat().filter(s=>s.type === 2).sort((a,b)=>(a.staff === '主角' ? 0 : 1)-(b.staff === '主角' ? 0 : 1)).map(s=>[s.id,s])).values()];
        const results = await Promise.allSettled(shows.slice(0,12).map(s=>subject(s.id)));
        const items = results.filter(r=>r.status === 'fulfilled').map(r=>r.value);
        if (items.length) return { items, total: items.length, page, pages: 1, matchedBy: 'character' };
      } catch { /* A failed character lookup does not hide the subject results. */ }
    }
    return { items: data.data.map(normalizeSubject), total: data.total, page, pages };
  }
  async function episodes(id, type = 0) {
    const data = await json(`${BANGUMI}/v0/episodes?subject_id=${id}&type=${type}&limit=100`, {}, 3600000);
    const rows = [...data.data];
    // Long-running series must not silently stop at episode 100.
    for (let offset = 100; offset < Math.min(data.total, 2000); offset += 100) {
      const page = await json(`${BANGUMI}/v0/episodes?subject_id=${id}&type=${type}&limit=100&offset=${offset}`, {}, 3600000);
      rows.push(...page.data);
    }
    return { items: rows.map(e => ({ id: e.id, sort: e.sort, name: e.name_cn || e.name, description: e.desc || '', duration: e.duration, airdate: e.airdate })), total: data.total };
  }
  async function sources(type) {
    const sub = await json(SUBSCRIPTION, {}, 3600000);
    const custom = process.env.ANIME_CUSTOM_WEB_SOURCES ? JSON.parse(process.env.ANIME_CUSTOM_WEB_SOURCES) : [];
    return [...sub.mediaSources, ...custom].filter(s => s.factoryId === type && s.arguments?.searchConfig);
  }
  async function sourceRequest(c, request, vars, ttl) {
    const url = new URL(template(request.url, vars), c.baseUrl);
    // These templates come exclusively from the official public subscription.
    if (url.protocol !== 'https:') throw new Error('数据源必须使用 HTTPS');
    return json(url.href, { method: request.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...parseHeaders(c.headers), ...parseHeaders(request.headers) },
      ...(request.body ? { body: template(request.body, vars, 'json') } : {}) }, ttl);
  }
  async function resolve(id, episodeSort) {
    const show = await subject(id);
    const adapters = await sources('json-api');
    const streams = []; const errors = [];
    for (const adapter of adapters) {
      try {
        const c = adapter.arguments.searchConfig;
        const names = [...new Set([show.name, show.originalName])];
        let found;
        for (const name of names) {
          const result = await sourceRequest(c, c.search.request, { keyword: name, page: 1, pageSize: c.search.pageSize || 50 }, 1800000);
          const rows = select(result, c.search.selectItems);
          found = rows.find(s => {
            const aliases = [one(s, c.search.selectName), s.title_original, s.name_original, ...(Array.isArray(s.aliases) ? s.aliases : [])].filter(Boolean);
            return names.some(n => aliases.some(alias => matchName(alias) === matchName(n)));
          });
          if (found) break;
        }
        if (!found) continue; // Never play a similarly named but different season.
        const sourceSubject = one(found, c.search.selectId);
        const detail = await sourceRequest(c, c.subject.request, { id: sourceSubject }, 1800000);
        const channels = c.subject.channelFormatId === 'grouped'
          ? select(detail, c.subject.channelFormatGrouped.selectChannels) : [detail];
        const requested = new Set();
        for (const channel of channels) {
          const ec = c.subject.episodes;
          const ep = select(channel, ec.selectEpisodes).find(e => Number(one(e, ec.selectSort)) === episodeSort && (!ec.selectType || ['main', 'movie', 'MainStory'].includes(String(one(e, ec.selectType)))));
          if (!ep) continue;
          const epId = one(ep, ec.selectId);
          if (requested.has(epId)) continue;
          requested.add(epId);
          const play = await sourceRequest(c, c.play.request, { id: epId, subjectId: sourceSubject }, 0);
          const candidates = c.play.selectCandidates ? select(play, c.play.selectCandidates) : [play];
          for (const candidate of candidates) {
            const url = one(candidate, c.play.selectVideoUrl);
            if (typeof url !== 'string' || !/^https:\/\//i.test(url)) continue;
            if (streams.some(s => s.url === url)) continue;
            streams.push({ url, name: one(candidate, c.play.selectCandidateChannel) || adapter.arguments.name,
              provider: adapter.arguments.name, resolution: c.defaultResolution || '原画',
              subtitle: c.defaultSubtitleLanguage || '内嵌字幕', referer: c.play.referer || '',
              type: /\.m3u8(?:\?|$)/i.test(url) ? 'hls' : 'video' });
          }
        }
      } catch (e) { errors.push(adapter.arguments.name); }
    }
    return { streams, errors, message: streams.length ? '' : '当前数据源暂未找到这一话的可播放资源，请稍后重试。' };
  }
  const webSearches = new Map();
  async function resolveWeb(id, episodeSort) {
    const key = JSON.stringify([id, episodeSort]);
    const pending = webSearches.get(key);
    if (pending) return pending;
    if (webSearches.size >= 4) throw new Error('网页源搜索繁忙');
    const task = (async () => {
      const [show, adapters] = await Promise.all([subject(id), sources('web-selector')]);
      const names = [...new Set([show.name, show.originalName].filter(Boolean))];
      const streams = [];
      const errors = [];
      for (let offset = 0; offset < adapters.length; offset += 5) {
        const batch = adapters.slice(offset, offset + 5);
        const results = await Promise.allSettled(batch.map(adapter => resolveWebSource(adapter, names, episodeSort, { matchName })));
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') streams.push(...result.value);
          else errors.push(batch[index].arguments.name);
        });
      }
      const unique = new Map();
      for (const stream of streams) {
        const key = JSON.stringify([stream.provider, stream.name, stream.url]);
        if (!unique.has(key)) unique.set(key, stream);
      }
      return { streams: [...unique.values()].sort((a, b) => a.tier - b.tier), errors };
    })();
    webSearches.set(key, task);
    try { return await task; } finally { webSearches.delete(key); }
  }
  return { home, subject, details, calendar, rankings, search, episodes, resolve, resolveWeb };
}
module.exports = { createAnimeService, normalizeSubject, select, template, matchName };
