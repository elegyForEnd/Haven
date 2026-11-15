'use strict';

const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { load } = require('cheerio');
const { readPage } = require('./anime-web-source');
const { isPublicAddress, openPublic } = require('./anime-media');

const FEED = 'https://sub.creamycake.org/v1/bt1.json';
const BUILTIN = [
  { name: '动漫花园', searchUrl: 'https://share.dmhy.org/topics/rss/rss.xml?keyword={keyword}' },
  { name: 'Mikan', category: 'mikan', searchUrl: 'https://mikanani.me/RSS/Search?searchstr={keyword}' }
];
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };

function episodeMatches(title, episode) {
  const label = title.normalize('NFKC');
  return [...label.matchAll(/(?:第\s*(\d+(?:\.\d+)?)\s*[话話集]|(?:^|[\s\[_-])(?:EP?\.?\s*)?(\d{1,3}(?:\.\d+)?)(?=[\s\]_.]|$))/gi)]
    .some(match => Number(match[1] || match[2]) === episode);
}

function magnetHash(value) {
  const match = String(value).match(/^magnet:\?(?:[^&]*&)*?xt=urn:btih:([a-f0-9]{40}|[a-z2-7]{32})(?:&|$)/i);
  return match?.[1].toLowerCase();
}

function enclosureHash(value) {
  try {
    const url = new URL(value);
    if (!['mikanani.me', 'mikanime.tv', 'mikanani.org'].includes(url.hostname)) return null;
    return url.pathname.match(/\/([a-f0-9]{40})\.torrent$/i)?.[1].toLowerCase();
  } catch { return null; }
}

function mikanReleases(items) {
  const groups = new Map();
  for (const item of items) {
    const title = item.title.normalize('NFKC').trimStart();
    const subgroup = title.match(/^(?:\[([^\]]+)\]|【([^】]+)】|〖([^〗]+)〗|「([^」]+)」|〔([^〕]+)〕)/u)
      ?.slice(1).find(Boolean)?.trim() || '';
    if (!groups.has(subgroup)) groups.set(subgroup, []);
    groups.get(subgroup).push({ ...item, subgroup });
  }
  const releases = [];
  const variants = [...groups.values()];
  for (let index = 0; releases.length < 24; index++) {
    const round = variants.map(group => group[index]).filter(Boolean);
    if (!round.length) break;
    releases.push(...round);
  }
  return releases.slice(0, 24);
}

function releaseMatches(title, names, episode, normalize) {
  if (!episodeMatches(title, episode)) return false;
  const seasonOf = value => {
    const marker = value.normalize('NFKC').match(/第\s*([二三四五六七八九十\d]+)\s*季|(?:\bseason\s*|\bs)(\d+)\b/i);
    return marker?.[1]?.replace(/[二三四五六七八九十]/g, c => String('一二三四五六七八九十'.indexOf(c) + 1)) || marker?.[2] || '';
  };
  const season = seasonOf(title);
  return names.some(name => {
    const expected = seasonOf(name);
    return (!season || season === expected || (!expected && season === '1')) &&
      normalize(title).includes(normalize(name));
  });
}

function selectVideo(files, episode) {
  const videos = files.filter(file => typeof file.name === 'string' && VIDEO_TYPES[path.extname(file.name).toLowerCase()]);
  const matches = videos.filter(file => episodeMatches(file.name, episode));
  return matches.length === 1 ? matches[0] : videos.length === 1 ? videos[0] : null;
}

function createTorrentSources({ dataDir, subject, normalize, read = readPage, createClient = createPublicClient, pikpak, openVideo = openPublic }) {
  const entries = new Map();
  const transfers = new Map();
  const searches = new Map();
  let subscription;
  let client;

  async function feeds() {
    if (subscription?.until > Date.now()) return subscription.list;
    try {
      const { body } = await read(FEED, {}, AbortSignal.timeout(8000));
      const custom = process.env.ANIME_CUSTOM_RSS_SOURCES ? JSON.parse(process.env.ANIME_CUSTOM_RSS_SOURCES) : [];
      const list = [...JSON.parse(body).mediaSources, ...custom].filter(source => source.factoryId === 'rss')
        .map(source => ({ name: source.arguments.name, searchUrl: source.arguments.searchConfig.searchUrl }));
      subscription = { list: [...list, ...BUILTIN], until: Date.now() + 3600000 };
    } catch { return subscription?.list || BUILTIN; }
    return subscription.list;
  }

  function issue(hash, episode, cloud) {
    if (entries.size >= 2048) entries.delete(entries.keys().next().value);
    const key = randomBytes(20).toString('hex');
    entries.set(key, { hash, episode, cloud, until: Date.now() + 7200000 });
    return '/api/anime/torrent/' + key;
  }

  async function resolve(id, episode, personal = [], cloud = false) {
    const key = JSON.stringify([id, episode, personal, cloud]);
    if (searches.has(key)) return searches.get(key);
    if (searches.size >= 4) throw new Error('BT 搜索繁忙');
    const task = (async () => {
      const [show, configured] = await Promise.all([subject(id), feeds()]);
      const list = [...configured, ...personal.map(source => ({
        name: source.arguments.name, searchUrl: source.arguments.searchConfig.searchUrl
      }))];
      const names = [...new Set([show.name, show.originalName].filter(Boolean))];
      const results = await Promise.allSettled(list.map(async source => {
        const items = new Map();
        const signal = AbortSignal.timeout(12000);
        const pages = await Promise.allSettled(names.map(name => {
          const url = source.searchUrl.replaceAll('{keyword}', encodeURIComponent(name));
          return read(url, {
            Accept: 'application/rss+xml, application/xml, text/xml',
            'User-Agent': 'Mozilla/5.0 Ciacord/1.0'
          }, signal);
        }));
        if (pages.every(page => page.status === 'rejected')) throw new Error('BT 订阅不可用');
        for (const result of pages) {
          if (result.status === 'rejected') continue;
          const page = result.value;
          const $ = load(page.body, { xml: true });
          $('item').each((_, node) => {
            const title = $(node).children('title').text();
            if (!releaseMatches(title, names, episode, normalize)) return;
            const links = [$(node).children('link').text(), $(node).children('enclosure').attr('url'), $(node).children('torrent\\:magnetURI').text()];
            const infoHash = $(node).children().filter((_, child) => /(?:^|:)infohash$/i.test(child.name)).text().trim();
            const hash = links.map(link => magnetHash(link) || enclosureHash(link)).find(Boolean) ||
              (/^[a-f0-9]{40}$/i.test(infoHash) ? infoHash.toLowerCase() : null);
            if (hash) items.set(hash, { hash, title });
          });
          if (source.category !== 'mikan' && items.size >= 6) break;
        }
        if (source.category === 'mikan') return mikanReleases(items.values());
        return [...items.values()].slice(0, 6);
      }));
      const seen = new Set();
      const streams = [];
      const errors = [];
      results.forEach((result, index) => {
        const { name: provider, category } = list[index];
        if (result.status === 'rejected') { errors.push(provider); return; }
        for (const item of result.value) {
          const key = category === 'mikan' ? `mikan:${item.hash}` : item.hash;
          if (seen.has(key)) continue;
          seen.add(key);
          const group = category === 'mikan' ? { category, subgroup: item.subgroup } : {};
          streams.push({ name: item.title, provider, ...group, type: 'torrent', resolution: 'BT', url: issue(item.hash, episode, cloud) });
        }
      });
      return { streams, errors, pikpakAvailable: Boolean(cloud) };
    })();
    searches.set(key, task);
    try { return await task; } finally { searches.delete(key); }
  }

  function stop(hash, transfer) {
    clearTimeout(transfer.timer);
    if (transfers.get(hash) === transfer) transfers.delete(hash);
    if (transfer.torrent && !transfer.torrent.destroyed) transfer.torrent.destroy();
  }

  function startTransfer(hash) {
    const existing = transfers.get(hash);
    if (existing) return existing;
    if (transfers.size >= 3) throw new Error('BT 播放繁忙');
    const transfer = { readers: 0 };
    transfers.set(hash, transfer);
    client ||= Promise.resolve().then(createClient).catch(error => { client = null; throw error; });
    transfer.ready = client.then(instance => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('等待 BT 做种节点超时')), 35000);
      const torrent = transfer.torrent = instance.add('magnet:?xt=urn:btih:' + hash, {
        path: path.join(dataDir, 'anime-torrents', randomBytes(16).toString('hex')),
        deselect: true, destroyStoreOnDestroy: true, strategy: 'sequential'
      });
      torrent.on('error', error => { clearTimeout(timeout); reject(error); stop(hash, transfer); });
      torrent.once('ready', () => {
        clearTimeout(timeout);
        if (torrent.length > 6 * 1024 ** 3) reject(new Error('BT 资源体积过大'));
        else resolve(torrent);
      });
    })).catch(error => { stop(hash, transfer); throw error; });
    return transfer;
  }

  async function streamCloud(entry, req, res) {
    const range = req.headers.range;
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return false;
    const target = await pikpak.video(entry, selectVideo);
    if (res.destroyed) return true;
    if (!target) return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let upstream;
    try {
      ({ response: upstream } = await openVideo(target.url, {
        Accept: 'application/octet-stream',
        ...(range || req.method === 'HEAD' ? { Range: range || 'bytes=0-0' } : {})
      }, { signal: controller.signal }));
    } finally { clearTimeout(timeout); }
    if (res.destroyed || (range && upstream.statusCode !== 206 && upstream.statusCode !== 416) ||
      ![200, 206, 416].includes(upstream.statusCode) ||
      (upstream.statusCode !== 200 && !upstream.headers['content-range'])) {
      upstream.destroy();
      return res.destroyed;
    }
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', VIDEO_TYPES[path.extname(target.name).toLowerCase()]);
    const head = req.method === 'HEAD';
    const total = head && !range && upstream.headers['content-range']?.match(/\/(\d+)$/)?.[1];
    res.status(total ? 200 : upstream.statusCode);
    for (const name of ['content-length', 'content-range', 'accept-ranges']) {
      if (upstream.headers[name] && !(total && name === 'content-range')) res.set(name, upstream.headers[name]);
    }
    if (total) res.set('Content-Length', total);
    if (head || upstream.statusCode === 416) {
      upstream.destroy();
      res.end();
    } else {
      await pipeline(upstream, res);
    }
    return true;
  }

  async function handle(req, res) {
    const entry = entries.get(req.params.key);
    if (!entry || entry.until < Date.now()) return res.sendStatus(410);
    const engine = req.query.engine;
    const cloudOnly = engine === 'pikpak';
    if (engine !== undefined && !cloudOnly && engine !== 'webtorrent') return res.sendStatus(400);
    if (cloudOnly && (!pikpak || !entry.cloud)) return res.sendStatus(403);
    let transfer;
    try {
      if (pikpak && entry.cloud && (cloudOnly || (!engine && !entry.cloudFallback))) {
        try {
          if (await streamCloud(entry, req, res)) return;
        } catch {
          if (res.headersSent || res.destroyed) {
            if (!cloudOnly) entry.cloudFallback = true;
            return res.destroy();
          }
        }
        if (cloudOnly) return res.sendStatus(502);
        entry.cloudFallback = true;
        if (res.destroyed) return;
      }
      transfer = startTransfer(entry.hash);
      clearTimeout(transfer.timer);
      transfer.readers++;
      const torrent = await transfer.ready;
      if (res.destroyed) return;
      const file = selectVideo(torrent.files, entry.episode);
      if (!file?.length) return res.sendStatus(422);
      const ranges = req.headers.range ? req.range(file.length) : null;
      if (req.headers.range && (!Array.isArray(ranges) || ranges.type !== 'bytes' || ranges.length !== 1)) {
        return res.set('Content-Range', 'bytes */' + file.length).sendStatus(416);
      }
      const { start = 0, end = file.length - 1 } = ranges?.[0] || {};
      res.set({
        'Content-Type': VIDEO_TYPES[path.extname(file.name).toLowerCase()],
        'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'
      });
      if (ranges) res.status(206).set('Content-Range', 'bytes ' + start + '-' + end + '/' + file.length);
      if (req.method === 'HEAD') return res.end();
      const stream = file.createReadStream({ start, end });
      res.setTimeout(90000, () => res.destroy());
      await pipeline(stream, res);
    } catch (error) {
      console.warn('[anime torrent]', error.message);
      if (!res.headersSent && !res.destroyed) res.sendStatus(502);
    } finally {
      if (transfer && --transfer.readers === 0 && transfers.get(entry.hash) === transfer) {
        transfer.timer = setTimeout(() => stop(entry.hash, transfer), 120000);
        transfer.timer.unref();
      }
    }
  }

  return { resolve, handle };
}

async function createPublicClient() {
  const { default: WebTorrent } = await import('webtorrent');
  const client = new WebTorrent({
    lsd: false, tracker: false, webSeeds: false, natUpnp: false, natPmp: false, maxConns: 24,
    downloadLimit: 8 * 1024 * 1024, uploadLimit: 128 * 1024
  });
  client.blocked = { contains: host => !isPublicAddress(host) };
  client.on('error', error => console.warn('[anime torrent]', error.message));
  return client;
}

module.exports = { createTorrentSources, releaseMatches, magnetHash };
