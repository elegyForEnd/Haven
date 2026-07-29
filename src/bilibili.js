'use strict';

// Bilibili Listen Together is intentionally kept in one server module.
// Internal closures preserve subsystem boundaries without spreading one
// integration across many small files.

const bilibiliCredentialStore = (() => {
const crypto = require('crypto');
const { getDb } = require('./database');

const BILIBILI_SECRET_KEY = 'bilibili_session';
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const MAX_COOKIE_VALUE_LENGTH = 16384;

function deriveEncryptionKey() {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('JWT_SECRET is required for Bilibili credential encryption');
  return crypto
    .createHash('sha256')
    .update(`${jwtSecret}:haven-bilibili-session`)
    .digest();
}

function encryptCredential(credential) {
  const initializationVector = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveEncryptionKey(), initializationVector);
  const plaintext = JSON.stringify(credential);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  return [
    initializationVector.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64')
  ].join('.');
}

function decryptCredential(encryptedValue) {
  if (typeof encryptedValue !== 'string') return null;
  const encryptedParts = encryptedValue.split('.');
  if (encryptedParts.length !== 3) return null;

  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      deriveEncryptionKey(),
      Buffer.from(encryptedParts[0], 'base64')
    );
    decipher.setAuthTag(Buffer.from(encryptedParts[1], 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedParts[2], 'base64')),
      decipher.final()
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch {
    return null;
  }
}

function sanitizeCookieCollection(cookies) {
  const sanitizedCookies = {};
  if (!cookies || typeof cookies !== 'object' || Array.isArray(cookies)) return sanitizedCookies;

  for (const [rawName, rawValue] of Object.entries(cookies)) {
    const cookieName = String(rawName || '').trim();
    const cookieValue = String(rawValue ?? '').trim();
    if (!COOKIE_NAME_PATTERN.test(cookieName)) continue;
    if (!cookieValue || cookieValue.length > MAX_COOKIE_VALUE_LENGTH || /[\u0000-\u001f\u007f;]/.test(cookieValue)) continue;
    sanitizedCookies[cookieName] = cookieValue;
  }
  return sanitizedCookies;
}

function getStoredBilibiliCredential() {
  const row = getDb().prepare(
    'SELECT encrypted_value, metadata, updated_at FROM server_secrets WHERE key = ?'
  ).get(BILIBILI_SECRET_KEY);
  if (!row) return null;

  const credential = decryptCredential(row.encrypted_value);
  if (!credential) return null;
  const cookies = sanitizeCookieCollection(credential.cookies);
  if (!cookies.SESSDATA) return null;

  let metadata = {};
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {}

  return {
    cookies,
    uid: String(metadata.uid || credential.uid || ''),
    displayName: String(metadata.displayName || credential.displayName || '').slice(0, 100),
    avatarUrl: String(metadata.avatarUrl || credential.avatarUrl || '').slice(0, 1000),
    credentialVersion: String(credential.credentialVersion || row.updated_at || 'stored'),
    updatedAt: row.updated_at || credential.updatedAt || null
  };
}

function saveBilibiliCredential(credential, updatedByUserId) {
  const cookies = sanitizeCookieCollection(credential?.cookies);
  if (!cookies.SESSDATA) throw new Error('Bilibili login did not return a valid SESSDATA cookie');

  const storedCredential = {
    cookies,
    uid: String(credential.uid || ''),
    displayName: String(credential.displayName || '').slice(0, 100),
    avatarUrl: String(credential.avatarUrl || '').slice(0, 1000),
    credentialVersion: `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`,
    updatedAt: new Date().toISOString()
  };
  const metadata = JSON.stringify({
    uid: storedCredential.uid,
    displayName: storedCredential.displayName,
    avatarUrl: storedCredential.avatarUrl
  });

  getDb().prepare(`
    INSERT INTO server_secrets (key, encrypted_value, metadata, updated_at, updated_by)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(key) DO UPDATE SET
      encrypted_value = excluded.encrypted_value,
      metadata = excluded.metadata,
      updated_at = CURRENT_TIMESTAMP,
      updated_by = excluded.updated_by
  `).run(
    BILIBILI_SECRET_KEY,
    encryptCredential(storedCredential),
    metadata,
    Number.isInteger(updatedByUserId) ? updatedByUserId : null
  );

  return getStoredBilibiliCredential();
}

function deleteBilibiliCredential() {
  getDb().prepare('DELETE FROM server_secrets WHERE key = ?').run(BILIBILI_SECRET_KEY);
}

function createCookieHeader(cookies) {
  return Object.entries(sanitizeCookieCollection(cookies))
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .map(([cookieName, cookieValue]) => `${cookieName}=${cookieValue}`)
    .join('; ');
}

function getBilibiliRequestCredential() {
  const credential = getStoredBilibiliCredential();
  return {
    cookieHeader: credential ? createCookieHeader(credential.cookies) : '',
    credentialVersion: credential?.credentialVersion || 'anonymous'
  };
}

function getBilibiliCredentialStatus() {
  const credential = getStoredBilibiliCredential();
  if (!credential) return { bound: false };
  return {
    bound: true,
    uid: credential.uid,
    displayName: credential.displayName,
    avatarUrl: credential.avatarUrl,
    updatedAt: credential.updatedAt
  };
}

return {
  createCookieHeader,
  decryptCredential,
  deleteBilibiliCredential,
  encryptCredential,
  getBilibiliCredentialStatus,
  getBilibiliRequestCredential,
  getStoredBilibiliCredential,
  sanitizeCookieCollection,
  saveBilibiliCredential
};
})();

const bilibiliApiClient = (() => {
const crypto = require('crypto');
const { getBilibiliRequestCredential } = bilibiliCredentialStore;

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

return {
  clearBilibiliApiCaches,
  createWbiMixinKey,
  normalizeDashFormats,
  parseCanonicalVideoUrl,
  requestBilibiliJson,
  resolveBilibiliPlaybackInfo,
  signWbiParameters
};
})();

const bilibiliAuth = (() => {
const crypto = require('crypto');
const QRCode = require('qrcode');
const {
  createCookieHeader,
  deleteBilibiliCredential,
  getBilibiliCredentialStatus,
  sanitizeCookieCollection,
  saveBilibiliCredential
} = bilibiliCredentialStore;
const { requestBilibiliJson } = bilibiliApiClient;

const QR_GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const QR_POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const QR_SESSION_LIFETIME_MS = 3 * 60 * 1000;
const QR_POLL_MINIMUM_INTERVAL_MS = 1500;
const REQUEST_TIMEOUT_MS = 12000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_USER_AGENT = process.env.BILIBILI_USER_AGENT
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

const qrSessions = new Map();
const qrStartPromisesByAdmin = new Map();

function splitCombinedSetCookieHeader(headerValue) {
  if (!headerValue) return [];
  return String(headerValue).split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/g);
}

function getSetCookieHeaders(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  return splitCombinedSetCookieHeader(response.headers.get('set-cookie'));
}

function extractResponseCookies(response) {
  const cookies = {};
  for (const setCookieHeader of getSetCookieHeaders(response)) {
    const firstCookiePart = String(setCookieHeader).split(';', 1)[0];
    const equalsIndex = firstCookiePart.indexOf('=');
    if (equalsIndex <= 0) continue;
    const cookieName = firstCookiePart.slice(0, equalsIndex).trim();
    const cookieValue = firstCookiePart.slice(equalsIndex + 1).trim();
    Object.assign(cookies, sanitizeCookieCollection({ [cookieName]: cookieValue }));
  }
  return cookies;
}

async function requestPassportJson(url, options = {}) {
  let response;
  try {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://www.bilibili.com',
      Referer: 'https://www.bilibili.com/',
      'User-Agent': DEFAULT_USER_AGENT
    };
    if (options.cookieHeader) headers.Cookie = options.cookieHeader;
    response = await (options.fetchImpl || fetch)(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error('Bilibili login request timed out');
    }
    throw new Error(`Could not connect to Bilibili login service: ${String(error?.message || 'network error').slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(response.status === 412
      ? 'Bilibili rejected the login request with HTTP 412 risk control'
      : `Bilibili login service returned HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Bilibili login returned an unexpectedly large response');
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
        throw new Error('Bilibili login returned an unexpectedly large response');
      }
      responseChunks.push(Buffer.from(value));
    }
  } else {
    const fallbackBuffer = Buffer.from(await response.arrayBuffer());
    if (fallbackBuffer.length > MAX_RESPONSE_BYTES) {
      throw new Error('Bilibili login returned an unexpectedly large response');
    }
    responseChunks.push(fallbackBuffer);
  }
  const responseBuffer = Buffer.concat(responseChunks, receivedBytes || undefined);

  let responseBody;
  try {
    responseBody = JSON.parse(responseBuffer.toString('utf8'));
  } catch {
    throw new Error('Bilibili login returned invalid JSON');
  }
  if (Number(responseBody?.code) !== 0) {
    throw new Error(String(responseBody?.message || 'Bilibili login request failed').slice(0, 200));
  }
  return {
    data: responseBody.data,
    cookies: extractResponseCookies(response)
  };
}

function pruneQrSessions(now = Date.now()) {
  for (const [sessionId, qrSession] of qrSessions) {
    if (qrSession.expiresAt <= now) qrSessions.delete(sessionId);
  }
}

async function startBilibiliQrLogin(adminUserId, options = {}) {
  const existingStartPromise = qrStartPromisesByAdmin.get(adminUserId);
  if (existingStartPromise) return existingStartPromise;

  const startPromise = createBilibiliQrLogin(adminUserId, options);
  qrStartPromisesByAdmin.set(adminUserId, startPromise);
  try {
    return await startPromise;
  } finally {
    if (qrStartPromisesByAdmin.get(adminUserId) === startPromise) {
      qrStartPromisesByAdmin.delete(adminUserId);
    }
  }
}

async function createBilibiliQrLogin(adminUserId, options = {}) {
  pruneQrSessions();
  for (const [sessionId, qrSession] of qrSessions) {
    if (qrSession.adminUserId === adminUserId) qrSessions.delete(sessionId);
  }

  const response = await requestPassportJson(QR_GENERATE_URL, options);
  const qrcodeKey = String(response.data?.qrcode_key || '');
  const qrcodeUrl = String(response.data?.url || '');
  if (!/^[0-9A-Za-z_-]{8,200}$/.test(qrcodeKey) || !qrcodeUrl.startsWith('https://')) {
    throw new Error('Bilibili did not return a valid login QR code');
  }

  const sessionId = crypto.randomBytes(24).toString('hex');
  const createdAt = Date.now();
  const qrSession = {
    sessionId,
    qrcodeKey,
    adminUserId,
    cookies: response.cookies,
    createdAt,
    expiresAt: createdAt + QR_SESSION_LIFETIME_MS,
    lastPolledAt: 0,
    pollInFlight: false
  };
  qrSessions.set(sessionId, qrSession);

  const qrDataUrl = await QRCode.toDataURL(qrcodeUrl, {
    width: 280,
    margin: 2,
    errorCorrectionLevel: 'M'
  });
  return {
    sessionId,
    qrDataUrl,
    expiresAt: qrSession.expiresAt,
    state: 'not_scanned'
  };
}

function mapQrLoginState(code) {
  if (code === 0) return 'success';
  if (code === 86090) return 'scanned_waiting_confirmation';
  if (code === 86101) return 'not_scanned';
  if (code === 86038) return 'expired';
  return 'error';
}

async function pollBilibiliQrLogin(adminUserId, sessionId, options = {}) {
  pruneQrSessions();
  const qrSession = qrSessions.get(String(sessionId || ''));
  if (!qrSession || qrSession.adminUserId !== adminUserId) {
    return { state: 'expired', message: 'The Bilibili login QR code has expired' };
  }
  const now = Date.now();
  if (qrSession.pollInFlight) {
    return { state: 'waiting', retryAfterMs: QR_POLL_MINIMUM_INTERVAL_MS };
  }
  if (now - qrSession.lastPolledAt < QR_POLL_MINIMUM_INTERVAL_MS) {
    return {
      state: 'waiting',
      retryAfterMs: QR_POLL_MINIMUM_INTERVAL_MS - (now - qrSession.lastPolledAt)
    };
  }
  qrSession.lastPolledAt = now;
  qrSession.pollInFlight = true;

  try {
    const pollUrl = new URL(QR_POLL_URL);
    pollUrl.searchParams.set('qrcode_key', qrSession.qrcodeKey);
    const response = await requestPassportJson(pollUrl, {
      ...options,
      cookieHeader: createCookieHeader(qrSession.cookies)
    });
    Object.assign(qrSession.cookies, response.cookies);
    const resultCode = Number(response.data?.code);
    const state = mapQrLoginState(resultCode);

    if (state === 'expired') {
      qrSessions.delete(qrSession.sessionId);
      return { state, message: 'The Bilibili login QR code has expired' };
    }
    if (state === 'error') {
      return {
        state,
        message: String(response.data?.message || `Bilibili login failed with code ${resultCode}`).slice(0, 200)
      };
    }
    if (state !== 'success') return { state };

    const cookieHeader = createCookieHeader(qrSession.cookies);
    const accountData = await requestBilibiliJson('https://api.bilibili.com/x/web-interface/nav', {
      cookieHeader,
      fetchImpl: options.fetchImpl
    });
    if (!accountData?.isLogin || !accountData?.mid) {
      throw new Error('Bilibili accepted the QR code but did not return a valid logged-in session');
    }
    if (typeof options.authorizeBeforeSave === 'function'
      && options.authorizeBeforeSave() !== true) {
      qrSessions.delete(qrSession.sessionId);
      throw new Error('Administrator permission was revoked before Bilibili binding completed');
    }

    const credential = saveBilibiliCredential({
      cookies: qrSession.cookies,
      uid: String(accountData.mid),
      displayName: String(accountData.uname || ''),
      avatarUrl: String(accountData.face || '')
    }, adminUserId);
    qrSessions.delete(qrSession.sessionId);
    return {
      state: 'success',
      status: {
        bound: true,
        uid: credential.uid,
        displayName: credential.displayName,
        avatarUrl: credential.avatarUrl,
        updatedAt: credential.updatedAt
      }
    };
  } finally {
    if (qrSessions.get(qrSession.sessionId) === qrSession) qrSession.pollInFlight = false;
  }
}

function cancelBilibiliQrLogin(adminUserId, sessionId) {
  const qrSession = qrSessions.get(String(sessionId || ''));
  if (!qrSession || qrSession.adminUserId !== adminUserId) return false;
  qrSessions.delete(qrSession.sessionId);
  return true;
}

function unbindBilibiliAccount() {
  deleteBilibiliCredential();
  qrSessions.clear();
  return getBilibiliCredentialStatus();
}

return {
  cancelBilibiliQrLogin,
  extractResponseCookies,
  getBilibiliCredentialStatus,
  mapQrLoginState,
  pollBilibiliQrLogin,
  splitCombinedSetCookieHeader,
  startBilibiliQrLogin,
  unbindBilibiliAccount
};
})();

const bilibiliHlsRemux = (() => {
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BILIBILI_HLS_DIR } = require('./paths');

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_READY_TIMEOUT_MS = 25000;
const DEFAULT_MAX_SESSION_BYTES = 1024 * 1024 * 1024;
const DEFAULT_SEGMENT_DURATION_SECONDS = 4;
const READY_POLL_INTERVAL_MS = 200;

let activeRemuxProcesses = 0;
const remuxWaiters = [];
let storageInitializationPromise = null;

function readPositiveIntegerEnvironment(name, fallback, maximum) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

function isBilibiliHlsEnabled() {
  return String(process.env.BILIBILI_HLS_ENABLED || 'true').toLowerCase() !== 'false';
}

function findFfmpegBinary() {
  const configuredPath = String(process.env.FFMPEG_PATH || '').trim();
  if (configuredPath) return configuredPath;
  for (const candidatePath of ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    try {
      fs.accessSync(candidatePath, fs.constants.X_OK);
      return candidatePath;
    } catch {}
  }
  return 'ffmpeg';
}

function createFfmpegHeaderBlock(headers) {
  if (!headers || typeof headers !== 'object') return '';
  const allowedNames = new Set(['Accept', 'Origin', 'Referer', 'User-Agent']);
  const headerLines = [];
  for (const [headerName, rawValue] of Object.entries(headers)) {
    if (!allowedNames.has(headerName) || typeof rawValue !== 'string') continue;
    const headerValue = rawValue.trim();
    if (!headerValue || /[\r\n]/.test(headerValue)) continue;
    headerLines.push(`${headerName}: ${headerValue}`);
  }
  return headerLines.length ? `${headerLines.join('\r\n')}\r\n` : '';
}

function appendFfmpegInputArguments(argumentsList, inputUrl, requestHeaders) {
  const headerBlock = createFfmpegHeaderBlock(requestHeaders);
  argumentsList.push(
    '-rw_timeout', '15000000',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5'
  );
  if (headerBlock) argumentsList.push('-headers', headerBlock);
  argumentsList.push('-i', inputUrl);
}

function buildFfmpegArguments(options) {
  const outputDirectory = options.outputDirectory;
  const segmentDurationSeconds = Number.isInteger(options.segmentDurationSeconds)
    ? Math.max(2, Math.min(10, options.segmentDurationSeconds))
    : readPositiveIntegerEnvironment(
      'BILIBILI_HLS_SEGMENT_SECONDS',
      DEFAULT_SEGMENT_DURATION_SECONDS,
      10
    );
  const playlistPath = path.join(outputDirectory, 'index.m3u8');
  const segmentPattern = path.join(outputDirectory, 'segment-%06d.m4s');
  const argumentsList = [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'warning',
    '-y'
  ];

  appendFfmpegInputArguments(argumentsList, options.videoUrl, options.videoRequestHeaders);
  appendFfmpegInputArguments(argumentsList, options.audioUrl, options.audioRequestHeaders);
  argumentsList.push(
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c', 'copy',
    '-max_interleave_delta', '0',
    '-f', 'hls',
    '-hls_segment_type', 'fmp4',
    '-hls_time', String(segmentDurationSeconds),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', segmentPattern,
    playlistPath
  );
  return argumentsList;
}

function acquireRemuxSlot(signal) {
  if (signal?.aborted) return Promise.reject(new Error('Bilibili HLS remux was cancelled'));
  const maximumConcurrent = readPositiveIntegerEnvironment(
    'BILIBILI_HLS_MAX_CONCURRENT',
    DEFAULT_MAX_CONCURRENT,
    16
  );
  if (activeRemuxProcesses < maximumConcurrent) {
    activeRemuxProcesses += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: null, cancelled: false };
    waiter.onAbort = () => {
      waiter.cancelled = true;
      reject(new Error('Bilibili HLS remux was cancelled'));
    };
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    remuxWaiters.push(waiter);
  }).then(() => {
    activeRemuxProcesses += 1;
  });
}

function releaseRemuxSlot() {
  activeRemuxProcesses = Math.max(0, activeRemuxProcesses - 1);
  while (remuxWaiters.length > 0) {
    const nextWaiter = remuxWaiters.shift();
    nextWaiter.signal?.removeEventListener('abort', nextWaiter.onAbort);
    if (nextWaiter.cancelled || nextWaiter.signal?.aborted) continue;
    nextWaiter.resolve();
    break;
  }
}

async function calculateDirectorySize(directoryPath) {
  let totalBytes = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) totalBytes += await calculateDirectorySize(entryPath);
    else if (entry.isFile()) {
      try {
        totalBytes += (await fs.promises.stat(entryPath)).size;
      } catch {}
    }
  }
  return totalBytes;
}

async function removeDirectoryWithRetry(directoryPath, attempts = 5) {
  for (let attemptNumber = 1; attemptNumber <= attempts; attemptNumber += 1) {
    try {
      await fs.promises.rm(directoryPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attemptNumber === attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, attemptNumber * 150));
    }
  }
}

function initializeBilibiliHlsStorage() {
  if (storageInitializationPromise) return storageInitializationPromise;
  storageInitializationPromise = (async () => {
    await fs.promises.mkdir(BILIBILI_HLS_DIR, { recursive: true });
    const entries = await fs.promises.readdir(BILIBILI_HLS_DIR, { withFileTypes: true });
    await Promise.all(entries.map(entry => removeDirectoryWithRetry(path.join(BILIBILI_HLS_DIR, entry.name))));
  })();
  return storageInitializationPromise;
}

async function isHlsOutputReady(outputDirectory) {
  const playlistPath = path.join(outputDirectory, 'index.m3u8');
  const initSegmentPath = path.join(outputDirectory, 'init.mp4');
  try {
    const [playlistStat, initStat, entries] = await Promise.all([
      fs.promises.stat(playlistPath),
      fs.promises.stat(initSegmentPath),
      fs.promises.readdir(outputDirectory)
    ]);
    return playlistStat.size > 0
      && initStat.size > 0
      && entries.some(entryName => /^segment-\d{6}\.m4s$/.test(entryName));
  } catch {
    return false;
  }
}

async function startBilibiliHlsRemux(options) {
  if (!isBilibiliHlsEnabled()) throw new Error('Bilibili HLS is disabled');
  await initializeBilibiliHlsStorage();
  await acquireRemuxSlot(options.signal);
  if (options.signal?.aborted) {
    releaseRemuxSlot();
    throw new Error('Bilibili HLS remux was cancelled');
  }

  const outputDirectory = options.outputDirectory;
  try {
    await fs.promises.mkdir(outputDirectory, { recursive: true });
  } catch (error) {
    releaseRemuxSlot();
    throw error;
  }
  const spawnProcess = options.spawnProcess || spawn;
  const ffmpegArguments = buildFfmpegArguments(options);
  let childProcess;
  try {
    childProcess = spawnProcess(findFfmpegBinary(), ffmpegArguments, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch (error) {
    releaseRemuxSlot();
    throw error;
  }

  let stopped = false;
  let stderrText = '';
  let readySettled = false;
  let completionSettled = false;
  let quotaExceededError = null;
  let forceKillTimer = null;
  let processClosed = false;
  const readyTimeoutMs = readPositiveIntegerEnvironment(
    'BILIBILI_HLS_READY_TIMEOUT_MS',
    DEFAULT_READY_TIMEOUT_MS,
    120000
  );
  const maximumSessionBytes = readPositiveIntegerEnvironment(
    'BILIBILI_HLS_MAX_SESSION_BYTES',
    DEFAULT_MAX_SESSION_BYTES,
    20 * 1024 * 1024 * 1024
  );
  const forceKillTimeoutMs = Number.isInteger(options.forceKillTimeoutMs)
    ? Math.max(1, options.forceKillTimeoutMs)
    : 3000;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (!processClosed) childProcess.kill('SIGTERM');
    forceKillTimer = setTimeout(() => {
      if (!processClosed) childProcess.kill('SIGKILL');
    }, forceKillTimeoutMs);
    forceKillTimer.unref?.();
  };
  const abortRemux = () => stop();
  options.signal?.addEventListener('abort', abortRemux, { once: true });

  const completion = new Promise((resolve, reject) => {
    const finishCompletion = (error) => {
      if (completionSettled) return;
      completionSettled = true;
      clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', abortRemux);
      releaseRemuxSlot();
      if (error) reject(error);
      else resolve();
    };
    childProcess.once('error', error => {
      processClosed = true;
      const unavailableError = error?.code === 'ENOENT'
        ? new Error('ffmpeg is not installed or FFMPEG_PATH is incorrect')
        : new Error(`ffmpeg could not be started: ${error.message}`);
      finishCompletion(unavailableError);
    });
    childProcess.once('close', exitCode => {
      processClosed = true;
      if (quotaExceededError) {
        finishCompletion(quotaExceededError);
        return;
      }
      if (stopped) {
        finishCompletion(null);
        return;
      }
      if (exitCode === 0) finishCompletion(null);
      else finishCompletion(new Error(stderrText.trim().slice(0, 500) || `ffmpeg exited with code ${exitCode}`));
    });
  });

  childProcess.stderr?.on('data', chunk => {
    if (stderrText.length < 8192) stderrText += chunk.toString('utf8');
  });

  const quotaTimer = setInterval(async () => {
    const directoryBytes = await calculateDirectorySize(outputDirectory);
    if (directoryBytes <= maximumSessionBytes || quotaExceededError) return;
    quotaExceededError = new Error('Bilibili HLS session exceeded its disk quota');
    stop();
  }, 2000);
  quotaTimer.unref?.();
  completion.finally(() => clearInterval(quotaTimer)).catch(() => {});

  const readyPromise = new Promise((resolve, reject) => {
    const readyStartedAt = Date.now();
    const pollReady = async () => {
      if (readySettled) return;
      if (await isHlsOutputReady(outputDirectory)) {
        readySettled = true;
        resolve();
        return;
      }
      if (completionSettled) {
        readySettled = true;
        completion.then(
          () => reject(new Error('ffmpeg stopped before the HLS playlist became ready')),
          reject
        );
        return;
      }
      if (Date.now() - readyStartedAt >= readyTimeoutMs) {
        readySettled = true;
        stop();
        reject(new Error('Timed out waiting for Bilibili HLS segments'));
        return;
      }
      setTimeout(pollReady, READY_POLL_INTERVAL_MS);
    };
    void pollReady();
  });

  try {
    await readyPromise;
  } catch (error) {
    stop();
    completion.catch(() => {});
    throw error;
  }

  return {
    childProcess,
    completion,
    ffmpegArguments,
    outputDirectory,
    stop
  };
}

return {
  buildFfmpegArguments,
  calculateDirectorySize,
  findFfmpegBinary,
  initializeBilibiliHlsStorage,
  isBilibiliHlsEnabled,
  isHlsOutputReady,
  removeDirectoryWithRetry,
  startBilibiliHlsRemux
};
})();

const bilibiliHlsRoute = (() => {
const fs = require('fs');
const { pipeline } = require('stream');

function setCommonHeaders(response) {
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

function endRequest(response, statusCode, reason) {
  if (!response.headersSent) response.setHeader('X-Haven-Bilibili-HLS-Status', reason);
  response.status(statusCode).end();
}

function parseByteRange(rangeHeader, fileSize) {
  if (rangeHeader === undefined) return null;
  if (typeof rangeHeader !== 'string' || rangeHeader.length > 100) return false;
  const rangeMatch = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!rangeMatch || (!rangeMatch[1] && !rangeMatch[2])) return false;

  let startByte;
  let endByte;
  if (!rangeMatch[1]) {
    const suffixLength = Number(rangeMatch[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
    startByte = Math.max(0, fileSize - suffixLength);
    endByte = fileSize - 1;
  } else {
    startByte = Number(rangeMatch[1]);
    endByte = rangeMatch[2] ? Number(rangeMatch[2]) : fileSize - 1;
  }

  if (!Number.isSafeInteger(startByte)
    || !Number.isSafeInteger(endByte)
    || startByte < 0
    || endByte < startByte
    || startByte >= fileSize) return false;
  return { startByte, endByte: Math.min(endByte, fileSize - 1) };
}

function createBilibiliHlsAssetHandler(options) {
  const lookupAsset = options.lookupAsset;
  return async function handleBilibiliHlsAsset(request, response) {
    setCommonHeaders(response);
    if (!['GET', 'HEAD'].includes(request.method)) return endRequest(response, 405, 'method-not-allowed');

    const lookup = lookupAsset(
      request.params?.trackId,
      request.params?.sessionVersion,
      request.params?.assetName
    );
    if (lookup.status === 'expired') return endRequest(response, 410, 'session-expired');
    if (lookup.status !== 'active' || !lookup.asset) return endRequest(response, 404, 'asset-not-found');

    const asset = lookup.asset;
    response.setHeader('Content-Type', asset.contentType);
    response.setHeader('Accept-Ranges', 'bytes');
    if (asset.assetName === 'index.m3u8') {
      let playlistBuffer;
      try {
        playlistBuffer = await fs.promises.readFile(asset.path);
      } catch {
        return endRequest(response, 404, 'asset-not-found');
      }
      response.setHeader('Cache-Control', 'private, no-store');
      const playlistRange = parseByteRange(request.headers.range, playlistBuffer.length);
      if (playlistRange === false) {
        response.setHeader('Content-Range', `bytes */${playlistBuffer.length}`);
        return endRequest(response, 416, 'invalid-range');
      }
      if (playlistRange) {
        response.status(206);
        response.setHeader(
          'Content-Range',
          `bytes ${playlistRange.startByte}-${playlistRange.endByte}/${playlistBuffer.length}`
        );
        const responseBuffer = playlistBuffer.subarray(playlistRange.startByte, playlistRange.endByte + 1);
        response.setHeader('Content-Length', responseBuffer.length);
        response.end(request.method === 'HEAD' ? undefined : responseBuffer);
        return;
      }
      response.status(200);
      response.setHeader('Content-Length', playlistBuffer.length);
      response.end(request.method === 'HEAD' ? undefined : playlistBuffer);
      return;
    }

    let assetStat;
    try {
      assetStat = await fs.promises.stat(asset.path);
    } catch {
      return endRequest(response, 404, 'asset-not-found');
    }
    if (!assetStat.isFile()) return endRequest(response, 404, 'asset-not-found');

    response.setHeader('Cache-Control', 'private, max-age=3600, immutable');

    const byteRange = parseByteRange(request.headers.range, assetStat.size);
    if (byteRange === false) {
      response.setHeader('Content-Range', `bytes */${assetStat.size}`);
      return endRequest(response, 416, 'invalid-range');
    }

    let streamOptions;
    if (byteRange) {
      response.status(206);
      response.setHeader('Content-Range', `bytes ${byteRange.startByte}-${byteRange.endByte}/${assetStat.size}`);
      response.setHeader('Content-Length', byteRange.endByte - byteRange.startByte + 1);
      streamOptions = { start: byteRange.startByte, end: byteRange.endByte };
    } else {
      response.status(200);
      response.setHeader('Content-Length', assetStat.size);
    }

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    const assetStream = fs.createReadStream(asset.path, streamOptions);
    response.once('close', () => {
      if (!response.writableEnded) assetStream.destroy();
    });
    pipeline(assetStream, response, error => {
      if (error && !response.destroyed) response.destroy(error);
    });
  };
}

return {
  createBilibiliHlsAssetHandler,
  parseByteRange
};
})();

const bilibiliMedia = (() => {
const { resolveBilibiliPlaybackInfo } = bilibiliApiClient;
const { getBilibiliRequestCredential } = bilibiliCredentialStore;

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

return {
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
})();

const bilibiliMediaProxy = (() => {
const dns = require('dns');
const https = require('https');
const net = require('net');
const { pipeline } = require('stream');

const DEFAULT_MAX_CONCURRENT_REQUESTS = 24;
const DEFAULT_RESERVED_AUDIO_REQUESTS = 8;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 3;
const BILIBILI_REFERER = 'https://www.bilibili.com/';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FORWARDED_RESPONSE_HEADERS = [
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified'
];

function readPositiveIntegerEnvironment(name, fallback, maximum) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

function readNonNegativeIntegerEnvironment(name, fallback, maximum) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return Math.min(value, maximum);
}

function isValidSingleRangeHeader(value) {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.length > 100) return false;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return false;
  if (match[1] && match[2] && Number(match[1]) > Number(match[2])) return false;
  return true;
}

function ipv4ToInteger(address) {
  const parts = address.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function isIpv4InCidr(address, baseAddress, prefixLength) {
  const addressValue = ipv4ToInteger(address);
  const baseValue = ipv4ToInteger(baseAddress);
  if (addressValue === null || baseValue === null) return false;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (addressValue & mask) === (baseValue & mask);
}

function parseIpv6ToBigInt(address) {
  let normalizedAddress = address.toLowerCase().split('%')[0];
  if (normalizedAddress.includes('.')) {
    const finalColon = normalizedAddress.lastIndexOf(':');
    const embeddedIpv4 = normalizedAddress.slice(finalColon + 1);
    const ipv4Value = ipv4ToInteger(embeddedIpv4);
    if (ipv4Value === null) return null;
    normalizedAddress = `${normalizedAddress.slice(0, finalColon)}:${((ipv4Value >>> 16) & 0xffff).toString(16)}:${(ipv4Value & 0xffff).toString(16)}`;
  }

  const halves = normalizedAddress.split('::');
  if (halves.length > 2) return null;
  const leftParts = halves[0] ? halves[0].split(':') : [];
  const rightParts = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missingParts = 8 - leftParts.length - rightParts.length;
  if (missingParts < 0 || (halves.length === 1 && missingParts !== 0)) return null;
  const parts = [...leftParts, ...Array(missingParts).fill('0'), ...rightParts];
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function isIpv6InCidr(address, baseAddress, prefixLength) {
  const addressValue = parseIpv6ToBigInt(address);
  const baseValue = parseIpv6ToBigInt(baseAddress);
  if (addressValue === null || baseValue === null) return false;
  const shift = BigInt(128 - prefixLength);
  return (addressValue >> shift) === (baseValue >> shift);
}

function isPublicIpAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const blockedRanges = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4]
    ];
    return !blockedRanges.some(([baseAddress, prefixLength]) => isIpv4InCidr(address, baseAddress, prefixLength));
  }
  if (family === 6) {
    const mappedIpv4Match = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mappedIpv4Match) return isPublicIpAddress(mappedIpv4Match[1]);
    if (isIpv6InCidr(address, '::ffff:0:0', 96)) {
      const ipv6Value = parseIpv6ToBigInt(address);
      const ipv4Value = Number(ipv6Value & 0xffffffffn);
      const mappedAddress = [24, 16, 8, 0]
        .map(shift => (ipv4Value >>> shift) & 0xff)
        .join('.');
      return isPublicIpAddress(mappedAddress);
    }
    const blockedRanges = [
      ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
      ['ff00::', 8], ['2001:db8::', 32]
    ];
    return !blockedRanges.some(([baseAddress, prefixLength]) => isIpv6InCidr(address, baseAddress, prefixLength));
  }
  return false;
}

async function resolvePublicAddress(hostname, resolveHostname = dns.promises.lookup) {
  if (net.isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) throw new Error('The Bilibili media host resolved to a private address');
    return { address: hostname, family: net.isIP(hostname) };
  }

  const addresses = await resolveHostname(hostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || addresses.length === 0) throw new Error('The Bilibili media host could not be resolved');
  if (addresses.some(entry => !isPublicIpAddress(entry.address))) {
    throw new Error('The Bilibili media host resolved to a private address');
  }
  // Prefer IPv4 when both families are available. This avoids selecting an
  // unreachable IPv6 CDN address on hosts with partial IPv6 configuration.
  return addresses.find(entry => Number(entry.family) === 4) || addresses[0];
}

async function validateUpstreamUrl(value, registeredHostname, resolveHostname) {
  const target = new URL(value);
  if (target.protocol !== 'https:' || target.username || target.password) {
    throw new Error('The Bilibili media URL is unsafe');
  }
  if (target.port && target.port !== '443') throw new Error('The Bilibili media URL uses an unsupported port');
  if (registeredHostname && target.hostname.toLowerCase() !== registeredHostname.toLowerCase()) {
    throw new Error('The Bilibili media host changed unexpectedly');
  }
  const resolvedAddress = await resolvePublicAddress(target.hostname, resolveHostname);
  return { target, resolvedAddress };
}

function setProxyResponseHeaders(response) {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

function endProxyRequest(response, statusCode, reason) {
  if (!response.headersSent) response.setHeader('X-Haven-Bilibili-Status', reason);
  return response.status(statusCode).end();
}

function copyUpstreamResponseHeaders(upstreamResponse, response, fallbackContentType) {
  for (const headerName of FORWARDED_RESPONSE_HEADERS) {
    const value = upstreamResponse.headers[headerName];
    if (value !== undefined) response.setHeader(headerName, value);
  }
  const upstreamContentType = String(upstreamResponse.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const contentType = /^(audio|video)\//.test(upstreamContentType)
    ? upstreamResponse.headers['content-type']
    : fallbackContentType;
  if (contentType) response.setHeader('Content-Type', contentType);
}

function createBilibiliMediaProxyHandler(options) {
  const lookupResource = options.lookupResource;
  const resolveHostname = options.resolveHostname || dns.promises.lookup;
  const requestFactory = options.requestFactory || https.request;
  const maxConcurrentRequests = options.maxConcurrentRequests || readPositiveIntegerEnvironment(
    'BILIBILI_PROXY_MAX_CONCURRENT',
    DEFAULT_MAX_CONCURRENT_REQUESTS,
    200
  );
  const upstreamTimeoutMs = options.upstreamTimeoutMs || readPositiveIntegerEnvironment(
    'BILIBILI_PROXY_TIMEOUT_MS',
    DEFAULT_UPSTREAM_TIMEOUT_MS,
    120000
  );
  const reservedAudioRequests = Math.min(
    Math.max(0, maxConcurrentRequests - 1),
    options.reservedAudioRequests ?? readNonNegativeIntegerEnvironment(
      'BILIBILI_PROXY_RESERVED_AUDIO',
      DEFAULT_RESERVED_AUDIO_REQUESTS,
      100
    )
  );
  const maximumVideoRequests = Math.max(1, maxConcurrentRequests - reservedAudioRequests);
  let activeRequests = 0;
  let activeVideoRequests = 0;

  return async function handleBilibiliMediaProxy(request, response) {
    setProxyResponseHeaders(response);
    if (request.method !== 'GET' && request.method !== 'HEAD') return endProxyRequest(response, 405, 'method-not-allowed');
    if (!isValidSingleRangeHeader(request.headers.range)) return endProxyRequest(response, 416, 'invalid-range');
    const streamVersion = typeof request.query?.v === 'string' ? request.query.v : '';
    const lookup = lookupResource(request.params?.trackId, request.params?.mediaKind, streamVersion);
    if (lookup.status === 'missing') return endProxyRequest(response, 404, 'stream-not-active');
    if (lookup.status === 'expired') return endProxyRequest(response, 410, 'stream-expired');
    const resource = lookup.resource;
    if (activeRequests >= maxConcurrentRequests) return endProxyRequest(response, 503, 'proxy-busy');
    if (resource.mediaKind === 'video' && activeVideoRequests >= maximumVideoRequests) {
      return endProxyRequest(response, 503, 'video-capacity-reserved-for-audio');
    }

    activeRequests += 1;
    if (resource.mediaKind === 'video') activeVideoRequests += 1;
    let currentUpstreamRequest = null;
    let requestFinished = false;
    const releaseRequest = () => {
      if (requestFinished) return;
      requestFinished = true;
      activeRequests = Math.max(0, activeRequests - 1);
      if (resource.mediaKind === 'video') activeVideoRequests = Math.max(0, activeVideoRequests - 1);
    };
    response.once('finish', releaseRequest);
    response.once('close', () => {
      if (!response.writableEnded) currentUpstreamRequest?.destroy();
      releaseRequest();
    });
    const requestUpstream = async (targetValue, redirectCount, expectedHostname) => {
      let validated;
      try {
        validated = await validateUpstreamUrl(targetValue, expectedHostname, resolveHostname);
      } catch (error) {
        console.warn(`[BilibiliProxy] ${resource.trackId}/${resource.mediaKind}: upstream validation failed: ${error.message}`);
        if (!response.headersSent) endProxyRequest(response, 502, 'upstream-validation-failed');
        else response.destroy(error);
        return;
      }

      const upstreamHeaders = {
        ...(resource.requestHeaders || {}),
        'Accept': resource.requestHeaders?.Accept || '*/*',
        'Accept-Encoding': 'identity',
        'Referer': resource.requestHeaders?.Referer || resource.sourcePageUrl || BILIBILI_REFERER,
        'User-Agent': resource.requestHeaders?.['User-Agent'] || BROWSER_USER_AGENT
      };
      if (request.headers.range) upstreamHeaders.Range = request.headers.range;
      if (typeof request.headers['if-range'] === 'string' && request.headers['if-range'].length <= 256) {
        upstreamHeaders['If-Range'] = request.headers['if-range'];
      }

      currentUpstreamRequest = requestFactory(validated.target, {
        method: request.method,
        headers: upstreamHeaders,
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions?.all) {
            callback(null, [validated.resolvedAddress]);
            return;
          }
          callback(null, validated.resolvedAddress.address, validated.resolvedAddress.family);
        }
      }, upstreamResponse => {
        const isRedirect = [301, 302, 303, 307, 308].includes(upstreamResponse.statusCode);
        const location = upstreamResponse.headers.location;
        if (isRedirect && location) {
          upstreamResponse.resume();
          if (redirectCount >= MAX_REDIRECTS) {
            endProxyRequest(response, 502, 'too-many-redirects');
            return;
          }
          let redirectUrl;
          try {
            redirectUrl = new URL(location, validated.target).toString();
          } catch {
            endProxyRequest(response, 502, 'invalid-redirect');
            return;
          }
          void requestUpstream(redirectUrl, redirectCount + 1, null);
          return;
        }

        const statusCode = Number(upstreamResponse.statusCode) || 502;
        if (![200, 206, 416].includes(statusCode)) {
          upstreamResponse.resume();
          console.warn(`[BilibiliProxy] ${resource.trackId}/${resource.mediaKind}: upstream ${resource.upstreamHostname} returned ${statusCode}`);
          endProxyRequest(response, statusCode >= 500 ? 503 : 502, `upstream-${statusCode}`);
          return;
        }
        if (request.headers.range && statusCode === 200) {
          upstreamResponse.resume();
          endProxyRequest(response, 502, 'range-not-honored');
          return;
        }

        response.status(statusCode);
        copyUpstreamResponseHeaders(upstreamResponse, response, resource.contentType);
        if (request.method === 'HEAD' || statusCode === 416) {
          upstreamResponse.resume();
          response.end();
          return;
        }

        pipeline(upstreamResponse, response, error => {
          if (error && !response.destroyed) response.destroy(error);
        });
      });

      currentUpstreamRequest.setTimeout(upstreamTimeoutMs, () => {
        console.warn(`[BilibiliProxy] ${resource.trackId}/${resource.mediaKind}: upstream request timed out`);
        currentUpstreamRequest.destroy(new Error('Bilibili media upstream timed out'));
      });
      currentUpstreamRequest.on('error', error => {
        console.warn(`[BilibiliProxy] ${resource.trackId}/${resource.mediaKind}: upstream request failed: ${error.message}`);
        if (!response.headersSent) endProxyRequest(response, 503, 'upstream-request-failed');
        else if (!response.destroyed) response.destroy(error);
      });
      currentUpstreamRequest.end();
    };

    request.setTimeout?.(0);
    response.setTimeout?.(0);
    await requestUpstream(resource.upstreamUrl, 0, resource.upstreamHostname);
  };
}

return {
  createBilibiliMediaProxyHandler,
  isPublicIpAddress,
  isValidSingleRangeHeader,
  validateUpstreamUrl
};
})();

const bilibiliMediaSession = (() => {
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BILIBILI_HLS_DIR } = require('./paths');
const {
  clearBilibiliStreamRegistrations,
  normalizePreferredVideoHeight,
  registerBilibiliStream,
  resolveBilibiliSourceMedia
} = bilibiliMedia;
const {
  calculateDirectorySize,
  initializeBilibiliHlsStorage,
  isBilibiliHlsEnabled,
  removeDirectoryWithRetry,
  startBilibiliHlsRemux
} = bilibiliHlsRemux;

const DEFAULT_VIDEO_HEIGHT = 360;
const DEFAULT_GENERATION_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_STALE_SESSION_MS = 60 * 60 * 1000;
const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MAX_SESSION_BYTES = 1024 * 1024 * 1024;

const sessionsById = new Map();
const currentSessionsByMediaKey = new Map();
const sessionsByTrackId = new Map();
const inFlightSessions = new Map();
const cancelledTrackIds = new Set();
let reservedHlsBytes = 0;
let quotaAdmissionPromise = Promise.resolve();

function readPositiveIntegerEnvironment(name, fallback, maximum) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

function isValidTrackId(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
}

function isValidSessionVersion(value) {
  return typeof value === 'string' && /^\d{13}-[a-f0-9]{16}$/i.test(value);
}

function isAllowedHlsAssetName(value) {
  return value === 'index.m3u8'
    || value === 'init.mp4'
    || /^segment-\d{6}\.m4s$/.test(value);
}

function createMediaKey(sourcePageUrl, selectedSource) {
  const selectedVideoHeight = Number(selectedSource?.selectedVideoHeight)
    || Number(selectedSource?.height)
    || DEFAULT_VIDEO_HEIGHT;
  const credentialVersion = String(selectedSource?.credentialVersion || 'anonymous');
  return crypto
    .createHash('sha256')
    .update(`${sourcePageUrl}|height=${selectedVideoHeight}|codecs=h264-aac-v1|credential=${credentialVersion}`)
    .digest('hex');
}

function createSessionVersion() {
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

function createCancelledError() {
  const error = new Error('Bilibili playback session was cancelled');
  error.code = 'BILIBILI_SESSION_CANCELLED';
  return error;
}

function createDashPayload(trackId, sourcePageUrl, selectedSource) {
  return registerBilibiliStream(
    trackId,
    sourcePageUrl,
    selectedSource,
    selectedSource.expiresAt
  );
}

function createCombinedPayload(trackId, session, dashPayload) {
  if (!session) return dashPayload;
  return {
    ...dashPayload,
    transport: 'hls-fmp4',
    hlsUrl: `/api/bilibili-hls/${trackId}/${session.sessionVersion}/index.m3u8`,
    hlsMime: 'application/vnd.apple.mpegurl'
  };
}

function getTrackSessions(trackId) {
  const trackSessions = sessionsByTrackId.get(trackId) || new Map();
  sessionsByTrackId.set(trackId, trackSessions);
  return trackSessions;
}

function cancelCleanupTimer(session) {
  if (!session.cleanupTimer) return;
  clearTimeout(session.cleanupTimer);
  session.cleanupTimer = null;
}

async function destroySession(session) {
  if (!session || session.destroyed) return;
  session.destroyed = true;
  cancelCleanupTimer(session);
  session.remux?.stop();
  sessionsById.delete(session.sessionId);
  if (currentSessionsByMediaKey.get(session.mediaKey) === session) {
    currentSessionsByMediaKey.delete(session.mediaKey);
  }
  for (const trackId of session.trackIds) {
    const trackSessions = sessionsByTrackId.get(trackId);
    trackSessions?.delete(session.sessionVersion);
    if (trackSessions?.size === 0) sessionsByTrackId.delete(trackId);
  }
  session.trackIds.clear();
  if (session.reservedBytes > 0) {
    reservedHlsBytes = Math.max(0, reservedHlsBytes - session.reservedBytes);
    session.reservedBytes = 0;
  }
  if (session.remux?.completion) {
    await Promise.race([
      session.remux.completion.catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 4000))
    ]);
  }
  try {
    await removeDirectoryWithRetry(session.outputDirectory);
  } catch (error) {
    console.warn(`[BilibiliHLS] Could not remove ${session.sessionVersion}: ${error.message}`);
  }
}

function scheduleSessionCleanup(session, delayMs = DEFAULT_GENERATION_GRACE_MS) {
  if (!session || session.destroyed || session.trackIds.size > 0 || session.cleanupTimer) return;
  session.cleanupTimer = setTimeout(() => {
    session.cleanupTimer = null;
    void destroySession(session);
  }, delayMs);
  session.cleanupTimer.unref?.();
}

function disassociateTrackFromSession(trackId, session) {
  if (!session) return;
  session.trackIds.delete(trackId);
  const trackSessions = sessionsByTrackId.get(trackId);
  trackSessions?.delete(session.sessionVersion);
  if (trackSessions?.size === 0) sessionsByTrackId.delete(trackId);
  scheduleSessionCleanup(session);
}

function associateTrackWithSession(trackId, session) {
  cancelCleanupTimer(session);
  session.trackIds.add(trackId);
  session.lastAccessedAt = Date.now();
  const trackSessions = getTrackSessions(trackId);
  for (const previousSession of trackSessions.values()) {
    if (previousSession !== session) {
      setTimeout(() => disassociateTrackFromSession(trackId, previousSession), DEFAULT_GENERATION_GRACE_MS).unref?.();
    }
  }
  trackSessions.set(session.sessionVersion, session);
}

function withQuotaAdmissionLock(callback) {
  const admissionTask = quotaAdmissionPromise.then(callback, callback);
  quotaAdmissionPromise = admissionTask.catch(() => {});
  return admissionTask;
}

async function reserveSessionCapacity() {
  const maximumTotalBytes = readPositiveIntegerEnvironment(
    'BILIBILI_HLS_MAX_TOTAL_BYTES',
    DEFAULT_MAX_TOTAL_BYTES,
    100 * 1024 * 1024 * 1024
  );
  const reservationBytes = readPositiveIntegerEnvironment(
    'BILIBILI_HLS_MAX_SESSION_BYTES',
    DEFAULT_MAX_SESSION_BYTES,
    20 * 1024 * 1024 * 1024
  );
  return withQuotaAdmissionLock(async () => {
    let currentBytes = await calculateDirectorySize(BILIBILI_HLS_DIR);
    if (currentBytes + reservedHlsBytes + reservationBytes > maximumTotalBytes) {
      const removableSessions = [...sessionsById.values()]
        .filter(session => session.trackIds.size === 0 && session.state !== 'starting')
        .sort((leftSession, rightSession) => leftSession.lastAccessedAt - rightSession.lastAccessedAt);
      for (const session of removableSessions) {
        await destroySession(session);
        currentBytes = await calculateDirectorySize(BILIBILI_HLS_DIR);
        if (currentBytes + reservedHlsBytes + reservationBytes <= maximumTotalBytes) break;
      }
    }
    if (currentBytes + reservedHlsBytes + reservationBytes > maximumTotalBytes) return 0;
    reservedHlsBytes += reservationBytes;
    return reservationBytes;
  });
}

async function createHlsSession(sourcePageUrl, selectedSource, mediaKey, options = {}) {
  await initializeBilibiliHlsStorage();
  const reservedBytes = await reserveSessionCapacity();
  if (!reservedBytes) {
    throw new Error('Bilibili HLS disk quota is full');
  }

  const sessionVersion = createSessionVersion();
  const sessionId = crypto.randomBytes(16).toString('hex');
  const outputDirectory = path.join(BILIBILI_HLS_DIR, sessionId);
  const session = {
    sessionId,
    sessionVersion,
    mediaKey,
    sourcePageUrl,
    outputDirectory,
    state: 'starting',
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    trackIds: new Set(),
    cleanupTimer: null,
    destroyed: false,
    remux: null,
    failureMessage: null,
    reservedBytes
  };
  sessionsById.set(sessionId, session);

  try {
    const startRemux = options.startRemux || startBilibiliHlsRemux;
    session.remux = await startRemux({
      outputDirectory,
      videoUrl: selectedSource.videoUrl,
      audioUrl: selectedSource.audioUrl,
      videoRequestHeaders: selectedSource.videoRequestHeaders,
      audioRequestHeaders: selectedSource.audioRequestHeaders,
      signal: options.signal
    });
    if (session.destroyed) {
      session.remux.stop();
      await session.remux.completion.catch(() => {});
      await removeDirectoryWithRetry(outputDirectory).catch(() => {});
      throw new Error('Bilibili HLS session was cancelled while starting');
    }
    session.state = 'ready';
    currentSessionsByMediaKey.set(mediaKey, session);
    session.remux.completion.then(() => {
      if (session.reservedBytes > 0) {
        reservedHlsBytes = Math.max(0, reservedHlsBytes - session.reservedBytes);
        session.reservedBytes = 0;
      }
      if (!session.destroyed) session.state = 'completed';
    }).catch(error => {
      if (session.reservedBytes > 0) {
        reservedHlsBytes = Math.max(0, reservedHlsBytes - session.reservedBytes);
        session.reservedBytes = 0;
      }
      if (session.destroyed) return;
      session.state = 'failed';
      session.failureMessage = error.message;
      console.warn(`[BilibiliHLS] ${session.sessionVersion} stopped: ${error.message}`);
    });
    return session;
  } catch (error) {
    session.state = 'failed';
    session.failureMessage = error.message;
    await destroySession(session);
    throw error;
  }
}

async function ensureBilibiliPlaybackSession(options) {
  const trackId = String(options.trackId || '');
  const sourcePageUrl = String(options.sourcePageUrl || '');
  if (!isValidTrackId(trackId)) throw new Error('A valid track ID is required for Bilibili playback');
  cancelledTrackIds.delete(trackId);
  const preferredVideoHeight = normalizePreferredVideoHeight(options.preferredVideoHeight);

  const resolveSourceMedia = options.resolveSourceMedia || resolveBilibiliSourceMedia;
  const selectedSource = await resolveSourceMedia(sourcePageUrl, {
    force: options.force === true,
    preferredVideoHeight
  });
  const dashPayload = createDashPayload(trackId, sourcePageUrl, selectedSource);
  if (cancelledTrackIds.has(trackId)) {
    clearBilibiliStreamRegistrations(trackId);
    throw createCancelledError();
  }
  const hlsEnabled = typeof options.hlsEnabled === 'boolean' ? options.hlsEnabled : isBilibiliHlsEnabled();
  if (!hlsEnabled) return dashPayload;

  const mediaKey = createMediaKey(sourcePageUrl, selectedSource);
  if (options.force !== true) {
    const existingSession = currentSessionsByMediaKey.get(mediaKey);
    if (existingSession && !existingSession.destroyed && ['ready', 'completed'].includes(existingSession.state)) {
      associateTrackWithSession(trackId, existingSession);
      return createCombinedPayload(trackId, existingSession, dashPayload);
    }
  }

  const inFlightKey = options.force === true ? `${mediaKey}|force` : mediaKey;
  let inFlightEntry = inFlightSessions.get(inFlightKey);
  if (!inFlightEntry) {
    const abortController = new AbortController();
    inFlightEntry = {
      abortController,
      pendingTrackIds: new Set(),
      promise: createHlsSession(sourcePageUrl, selectedSource, mediaKey, {
        startRemux: options.startRemux,
        signal: abortController.signal
      })
    };
    inFlightSessions.set(inFlightKey, inFlightEntry);
  }
  inFlightEntry.pendingTrackIds.add(trackId);

  try {
    const session = await inFlightEntry.promise;
    if (cancelledTrackIds.has(trackId)) {
      clearBilibiliStreamRegistrations(trackId);
      scheduleSessionCleanup(session);
      throw createCancelledError();
    }
    associateTrackWithSession(trackId, session);
    return createCombinedPayload(trackId, session, dashPayload);
  } catch (error) {
    if (error?.code === 'BILIBILI_SESSION_CANCELLED') throw error;
    console.warn(`[BilibiliHLS] Falling back to DASH: ${error.message}`);
    return dashPayload;
  } finally {
    inFlightEntry.pendingTrackIds.delete(trackId);
    if (inFlightSessions.get(inFlightKey) === inFlightEntry) inFlightSessions.delete(inFlightKey);
  }
}

function lookupBilibiliHlsAsset(trackId, sessionVersion, assetName) {
  if (!isValidTrackId(trackId) || !isValidSessionVersion(sessionVersion) || !isAllowedHlsAssetName(assetName)) {
    return { status: 'missing', asset: null };
  }
  const session = sessionsByTrackId.get(trackId)?.get(sessionVersion);
  if (!session || session.destroyed) return { status: 'missing', asset: null };
  if (session.state === 'failed' && !fs.existsSync(path.join(session.outputDirectory, assetName))) {
    return { status: 'expired', asset: null };
  }
  const assetPath = path.join(session.outputDirectory, assetName);
  if (!fs.existsSync(assetPath)) return { status: 'missing', asset: null };
  session.lastAccessedAt = Date.now();
  return {
    status: 'active',
    asset: {
      path: assetPath,
      assetName,
      sessionVersion,
      trackId,
      contentType: assetName === 'index.m3u8'
        ? 'application/vnd.apple.mpegurl'
        : assetName === 'init.mp4'
          ? 'video/mp4'
          : 'video/iso.segment'
    }
  };
}

function releaseBilibiliPlaybackSession(trackId) {
  if (!isValidTrackId(trackId)) return;
  cancelledTrackIds.add(trackId);
  const cancellationCleanupTimer = setTimeout(() => {
    cancelledTrackIds.delete(trackId);
  }, 2 * 60 * 1000);
  cancellationCleanupTimer.unref?.();
  for (const inFlightEntry of inFlightSessions.values()) {
    inFlightEntry.pendingTrackIds.delete(trackId);
    if (inFlightEntry.pendingTrackIds.size === 0) inFlightEntry.abortController.abort();
  }
  clearBilibiliStreamRegistrations(trackId);
  const trackSessions = sessionsByTrackId.get(trackId);
  if (!trackSessions) return;
  for (const session of [...trackSessions.values()]) disassociateTrackFromSession(trackId, session);
  sessionsByTrackId.delete(trackId);
}

async function pruneBilibiliPlaybackSessions(now = Date.now()) {
  const staleSessionMs = readPositiveIntegerEnvironment(
    'BILIBILI_HLS_STALE_MS',
    DEFAULT_STALE_SESSION_MS,
    24 * 60 * 60 * 1000
  );
  for (const session of [...sessionsById.values()]) {
    if (session.trackIds.size === 0 && now - session.lastAccessedAt >= staleSessionMs) {
      await destroySession(session);
    }
  }
}

async function cleanupAllBilibiliPlaybackSessions() {
  const sessions = [...sessionsById.values()];
  for (const session of sessions) session.remux?.stop();
  await Promise.allSettled(sessions.map(session => destroySession(session)));
  currentSessionsByMediaKey.clear();
  sessionsByTrackId.clear();
  inFlightSessions.clear();
  cancelledTrackIds.clear();
}

return {
  cleanupAllBilibiliPlaybackSessions,
  ensureBilibiliPlaybackSession,
  isAllowedHlsAssetName,
  isValidSessionVersion,
  lookupBilibiliHlsAsset,
  pruneBilibiliPlaybackSessions,
  releaseBilibiliPlaybackSession
};
})();

const registerBilibiliAdmin = (() => {
const {
  cancelBilibiliQrLogin,
  getBilibiliCredentialStatus,
  pollBilibiliQrLogin,
  startBilibiliQrLogin,
  unbindBilibiliAccount
} = bilibiliAuth;
const { clearBilibiliApiCaches } = bilibiliApiClient;
const { clearBilibiliMedia } = bilibiliMedia;

function getCurrentAdmin(db, userId) {
  if (!Number.isInteger(userId)) return null;
  const user = db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(userId);
  return user?.is_admin ? user : null;
}

function emitAdminError(socket, error) {
  socket.emit('bilibili-auth-error', {
    message: String(error?.message || 'Bilibili account operation failed').slice(0, 240)
  });
}

return function registerBilibiliAdmin(socket, ctx) {
  const { db, logAudit } = ctx;

  socket.on('get-bilibili-auth-status', () => {
    if (!getCurrentAdmin(db, socket.user?.id)) return;
    socket.emit('bilibili-auth-status', getBilibiliCredentialStatus());
  });

  socket.on('start-bilibili-qr-login', async () => {
    const admin = getCurrentAdmin(db, socket.user?.id);
    if (!admin) return emitAdminError(socket, new Error('Admin only'));
    try {
      const loginSession = await startBilibiliQrLogin(admin.id);
      if (!getCurrentAdmin(db, socket.user?.id)) {
        cancelBilibiliQrLogin(admin.id, loginSession.sessionId);
        throw new Error('Administrator permission was revoked before QR login started');
      }
      socket.emit('bilibili-qr-login-started', loginSession);
      logAudit({
        actor: socket.user,
        action: 'bilibili_binding_started',
        target_type: 'server_integration',
        target_name: 'Bilibili'
      });
    } catch (error) {
      emitAdminError(socket, error);
    }
  });

  socket.on('poll-bilibili-qr-login', async data => {
    const admin = getCurrentAdmin(db, socket.user?.id);
    if (!admin) return emitAdminError(socket, new Error('Admin only'));
    const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
    if (!/^[a-f0-9]{48}$/.test(sessionId)) return;

    try {
      const result = await pollBilibiliQrLogin(admin.id, sessionId, {
        authorizeBeforeSave: () => !!getCurrentAdmin(db, socket.user?.id)
      });
      socket.emit('bilibili-qr-login-status', result);
      if (result.state === 'success') {
        clearBilibiliApiCaches();
        clearBilibiliMedia();
        socket.emit('bilibili-auth-status', result.status);
        logAudit({
          actor: socket.user,
          action: 'bilibili_binding_completed',
          target_type: 'server_integration',
          target_name: result.status?.displayName || 'Bilibili',
          details: { uid: result.status?.uid || null }
        });
      }
    } catch (error) {
      emitAdminError(socket, error);
    }
  });

  socket.on('cancel-bilibili-qr-login', data => {
    const admin = getCurrentAdmin(db, socket.user?.id);
    if (!admin) return;
    const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
    cancelBilibiliQrLogin(admin.id, sessionId);
    socket.emit('bilibili-qr-login-status', { state: 'cancelled' });
  });

  socket.on('unbind-bilibili-account', () => {
    const admin = getCurrentAdmin(db, socket.user?.id);
    if (!admin) return emitAdminError(socket, new Error('Admin only'));
    try {
      const previousStatus = getBilibiliCredentialStatus();
      const status = unbindBilibiliAccount();
      clearBilibiliApiCaches();
      clearBilibiliMedia();
      socket.emit('bilibili-auth-status', status);
      logAudit({
        actor: socket.user,
        action: 'bilibili_binding_removed',
        target_type: 'server_integration',
        target_name: previousStatus.displayName || 'Bilibili',
        details: { uid: previousStatus.uid || null }
      });
    } catch (error) {
      emitAdminError(socket, error);
    }
  });
};
})();

module.exports = {
  ...bilibiliCredentialStore,
  ...bilibiliApiClient,
  ...bilibiliAuth,
  ...bilibiliHlsRemux,
  ...bilibiliHlsRoute,
  ...bilibiliMedia,
  ...bilibiliMediaProxy,
  ...bilibiliMediaSession,
  registerBilibiliAdmin
};

