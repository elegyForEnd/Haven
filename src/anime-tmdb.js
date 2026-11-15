'use strict';

const { matchName } = require('./anime-service');

const API = 'https://api.themoviedb.org/3';
const CDN = 'https://image.tmdb.org/t/p/original';
const CACHE_LIMIT = 500;
const DAY = 86400000;
const SEASON_SUFFIX = /(?:\s*第\s*([1-9]\d*|[一二三四五六七八九十])\s*[季期]|\s+[Ss]eason\s+([1-9]\d*)|(?<=[^A-Za-z])\s*\(?([IVX]{1,5})\)?)$/u;
const SEASON_NUMBER = { 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10, I:1, II:2, III:3, IV:4, V:5, VI:6, VII:7, VIII:8, IX:9, X:10 };

function seriesTitle(name) {
  const title = name.normalize('NFKC').trim();
  const suffix = title.match(SEASON_SUFFIX);
  if (!suffix) return null;
  const season = SEASON_NUMBER[(suffix[1] || suffix[2] || suffix[3]).toUpperCase()] || Number(suffix[1] || suffix[2]);
  const query = title.slice(0, suffix.index).trim();
  return query && season > 0 ? { query, season } : null;
}

function createTmdbArtwork({
  token = process.env.ANIME_TMDB_READ_TOKEN,
  mappings = JSON.parse(process.env.ANIME_TMDB_MAPPINGS || '{}'),
  fetchImpl = fetch,
} = {}) {
  const enabled = Boolean(token?.trim());
  const cache = new Map();
  async function request(path, query) {
    const url = new URL(API + path);
    url.search = new URLSearchParams(query);
    const result = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!result.ok) throw Object.assign(new Error(`TMDB image lookup failed (${result.status})`), { status: result.status });
    return result.json();
  }
  async function identify(show) {
    const mapping = mappings[show.id];
    if (mapping) {
      if (!Number.isSafeInteger(mapping.id) || mapping.id <= 0) throw new Error('Invalid TMDB title mapping');
      if (mapping.type === 'movie') return { id: mapping.id, type: 'movie' };
      if (mapping.type === 'tv' && Number.isSafeInteger(mapping.season) && mapping.season >= 0) return mapping;
      throw new Error('Invalid TMDB season mapping');
    }
    const names = [...new Map([show.originalName, show.name].filter(Boolean)
      .map(name => [matchName(name), name]).filter(([key]) => key)).values()];
    const titles = new Set(names.map(matchName));
    const types = /剧场版|电影|movie/i.test(show.platform) ? ['movie', 'tv'] : ['tv', 'movie'];
    for (const type of types) {
      for (const query of names) {
        const { results = [] } = await request(`/search/${type}`, { query, language: query === show.originalName ? 'ja-JP' : 'zh-CN' });
        const match = results.find(item => Number.isSafeInteger(item.id) && item.id > 0 &&
          [item.original_name, item.original_title, item.name, item.title].some(name => name && titles.has(matchName(name))));
        if (match) return { id: match.id, type };
      }
    }
    if (types[0] === 'tv') {
      for (const name of names) {
        const series = seriesTitle(name);
        if (!series) continue;
        const { results = [] } = await request('/search/tv', { query: series.query, language: name === show.originalName ? 'ja-JP' : 'zh-CN' });
        const title = matchName(series.query);
        const match = results.find(item => Number.isSafeInteger(item.id) && item.id > 0 &&
          [item.original_name, item.name].some(value => value && matchName(value) === title));
        if (match) return { id: match.id, type: 'tv', season: series.season, seriesFallback: true };
      }
      for (const name of names) {
        const words = name.trim().split(/\s+/u);
        const language = name === show.originalName ? 'ja-JP' : 'zh-CN';
        for (let end = words.length - 1; end >= Math.max(1, words.length - 3); end--) {
          const query = words.slice(0, end).join(' ');
          const { results = [] } = await request('/search/tv', { query, language });
          const series = results.find(item => Number.isSafeInteger(item.id) && item.id > 0 &&
            [item.original_name, item.name].some(value => value && matchName(value) === matchName(query)));
          if (!series) continue;
          const { seasons = [] } = await request(`/tv/${series.id}`, { language });
          const season = seasons.find(item => item.season_number > 0 && item.name && titles.has(matchName(item.name)));
          if (season) return { id: series.id, type: 'tv', season: season.season_number, seriesFallback: true };
        }
      }
    }
    return null;
  }
  const urls = (images, limit) => [...new Set((images || [])
    .map(image => image.file_path).filter(file => /^\/[a-z\d_-]+\.(?:jpg|jpeg|png|webp)$/i.test(file))
    .map(file => CDN + file))].slice(0, limit);
  async function lookup(show) {
    const match = await identify(show);
    if (!match) return { source: 'tmdb', posters: [], backdrops: [] };
    const path = `/${match.type}/${match.id}`;
    const images = await request(match.type === 'tv' && match.season !== undefined ? `${path}/season/${match.season}/images` : `${path}/images`)
      .catch(error => { if (match.seriesFallback && error.status === 404) return {}; throw error; });
    // A manually mapped season keeps its season-specific posters.
    let backdrops = images.backdrops;
    let posters = urls(images.posters, 12);
    if (match.seriesFallback) {
      const series = await request(`${path}/images`).catch(() => ({}));
      backdrops = series.backdrops;
      if (!posters.length) posters = urls(series.posters, 12);
    }
    if (!match.seriesFallback && match.type === 'tv' && match.season === 1) {
      const seasonCount = match.seasonCount ?? (await request(path).catch(() => null))?.number_of_seasons;
      if (seasonCount === 1) backdrops = (await request(`${path}/images`).catch(() => ({}))).backdrops;
    }
    return {
      source: 'tmdb', url: `https://www.themoviedb.org${path}`,
      posters, backdrops: urls(backdrops, 6),
    };
  }
  async function artwork(show) {
    if (!enabled) return { source: null, posters: [], backdrops: [] };
    const entry = cache.get(show.id);
    if (entry?.expires > Date.now()) return entry.task;
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    const current = { expires: Date.now() + DAY };
    current.task = lookup(show).catch(error => {
      if (cache.get(show.id) === current) cache.delete(show.id);
      throw error;
    });
    cache.set(show.id, current);
    return current.task;
  }
  return { enabled, artwork };
}

module.exports = { createTmdbArtwork };
