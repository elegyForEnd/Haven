'use strict';

const crypto = require('crypto');
const { getBilibiliRequestCredential } = require('./bilibiliCredentialStore');

const BILIBILI_API_ORIGIN = 'https://api.bilibili.com';
const BILIBILI_WEB_ORIGIN = 'https://www.bilibili.com';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const WBI_KEY_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_USER_AGENT = process.env.BILIBILI_USER_AGENT
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const WBI_MIXIN_KEY_ORDER = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

let wbiKeyCache = null;

function createBilibiliApiError(message, code = null, statusCode = null) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function describeBilibiliApiError(code, fallbackMessage) {
  const knownMessages = new Map([
    [-101, 'Bilibili login is required or has expired. Ask an administrator to bind the account again.'],
    [-10403, 'The bound Bilibili account cannot access this video quality.'],
    [-352, 'Bilibili rejected the request because of risk control. Rebind the account or try another network.'],
    [-400, 'Bilibili rejected invalid playback parameters.'],
    [-404, 'The Bilibili video or page was not found.']
  ]);
  return knownMessages.get(Number(code))
    || String(fallbackMessage || `Bilibili API error ${code}`).slice(0, 300);
}

function createRequestHeaders(cookieHeader, referer = `${BILIBILI_WEB_ORIGIN}/`) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    Origin: BILIBILI_WEB_ORIGIN,
    Referer: referer,
    'User-Agent': DEFAULT_USER_AGENT
  };
  if (cookieHeader) headers.Cookie = cookieHeader;
  return headers;
}

async function readJsonResponse(response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw createBilibiliApiError('Bilibili returned an unexpectedly large response');
  }

  const responseChunks = [];
  let receivedBytes = 0;
  if (response.body?.getReader) {
    const responseReader = response.body.getReader();
    while (true) {
      const { done, value } = await responseReader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        await responseReader.cancel().catch(() => {});
        throw createBilibiliApiError('Bilibili returned an unexpectedly large response');
      }
      responseChunks.push(Buffer.from(value));
    }
  } else {
    const fallbackBuffer = Buffer.from(await response.arrayBuffer());
    if (fallbackBuffer.length > MAX_RESPONSE_BYTES) {
      throw createBilibiliApiError('Bilibili returned an unexpectedly large response');
    }
    responseChunks.push(fallbackBuffer);
  }
  const responseBuffer = Buffer.concat(responseChunks, receivedBytes || undefined);
  try {
    return JSON.parse(responseBuffer.toString('utf8'));
  } catch {
    throw createBilibiliApiError('Bilibili returned invalid JSON');
  }
}

function createMediaRequestHeaders(referer) {
  // CDN requests must not receive the account session. Browser Cookie domain
  // rules would not send .bilibili.com credentials to bilivideo.com either.
  return {
    Accept: '*/*',
    Origin: BILIBILI_WEB_ORIGIN,
    Referer: referer,
    'User-Agent': DEFAULT_USER_AGENT
  };
}

async function requestBilibiliJson(url, options = {}) {
  let response;
  try {
    response = await (options.fetchImpl || fetch)(url, {
      method: 'GET',
      headers: createRequestHeaders(options.cookieHeader, options.referer),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs || REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw createBilibiliApiError('Bilibili API request timed out');
    }
    throw createBilibiliApiError(`Could not connect to Bilibili API: ${String(error?.message || 'network error').slice(0, 200)}`);
  }

  if (!response.ok) {
    const message = response.status === 412
      ? 'Bilibili rejected the server request with HTTP 412 risk control. Bind an account and verify the server network.'
      : `Bilibili API returned HTTP ${response.status}`;
    throw createBilibiliApiError(message, null, response.status);
  }

  const responseBody = await readJsonResponse(response);
  if (!responseBody || typeof responseBody !== 'object') {
    throw createBilibiliApiError('Bilibili returned an empty API response');
  }
  if (Number(responseBody.code) !== 0) {
    throw createBilibiliApiError(
      describeBilibiliApiError(responseBody.code, responseBody.message),
      Number(responseBody.code)
    );
  }
  return responseBody.data;
}

function extractWbiKey(urlValue) {
  try {
    const pathname = new URL(urlValue).pathname;
    return pathname.split('/').pop().split('.')[0];
  } catch {
    return '';
  }
}

function createWbiMixinKey(imageKey, subKey) {
  const sourceKey = `${imageKey}${subKey}`;
  return WBI_MIXIN_KEY_ORDER
    .map(index => sourceKey[index] || '')
    .join('')
    .slice(0, 32);
}

function sanitizeWbiValue(value) {
  return String(value).replace(/[!'()*]/g, '');
}

function signWbiParameters(parameters, mixinKey, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const signedParameters = { ...parameters, wts: timestampSeconds };
  const queryString = Object.keys(signedParameters)
    .sort()
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(sanitizeWbiValue(signedParameters[key]))}`)
    .join('&');
  const signature = crypto
    .createHash('md5')
    .update(`${queryString}${mixinKey}`)
    .digest('hex');
  return `${queryString}&w_rid=${signature}`;
}

async function getWbiMixinKey(requestCredential, options = {}) {
  if (wbiKeyCache
    && wbiKeyCache.credentialVersion === requestCredential.credentialVersion
    && wbiKeyCache.expiresAt > Date.now()) {
    return wbiKeyCache.mixinKey;
  }

  const navigationData = await requestBilibiliJson(`${BILIBILI_API_ORIGIN}/x/web-interface/nav`, {
    cookieHeader: requestCredential.cookieHeader,
    fetchImpl: options.fetchImpl
  });
  const imageKey = extractWbiKey(navigationData?.wbi_img?.img_url);
  const subKey = extractWbiKey(navigationData?.wbi_img?.sub_url);
  if (!imageKey || !subKey) throw createBilibiliApiError('Bilibili did not return valid WBI signing keys');

  const mixinKey = createWbiMixinKey(imageKey, subKey);
  wbiKeyCache = {
    credentialVersion: requestCredential.credentialVersion,
    mixinKey,
    expiresAt: Date.now() + WBI_KEY_CACHE_MS
  };
  return mixinKey;
}

function parseCanonicalVideoUrl(sourcePageUrl) {
  const parsedUrl = new URL(sourcePageUrl);
  const hostname = parsedUrl.hostname.toLowerCase();
  const isBilibiliHostname = hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com');
  if (parsedUrl.protocol !== 'https:' || !isBilibiliHostname) {
    throw createBilibiliApiError('A canonical Bilibili video URL is required');
  }
  const bvidMatch = parsedUrl.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/i);
  if (!bvidMatch) throw createBilibiliApiError('A canonical Bilibili video URL is required');
  const rawPage = parsedUrl.searchParams.get('p');
  if (rawPage !== null && !/^[1-9]\d*$/.test(rawPage)) {
    throw createBilibiliApiError('The Bilibili video page parameter is invalid');
  }
  const requestedPage = Number(rawPage || 1);
  if (!Number.isSafeInteger(requestedPage) || requestedPage <= 0) {
    throw createBilibiliApiError('The Bilibili video page parameter is invalid');
  }
  return {
    bvid: bvidMatch[1],
    page: requestedPage
  };
}

function parseFrameRate(frameRate) {
  if (typeof frameRate === 'number') return frameRate;
  const frameRateParts = String(frameRate || '').split('/').map(Number);
  if (frameRateParts.length === 2 && frameRateParts.every(Number.isFinite) && frameRateParts[1] > 0) {
    return frameRateParts[0] / frameRateParts[1];
  }
  const numericFrameRate = Number(frameRate);
  return Number.isFinite(numericFrameRate) ? numericFrameRate : 0;
}

function normalizeDashFormats(playbackData, requestHeaders) {
  const videoFormats = Array.isArray(playbackData?.dash?.video) ? playbackData.dash.video : [];
  const audioFormats = Array.isArray(playbackData?.dash?.audio) ? playbackData.dash.audio : [];
  return {
    duration: Number(playbackData?.timelength) > 0 ? Number(playbackData.timelength) / 1000 : null,
    http_headers: requestHeaders,
    formats: [
      ...videoFormats.map(videoFormat => ({
        url: videoFormat.baseUrl || videoFormat.base_url,
        backup_urls: videoFormat.backupUrl || videoFormat.backup_url || [],
        ext: 'mp4',
        vcodec: String(videoFormat.codecs || ''),
        acodec: 'none',
        width: Number(videoFormat.width) || null,
        height: Number(videoFormat.height) || null,
        fps: parseFrameRate(videoFormat.frameRate || videoFormat.frame_rate),
        tbr: Number(videoFormat.bandwidth) > 0 ? Number(videoFormat.bandwidth) / 1000 : null,
        format_id: String(videoFormat.id || ''),
        http_headers: requestHeaders
      })),
      ...audioFormats.map(audioFormat => ({
        url: audioFormat.baseUrl || audioFormat.base_url,
        backup_urls: audioFormat.backupUrl || audioFormat.backup_url || [],
        ext: 'm4a',
        vcodec: 'none',
        acodec: String(audioFormat.codecs || ''),
        abr: Number(audioFormat.bandwidth) > 0 ? Number(audioFormat.bandwidth) / 1000 : null,
        tbr: Number(audioFormat.bandwidth) > 0 ? Number(audioFormat.bandwidth) / 1000 : null,
        format_id: String(audioFormat.id || ''),
        http_headers: requestHeaders
      }))
    ]
  };
}

async function resolveBilibiliPlaybackInfo(sourcePageUrl, options = {}) {
  const { bvid, page } = parseCanonicalVideoUrl(sourcePageUrl);
  const requestCredential = options.requestCredential || getBilibiliRequestCredential();
  const videoReferer = `${BILIBILI_WEB_ORIGIN}/video/${bvid}`;
  const viewUrl = new URL(`${BILIBILI_API_ORIGIN}/x/web-interface/view`);
  viewUrl.searchParams.set('bvid', bvid);
  const viewData = await requestBilibiliJson(viewUrl, {
    cookieHeader: requestCredential.cookieHeader,
    referer: videoReferer,
    fetchImpl: options.fetchImpl
  });
  const videoPages = Array.isArray(viewData?.pages) ? viewData.pages : [];
  const selectedPage = videoPages.find(pageEntry => Number(pageEntry.page) === page) || null;
  if ((videoPages.length > 0 && !selectedPage) || (videoPages.length === 0 && page !== 1)) {
    throw createBilibiliApiError(`Bilibili video page ${page} does not exist`);
  }
  const contentId = Number(selectedPage?.cid || viewData?.cid);
  if (!Number.isInteger(contentId) || contentId <= 0) {
    throw createBilibiliApiError('Bilibili did not return a playable content ID');
  }

  const mixinKey = await getWbiMixinKey(requestCredential, options);
  const signedQuery = signWbiParameters({
    bvid,
    cid: contentId,
    qn: 127,
    fnver: 0,
    fnval: 4048,
    fourk: 1,
    high_quality: 1
  }, mixinKey);
  const playbackData = await requestBilibiliJson(
    `${BILIBILI_API_ORIGIN}/x/player/wbi/playurl?${signedQuery}`,
    {
      cookieHeader: requestCredential.cookieHeader,
      referer: videoReferer,
      fetchImpl: options.fetchImpl
    }
  );
  if (!playbackData?.dash) {
    throw createBilibiliApiError('Bilibili did not return DASH playback streams for this video');
  }

  const mediaHeaders = createMediaRequestHeaders(videoReferer);
  return {
    ...normalizeDashFormats(playbackData, mediaHeaders),
    bvid,
    cid: contentId,
    title: String(selectedPage?.part || viewData?.title || '').slice(0, 200),
    credentialVersion: requestCredential.credentialVersion
  };
}

function clearBilibiliApiCaches() {
  wbiKeyCache = null;
}

module.exports = {
  clearBilibiliApiCaches,
  createWbiMixinKey,
  normalizeDashFormats,
  parseCanonicalVideoUrl,
  requestBilibiliJson,
  resolveBilibiliPlaybackInfo,
  signWbiParameters
};
