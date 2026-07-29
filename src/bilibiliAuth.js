'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');
const {
  createCookieHeader,
  deleteBilibiliCredential,
  getBilibiliCredentialStatus,
  sanitizeCookieCollection,
  saveBilibiliCredential
} = require('./bilibiliCredentialStore');
const { requestBilibiliJson } = require('./bilibiliApiClient');

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

module.exports = {
  cancelBilibiliQrLogin,
  extractResponseCookies,
  getBilibiliCredentialStatus,
  mapQrLoginState,
  pollBilibiliQrLogin,
  splitCombinedSetCookieHeader,
  startBilibiliQrLogin,
  unbindBilibiliAccount
};
