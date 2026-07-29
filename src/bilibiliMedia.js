'use strict';

const { resolveBilibiliPlaybackInfo } = require('./bilibiliApiClient');
const { getBilibiliRequestCredential } = require('./bilibiliCredentialStore');

const CACHE_FALLBACK_MS = 20 * 60 * 1000;
const FRESHNESS_WINDOW_MS = 2 * 60 * 1000;
// Clients start refreshing 45 seconds early. Keep the current immutable
// generation usable during that refresh, but never beyond the signed URL.
const RESOURCE_EXPIRY_SAFETY_MS = 5 * 1000;
const DEFAULT_MAX_VIDEO_HEIGHT = 1080;
const DEFAULT_PREFERRED_VIDEO_HEIGHT = 360;
const MAX_CACHE_ENTRIES = 50;

const cache = new Map();
const inFlight = new Map();
// A stream URL must remain immutable for its full lifetime. Keeping generations
// separately prevents an old browser Range request from reading a refreshed file.
const streamsByTrackId = new Map();
let streamVersionCounter = 0;

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isCanonicalBilibiliVideoUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:'
      && (host === 'bilibili.com' || host.endsWith('.bilibili.com'))
      && /^\/video\/BV[0-9A-Za-z]{10}\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function numeric(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizePreferredVideoHeight(value) {
  const maxVideoHeight = getMaxVideoHeight();
  const requestedHeight = Number(value);
  if (!Number.isInteger(requestedHeight)) return Math.min(DEFAULT_PREFERRED_VIDEO_HEIGHT, maxVideoHeight);
  return Math.max(144, Math.min(requestedHeight, maxVideoHeight));
}

function createResolutionCacheKey(url, preferredVideoHeight, credentialVersion = 'anonymous') {
  return `${url}|height=${normalizePreferredVideoHeight(preferredVideoHeight)}|codecs=h264-aac-v1|credential=${credentialVersion}`;
}

function sanitizeUpstreamRequestHeaders(headers, sourcePageUrl) {
  const allowedHeaderNames = new Map([
    ['accept', 'Accept'],
    ['cookie', 'Cookie'],
    ['origin', 'Origin'],
    ['referer', 'Referer'],
    ['user-agent', 'User-Agent']
  ]);
  const sanitizedHeaders = {};
  if (headers && typeof headers === 'object') {
    for (const [rawName, rawValue] of Object.entries(headers)) {
      const headerName = allowedHeaderNames.get(String(rawName).toLowerCase());
      if (!headerName || typeof rawValue !== 'string') continue;
      const headerValue = rawValue.trim();
      if (!headerValue || headerValue.length > 16384 || /[\r\n]/.test(headerValue)) continue;
      sanitizedHeaders[headerName] = headerValue;
    }
  }
  if (!sanitizedHeaders.Referer) sanitizedHeaders.Referer = sourcePageUrl;
  return sanitizedHeaders;
}

function getMaxVideoHeight() {
  const configuredHeight = Number.parseInt(process.env.BILIBILI_VIDEO_MAX_HEIGHT || '', 10);
  if (!Number.isInteger(configuredHeight)) return DEFAULT_MAX_VIDEO_HEIGHT;
  return Math.max(144, Math.min(configuredHeight, 1080));
}

function formatScore(format, kind) {
  if (kind === 'video') {
    const height = Math.min(numeric(format.height), 1080);
    const fps = Math.min(numeric(format.fps), 60);
    return height * 1000000 + fps * 10000 + numeric(format.tbr);
  }
  return numeric(format.abr) * 10000 + numeric(format.tbr);
}

function compareVideoFormatsForWeakNetworks(leftFormat, rightFormat) {
  const heightDifference = numeric(rightFormat.height) - numeric(leftFormat.height);
  if (heightDifference !== 0) return heightDifference;

  // Prefer 30 FPS when the same resolution also has a heavier high-FPS track.
  const leftFpsPenalty = numeric(leftFormat.fps) > 30 ? 1 : 0;
  const rightFpsPenalty = numeric(rightFormat.fps) > 30 ? 1 : 0;
  if (leftFpsPenalty !== rightFpsPenalty) return leftFpsPenalty - rightFpsPenalty;

  const bitrateDifference = numeric(leftFormat.tbr, Infinity) - numeric(rightFormat.tbr, Infinity);
  if (Number.isFinite(bitrateDifference) && bitrateDifference !== 0) return bitrateDifference;
  return numeric(leftFormat.fps) - numeric(rightFormat.fps);
}

function selectBrowserFormats(info, preferredVideoHeight = DEFAULT_PREFERRED_VIDEO_HEIGHT) {
  const formats = Array.isArray(info?.formats) ? info.formats.filter(format => isHttpsUrl(format?.url)) : [];
  const maxVideoHeight = getMaxVideoHeight();
  const videoFormats = formats.filter(format => {
    const codec = String(format.vcodec || '').toLowerCase();
    const audioCodec = String(format.acodec || '').toLowerCase();
    const ext = String(format.ext || '').toLowerCase();
    const height = numeric(format.height);
    return audioCodec === 'none' && (!height || height <= maxVideoHeight) && (ext === 'mp4' || ext === 'm4v') && /^(avc1|h264)/.test(codec);
  });
  const audioFormats = formats.filter(format => {
    const codec = String(format.acodec || '').toLowerCase();
    const videoCodec = String(format.vcodec || '').toLowerCase();
    const ext = String(format.ext || '').toLowerCase();
    return videoCodec === 'none' && (ext === 'm4a' || ext === 'mp4') && /(mp4a|aac)/.test(codec);
  });

  videoFormats.sort(compareVideoFormatsForWeakNetworks);
  audioFormats.sort((left, right) => formatScore(right, 'audio') - formatScore(left, 'audio'));

  const requestedVideoHeight = normalizePreferredVideoHeight(preferredVideoHeight);
  const videosWithinRequestedHeight = videoFormats.filter(format => {
    const height = numeric(format.height);
    return !height || height <= requestedVideoHeight;
  });
  const video = videosWithinRequestedHeight[0] || videoFormats[videoFormats.length - 1];
  const audio = audioFormats[0];
  if (!video || !audio) return null;

  const availableVideoHeights = [...new Set(videoFormats
    .map(format => numeric(format.height))
    .filter(height => height > 0))]
    .sort((left, right) => left - right);

  return {
    videoUrl: video.url,
    audioUrl: audio.url,
    videoMime: 'video/mp4',
    audioMime: 'audio/mp4',
    width: numeric(video.width) || null,
    height: numeric(video.height) || null,
    duration: numeric(info.duration) || null,
    requestedVideoHeight,
    selectedVideoHeight: numeric(video.height) || null,
    availableVideoHeights,
    videoRequestHeaders: { ...(info?.http_headers || {}), ...(video.http_headers || {}) },
    audioRequestHeaders: { ...(info?.http_headers || {}), ...(audio.http_headers || {}) }
  };
}

function isValidTrackId(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
}

function isValidStreamVersion(value) {
  return typeof value === 'string' && /^\d{13}-\d+$/.test(value);
}

function isBilibiliStreamProxyPath(value, expectedKind) {
  if (typeof value !== 'string') return false;
  const pathMatch = value.match(/^\/api\/bilibili-stream\/([a-f0-9]{24})\/(video|audio)\?v=(\d{13}-\d+)$/i);
  return !!pathMatch && (!expectedKind || pathMatch[2] === expectedKind);
}

function isBilibiliHlsPath(value) {
  return typeof value === 'string'
    && /^\/api\/bilibili-hls\/[a-f0-9]{24}\/\d{13}-[a-f0-9]{16}\/index\.m3u8$/i.test(value);
}

function getBilibiliStreamExpiry(streamRegistration) {
  const naturalExpiry = Number(streamRegistration?.expiresAt);
  if (!Number.isFinite(naturalExpiry)) return Infinity;
  const createdAt = Number(streamRegistration?.createdAt) || 0;
  return Math.max(createdAt, naturalExpiry - RESOURCE_EXPIRY_SAFETY_MS);
}

function pruneBilibiliStreams(now = Date.now()) {
  for (const [trackId, streamRegistrations] of streamsByTrackId) {
    for (const [streamVersion, streamRegistration] of streamRegistrations) {
      if (getBilibiliStreamExpiry(streamRegistration) <= now) streamRegistrations.delete(streamVersion);
    }
    if (streamRegistrations.size === 0) streamsByTrackId.delete(trackId);
  }
}

function registerBilibiliStream(trackId, sourcePageUrl, selected, expiresAt) {
  if (!isValidTrackId(trackId)) throw new Error('A valid track ID is required for Bilibili media proxying');
  if (!isCanonicalBilibiliVideoUrl(sourcePageUrl)) throw new Error('A canonical Bilibili source URL is required');
  if (!isHttpsUrl(selected.videoUrl) || !isHttpsUrl(selected.audioUrl)) {
    throw new Error('Bilibili returned an unsafe media URL');
  }

  pruneBilibiliStreams();
  streamVersionCounter = (streamVersionCounter + 1) % Number.MAX_SAFE_INTEGER;
  const streamVersion = `${Date.now()}-${streamVersionCounter}`;
  const streamRegistration = {
    trackId,
    streamVersion,
    sourcePageUrl,
    expiresAt,
    createdAt: Date.now(),
    video: {
      upstreamUrl: selected.videoUrl,
      upstreamHostname: new URL(selected.videoUrl).hostname.toLowerCase(),
      mediaKind: 'video',
      contentType: selected.videoMime,
      requestHeaders: sanitizeUpstreamRequestHeaders(selected.videoRequestHeaders, sourcePageUrl)
    },
    audio: {
      upstreamUrl: selected.audioUrl,
      upstreamHostname: new URL(selected.audioUrl).hostname.toLowerCase(),
      mediaKind: 'audio',
      contentType: selected.audioMime,
      requestHeaders: sanitizeUpstreamRequestHeaders(selected.audioRequestHeaders, sourcePageUrl)
    }
  };
  const streamRegistrations = streamsByTrackId.get(trackId) || new Map();
  streamRegistrations.set(streamVersion, streamRegistration);
  streamsByTrackId.set(trackId, streamRegistrations);

  return {
    videoUrl: `/api/bilibili-stream/${trackId}/video?v=${streamVersion}`,
    audioUrl: `/api/bilibili-stream/${trackId}/audio?v=${streamVersion}`,
    videoMime: selected.videoMime,
    audioMime: selected.audioMime,
    width: selected.width,
    height: selected.height,
    duration: selected.duration,
    requestedVideoHeight: selected.requestedVideoHeight,
    selectedVideoHeight: selected.selectedVideoHeight,
    availableVideoHeights: selected.availableVideoHeights,
    expiresAt
  };
}

function lookupBilibiliStream(trackId, mediaKind, streamVersion, now = Date.now()) {
  if (!isValidTrackId(trackId) || !['video', 'audio'].includes(mediaKind) || !isValidStreamVersion(streamVersion)) {
    return { status: 'missing', resource: null };
  }
  const streamRegistrations = streamsByTrackId.get(trackId);
  const streamRegistration = streamRegistrations?.get(streamVersion);
  if (!streamRegistration) return { status: 'missing', resource: null };
  if (getBilibiliStreamExpiry(streamRegistration) <= now) {
    streamRegistrations.delete(streamVersion);
    if (streamRegistrations.size === 0) streamsByTrackId.delete(trackId);
    return { status: 'expired', resource: null };
  }
  const selectedStream = streamRegistration[mediaKind];
  return {
    status: 'active',
    resource: {
      ...selectedStream,
      trackId,
      streamVersion,
      sourcePageUrl: streamRegistration.sourcePageUrl,
      expiresAt: streamRegistration.expiresAt,
      createdAt: streamRegistration.createdAt
    }
  };
}

function createBilibiliMediaPayload(media) {
  if (!media
    || !isBilibiliStreamProxyPath(media.videoUrl, 'video')
    || !isBilibiliStreamProxyPath(media.audioUrl, 'audio')) {
    return null;
  }
  const payload = {
    videoUrl: media.videoUrl,
    audioUrl: media.audioUrl,
    videoMime: media.videoMime,
    audioMime: media.audioMime,
    width: media.width,
    height: media.height,
    duration: media.duration,
    requestedVideoHeight: media.requestedVideoHeight,
    selectedVideoHeight: media.selectedVideoHeight,
    availableVideoHeights: media.availableVideoHeights,
    expiresAt: media.expiresAt
  };
  if (isBilibiliHlsPath(media.hlsUrl)) {
    payload.transport = 'hls-fmp4';
    payload.hlsUrl = media.hlsUrl;
    payload.hlsMime = 'application/vnd.apple.mpegurl';
  }
  return payload;
}

function getUrlExpiry(url) {
  try {
    const parsed = new URL(url);
    for (const key of ['deadline', 'expires', 'expire', 'expiration']) {
      const raw = parsed.searchParams.get(key);
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      const milliseconds = value > 100000000000 ? value : value * 1000;
      if (milliseconds > 0) return milliseconds;
    }
  } catch {}
  return null;
}

function inferExpiresAt(media) {
  const expiries = [getUrlExpiry(media?.videoUrl), getUrlExpiry(media?.audioUrl)].filter(Number.isFinite);
  return expiries.length ? Math.min(...expiries) : Date.now() + CACHE_FALLBACK_MS;
}

function isFresh(media) {
  return !!media && Number(media.expiresAt) - Date.now() > FRESHNESS_WINDOW_MS;
}

function pruneCache() {
  for (const [key, value] of cache) {
    if (!isFresh(value)) cache.delete(key);
  }
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  pruneBilibiliStreams();
}

async function resolveBilibiliSourceMedia(url, options = {}) {
  if (!isCanonicalBilibiliVideoUrl(url)) throw new Error('Only canonical Bilibili video URLs can be resolved');
  const force = options.force === true;
  const preferredVideoHeight = normalizePreferredVideoHeight(options.preferredVideoHeight);
  const requestCredential = options.requestCredential || getBilibiliRequestCredential();
  const cacheKey = createResolutionCacheKey(url, preferredVideoHeight, requestCredential.credentialVersion);
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }
  if (!force) {
    const cached = cache.get(cacheKey);
    if (isFresh(cached)) return cached;
  }

  const task = (async () => {
    const resolvePlaybackInfo = options.resolvePlaybackInfo || resolveBilibiliPlaybackInfo;
    const info = await resolvePlaybackInfo(url, {
      requestCredential,
      fetchImpl: options.fetchImpl
    });
    const selected = selectBrowserFormats(info, preferredVideoHeight);
    if (!selected) throw new Error('No browser-compatible H.264/AAC streams were found');
    const expiresAt = inferExpiresAt(selected);
    if (expiresAt - Date.now() < 30000) {
      throw new Error('Bilibili returned media addresses that expire too soon');
    }
    const cachedSelection = {
      ...selected,
      credentialVersion: requestCredential.credentialVersion,
      expiresAt
    };
    pruneCache();
    cache.set(cacheKey, cachedSelection);
    return cachedSelection;
  })();

  inFlight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    if (inFlight.get(cacheKey) === task) inFlight.delete(cacheKey);
  }
}

async function resolveBilibiliMedia(url, options = {}) {
  const trackId = String(options.trackId || '');
  if (!isValidTrackId(trackId)) throw new Error('A valid track ID is required for Bilibili media proxying');
  const selected = await resolveBilibiliSourceMedia(url, options);
  return registerBilibiliStream(trackId, url, selected, selected.expiresAt);
}

function clearBilibiliStreamRegistrations(trackId) {
  if (isValidTrackId(trackId)) streamsByTrackId.delete(trackId);
  pruneBilibiliStreams();
}

function clearBilibiliMedia(url, trackId) {
  if (url) {
    const cacheKeyPrefix = `${url}|`;
    for (const cacheKey of cache.keys()) {
      if (cacheKey.startsWith(cacheKeyPrefix)) cache.delete(cacheKey);
    }
  } else {
    cache.clear();
  }
  clearBilibiliStreamRegistrations(trackId);
}

module.exports = {
  resolveBilibiliMedia,
  resolveBilibiliSourceMedia,
  clearBilibiliMedia,
  clearBilibiliStreamRegistrations,
  selectBrowserFormats,
  inferExpiresAt,
  normalizePreferredVideoHeight,
  isCanonicalBilibiliVideoUrl,
  registerBilibiliStream,
  lookupBilibiliStream,
  createBilibiliMediaPayload,
  getBilibiliStreamExpiry,
  isBilibiliStreamProxyPath,
  isBilibiliHlsPath
};
