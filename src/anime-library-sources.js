'use strict';

const { readPage } = require('./anime-web-source');
const { matchName } = require('./anime-service');

function createLibrarySources(config = process.env.ANIME_LIBRARY_SOURCES, read = readPage) {
  const sources = config ? JSON.parse(config) : [];
  if (!Array.isArray(sources)) throw new Error('ANIME_LIBRARY_SOURCES must be an array');

  async function resolve(show, episode) {
    const names = [show.name, show.originalName].filter(Boolean).map(matchName);
    const results = await Promise.allSettled(sources.map(async source => {
      if (!['jellyfin', 'emby', 'ikaros', 'direct'].includes(source.type)) throw new Error('Unsupported library type');
      if (source.type === 'direct') {
        const url = new URL(source.url.replaceAll('{subject}', String(show.id)).replaceAll('{episode}', String(episode)));
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid direct source URL');
        return [{ url: url.href, name: source.name, provider: source.name, resolution: '原画', type: /\.m3u8$/i.test(url.pathname) ? 'hls' : 'video' }];
      }
      const base = new URL(source.url.replace(/\/+$/, '') + '/');
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Invalid library URL');
      const signal = AbortSignal.timeout(10000);
      if (source.type === 'ikaros') {
        const authorization = 'Basic ' + Buffer.from(source.username + ':' + source.password).toString('base64');
        const headers = { Authorization: authorization };
        const get = async route => (await read(new URL('api/v1alpha1/' + route, base).href, headers, signal)).body;
        const mappings = JSON.parse(await get('subject/syncs/platform?platform=BGM_TV&platformId=' + show.id));
        if (mappings.length !== 1 || !Number.isSafeInteger(mappings[0].subjectId)) return [];
        const records = JSON.parse(await get('episode/records/subjectId/' + mappings[0].subjectId));
        const resources = records.filter(row => row.episode.group === 'MAIN' && Number(row.episode.sequence) === episode)
          .flatMap(row => row.resources || []).filter(row => row.canRead !== false && Number.isSafeInteger(row.attachmentId));
        const settled = await Promise.allSettled(resources.slice(0, 8).map(async resource => {
          const address = (await get('attachment/url/read/id/' + resource.attachmentId)).trim();
          if (!address) throw new Error('Ikaros attachment has no playback URL');
          const url = new URL(address, base);
          if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid Ikaros playback URL');
          return {
            url: url.href, headers: url.origin === base.origin ? headers : {}, name: resource.name || source.name,
            provider: source.name, resolution: '原画', type: /\.m3u8$/i.test(url.pathname) ? 'hls' : 'video'
          };
        }));
        if (settled.length && settled.every(row => row.status === 'rejected')) throw settled[0].reason;
        return settled.flatMap(row => row.status === 'fulfilled' ? [row.value] : []);
      }
      if (typeof source.apiKey !== 'string' || !source.apiKey.trim()) throw new Error('Missing library API key');
      const headers = { 'X-Emby-Token': source.apiKey };
      const itemsPath = source.userId ? `Users/${encodeURIComponent(source.userId)}/Items` : 'Items';
      const items = async params => {
        const url = new URL(itemsPath, base);
        url.search = new URLSearchParams({ Recursive: 'true', ...params });
        return JSON.parse((await read(url.href, { ...headers, Accept: 'application/json' }, signal)).body).Items || [];
      };
      const mapping = source.subjects?.[show.id];
      const matches = mapping ? [{ Id: mapping.id, Type: mapping.movie ? 'Movie' : 'Series' }]
        : (await items({ SearchTerm: show.name, IncludeItemTypes: 'Series,Movie', Limit: '25' }))
          .filter(item => [item.Name, item.OriginalTitle].filter(Boolean).some(name => names.includes(matchName(name))));
      if (matches.length !== 1) return [];
      const item = matches[0];
      const episodes = item.Type === 'Movie' ? (episode === 1 ? [item] : [])
        : await items({ ParentId: item.Id, IncludeItemTypes: 'Episode' });
      return episodes.filter(row => item.Type === 'Movie' ||
        (Number(row.IndexNumber) === episode && Number(row.ParentIndexNumber) === (mapping?.season || 1)))
        .map(row => {
          const url = new URL(`Videos/${encodeURIComponent(row.Id)}/stream`, base);
          url.search = new URLSearchParams({ Static: 'true', MediaSourceId: row.Id });
          return { url: url.href, headers, name: row.Name || source.name, provider: source.name, resolution: '原画', type: 'video' };
        });
    }));
    return {
      streams: results.flatMap(result => result.status === 'fulfilled' ? result.value : []),
      errors: results.flatMap((result, index) => result.status === 'rejected' ? [sources[index].name] : [])
    };
  }

  return { resolve, enabled: sources.length > 0 };
}

module.exports = { createLibrarySources };
