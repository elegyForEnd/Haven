'use strict';

const { load } = require('cheerio');
const { openPublic } = require('./anime-media');
const { captureMedia } = require('./anime-browser-source');

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function readPage(url, headers, signal) {
  const page = await openPublic(url, headers, { allowHttp: true, signal });
  const { response } = page;
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error('网页源不可用');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) {
      response.destroy();
      throw new Error('网页源响应过大');
    }
    chunks.push(chunk);
  }
  return { url: page.url, body: Buffer.concat(chunks).toString('utf8') };
}

function selectJson(data, path) {
  const segments = path.slice(1).match(/\.[\w-]+|\[\*\]|\['[\w-]+'(?:\s*,\s*'[\w-]+')*\]/g) || [];
  if (path !== '$' + segments.join('')) throw new Error('不支持的网页源字段路径');
  return segments.reduce((rows, segment) => rows.flatMap(row => {
    if (segment === '[*]') return Array.isArray(row) ? row : [];
    const keys = segment.startsWith('.') ? [segment.slice(1)] : segment.match(/[\w-]+/g);
    return keys.filter(key => row && Object.hasOwn(row, key)).map(key => row[key]);
  }), [data]);
}

function subjectLinks(page, config) {
  if (config.subjectFormatId === 'json-path-indexed') {
    const format = config.selectorSubjectFormatJsonPathIndexed;
    const data = JSON.parse(page.body);
    const links = selectJson(data, format.selectLinks);
    const names = selectJson(data, format.selectNames);
    return names.map((name, index) => {
      const link = links[index];
      return { name, link: link != null && format.linkTemplate
        ? format.linkTemplate.replace('{value}', encodeURIComponent(link)) : link };
    });
  }
  const $ = load(page.body);
  if (config.subjectFormatId === 'indexed') {
    const format = config.selectorSubjectFormatIndexed;
    const links = $(format.selectLinks).toArray();
    return $(format.selectNames).toArray().map((node, index) => ({
      name: $(node).text().trim(), link: $(links[index]).attr('href')
    }));
  }
  return $(config.selectorSubjectFormatA.selectLists).toArray().map(node => ({
    name: $(node).attr('title') || $(node).text().trim(), link: $(node).attr('href')
  }));
}

function episodeLinks(page, config, sort) {
  const $ = load(page.body);
  const grouped = config.channelFormatId === 'index-grouped';
  const format = grouped ? config.selectorChannelFormatFlattened : config.selectorChannelFormatNoChannel;
  const episodePattern = new RegExp(format.matchEpisodeSortFromName);
  const groups = grouped ? $(format.selectEpisodeLists).toArray() : [null];
  const names = grouped ? $(format.selectChannelNames).toArray() : [];
  return groups.flatMap((group, index) => {
    const rows = group ? $(group).find(format.selectEpisodesFromList) : $(format.selectEpisodes);
    const selector = grouped ? format.selectEpisodeLinksFromList : format.selectEpisodeLinks;
    const channel = $(names[index]).text().trim();
    const matchedChannel = format.matchChannelName && channel.match(new RegExp(format.matchChannelName));
    return rows.toArray().flatMap(node => {
      const label = $(node).text().trim().normalize('NFKC');
      const matched = label.match(episodePattern);
      const episode = matched?.groups?.ep || label.match(/^(?:第\s*)?(\d+(?:\.\d+)?)(?:\s*[话話集])?$/)?.[1];
      if (Number(episode) !== sort) return [];
      const link = selector ? $(node).closest(selector).attr('href') || $(node).find(selector).attr('href')
        : $(node).attr('href') || $(node).closest('a').attr('href');
      return link ? [{ link, name: matchedChannel?.groups?.ch || channel }] : [];
    });
  });
}

function videoMatcher(raw) {
  const pattern = new RegExp(raw.replace(/^\(\?i\)/, ''), raw.startsWith('(?i)') ? 'i' : '');
  return url => {
    const match = url.length <= 4096 && url.match(pattern);
    const video = match?.groups?.v || (match && url);
    return video && /^https:\/\/[^"'<>\\\s]+$/i.test(video) && !/\.(?:mpd|ts|m4s)(?:[?#]|$)/i.test(video) ? video : null;
  };
}

function mediaLinks(page, config, matchVideo) {
  const rule = config.matchVideo;
  const $ = load(page.body);
  const candidates = new Set();
  const add = value => {
    try {
      const url = new URL(value, page.url);
      if (/^https?:$/.test(url.protocol)) candidates.add(url.href);
    } catch { /* Ignore non-URL player attributes. */ }
  };
  $('video[src], source[src], iframe[src]').each((_, node) => add($(node).attr('src')));
  const decoded = page.body.replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/').replace(/&amp;/g, '&');
  for (const match of decoded.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) add(match[0]);
  const videos = new Set();
  const embeds = [];
  for (const url of candidates) {
    const video = matchVideo(url);
    if (video) videos.add(video);
    if (rule.enableNestedUrl && rule.matchNestedUrl && new RegExp(rule.matchNestedUrl).test(url.slice(0, 4096))) embeds.push(url);
    if (rule.enableNestedUrl) {
      for (const value of new URL(url).searchParams.values()) {
        const nested = matchVideo(value);
        if (nested) videos.add(nested);
      }
    }
  }
  $('iframe[src]').each((_, node) => {
    try {
      const frame = new URL($(node).attr('src'), page.url);
      if (/^https?:$/.test(frame.protocol)) embeds.push(frame.href);
    } catch { /* Ignore malformed embeds. */ }
  });
  return { videos, embeds: [...new Set(embeds)].slice(0, 2) };
}

async function resolveWebSource(adapter, names, sort, { matchName, read = readPage, capture = captureMedia } = {}) {
  const config = adapter.arguments.searchConfig;
  const signal = AbortSignal.timeout(16000);
  const headers = { 'User-Agent': config.userAgent || USER_AGENT };
  const showNames = new Set(names.map(matchName));
  const terms = new Set(names.slice(0, config.searchUseSubjectNamesCount || names.length).map(name => {
    const term = config.searchRemoveSpecial ? name.replace(/[\p{P}\p{S}]/gu, ' ') : name;
    return config.searchUseOnlyFirstWord ? term.trim().split(/\s+/)[0] : term.trim();
  }));
  let subject;
  for (const term of terms) {
    const url = config.searchUrl.replaceAll('{keyword}', encodeURIComponent(term));
    const page = await read(url, headers, signal);
    const match = subjectLinks(page, config).find(row => row.link && showNames.has(matchName(row.name)));
    if (match) {
      subject = new URL(match.link, config.rawBaseUrl || page.url).href;
      break;
    }
  }
  if (!subject) return [];
  const details = await read(subject, headers, signal);
  const links = episodeLinks(details, config, sort).slice(0, 4);
  const match = videoMatcher(config.matchVideo.matchVideoUrl);
  const results = await Promise.allSettled(links.map(async ({ link, name }) => {
    const playUrl = new URL(link, details.url);
    const page = await read(playUrl.href, { ...headers, Referer: details.url, ...(config.matchVideo.cookies && { Cookie: config.matchVideo.cookies }) }, signal);
    const { videos, embeds } = mediaLinks(page, config, match);
    if (!videos.size) {
      const nested = await Promise.allSettled(embeds.map(url => read(url, { ...headers, Referer: page.url }, signal)));
      for (const result of nested) {
        if (result.status === 'fulfilled') {
          for (const video of mediaLinks(result.value, config, match).videos) videos.add(video);
        }
      }
    }
    const candidates = videos.size ? [...videos].map(url => ({ url, referer: page.url })) :
      await capture(playUrl.href, {
        userAgent: headers['User-Agent'], referer: details.url, cookies: config.matchVideo.cookies, signal, match
      });
    return candidates.map(({ url, referer, type }) => ({
      url, name: name || adapter.arguments.name, provider: adapter.arguments.name,
      resolution: config.defaultResolution || '自动', subtitle: config.defaultSubtitleLanguage || '随片源',
      referer: config.matchVideo.addHeadersToVideo?.referer || referer,
      userAgent: config.matchVideo.addHeadersToVideo?.userAgent || headers['User-Agent'],
      tier: adapter.arguments.channelTiers?.[name] ?? adapter.arguments.tier ?? 2,
      type: type || (/\.m3u8(?:[?#]|$)/i.test(url) ? 'hls' : 'video')
    }));
  }));
  if (results.length && results.every(result => result.status === 'rejected')) throw results[0].reason;
  return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}

module.exports = { resolveWebSource, readPage };
