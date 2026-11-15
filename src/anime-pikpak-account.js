'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createPikPak } = require('./anime-pikpak');

const AUTH = 'https://user.mypikpak.com/v1';
const DRIVE = 'https://api-drive.mypikpak.com/drive/v1';
// Public Android client profile used by the PikPak SDK in Animeko.
const CLIENT = { client_id: 'YNxT9w7GMdWvEOKa', client_secret: 'dbw2OtmVEeuUvIptb1Coyg' };
const ANDROID_VERSION = '1.21.0';
const ANDROID_PACKAGE = 'com.pikcloud.pikpak';
const CAPTCHA_SALTS = [
  '', 'E32cSkYXC2bciKJGxRsE8ZgwmH/YwkvpD6/O9guSOa2irCwciH4xPHaH', 'QtqgfMgHP2TFl',
  'zOKgHT56L7nIzFzDpUGhpWFrgP53m3G6ML', 'S',
  'THxpsktzfFXizUv7DK1y/N7NZ1WhayViluBEvAJJ8bA1Wr6', 'y9PXH3xGUhG/zQI8CaapRw2LhldCaFM9CRlKpZXJvj+pifu',
  '+RaaG7T8FRTI4cP019N5y9ofLyHE9ySFUr', '6Pf1l8UTeuzYldGtb/d'
];
const FOLDER = 'Ciacord-BT';

function createPikPakAccount(dataDir, { request = fetch, secret = process.env.JWT_SECRET } = {}) {
  const file = path.join(dataDir, 'anime-pikpak-session');
  const key = secret && crypto.scryptSync(secret, 'ciacord-pikpak-session', 32);
  let account;
  let client;
  let changing = false;
  let legacy = createPikPak();
  try {
    const [iv, tag, value] = fs.readFileSync(file, 'utf8').split('.').map(part => Buffer.from(part, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const saved = JSON.parse(Buffer.concat([decipher.update(value), decipher.final()]));
    legacy = null;
    if (saved) activate(saved);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[anime] PikPak 登录状态无法读取');
  }

  function persist(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const temp = file + '.' + crypto.randomUUID();
    try {
      fs.writeFileSync(temp, [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64')).join('.'), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }

  async function call(url, state, signal, body, authenticated = false) {
    const headers = {
      Accept: 'application/json', 'User-Agent': `ANDROID-${ANDROID_PACKAGE}/${ANDROID_VERSION}`,
      'X-Client-Id': CLIENT.client_id, 'X-Device-Id': state.device
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (authenticated) headers.Authorization = 'Bearer ' + state.access;
    if (authenticated && state.captcha) headers['X-Captcha-Token'] = state.captcha;
    const response = await request(url, {
      method: body ? 'POST' : 'GET', headers, redirect: 'error', signal, body: body && JSON.stringify(body)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.error || Number(data.error_code)) {
      throw Object.assign(new Error('PikPak 拒绝请求'), { status: response.status, upstreamCode: Number(data?.error_code) });
    }
    return data;
  }

  function captureSession(state, data) {
    if (!data.access_token || !(data.refresh_token || state.refresh)) throw new Error('PikPak 未返回登录会话');
    state.access = data.access_token;
    state.refresh = data.refresh_token || state.refresh;
    if (data.sub) state.userId = data.sub;
    if (!state.userId) {
      try { state.userId = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64url')).sub; } catch {}
    }
    state.expires = Date.now() + Math.max(0, (Number(data.expires_in) || 0) - 60) * 1000;
  }

  async function refresh(state, rejected) {
    if (state.access && state.access !== rejected && state.expires > Date.now()) return;
    if (!state.refreshing) {
      state.refreshing = (async () => {
        const data = await call(AUTH + '/auth/token', state, AbortSignal.timeout(8000), {
          ...CLIENT, grant_type: 'refresh_token', refresh_token: state.refresh
        });
        captureSession(state, data);
        if (state === account) saveSession(state);
      })().finally(() => { state.refreshing = null; });
    }
    return state.refreshing;
  }

  function saveSession({ id, device, refresh, folder, folderName, userId }) {
    persist({ id, device, refresh, folder, folderName, userId });
  }

  async function refreshDriveChallenge(state, endpoint, signal, body) {
    const timestamp = String(Date.now());
    const input = CLIENT.client_id + ANDROID_VERSION + ANDROID_PACKAGE + state.device + timestamp;
    const signature = CAPTCHA_SALTS.reduce((value, salt) => crypto.createHash('md5').update(value + salt).digest('hex'), input);
    const action = (body ? 'POST:' : 'GET:') + '/drive/v1/' + endpoint.split(/[/?]/)[1];
    const result = await call(AUTH + '/shield/captcha/init?client_id=' + CLIENT.client_id, state, signal, {
      action, captcha_token: state.captcha || '', client_id: CLIENT.client_id, device_id: state.device,
      redirect_uri: 'https://api.mypikpak.com/v1/auth/callback',
      meta: { captcha_sign: '1.' + signature, user_id: state.userId || '', package_name: ANDROID_PACKAGE, client_version: ANDROID_VERSION, timestamp }
    });
    if (!result.captcha_token) throw new Error('PikPak 需要账号验证');
    state.captcha = result.captcha_token;
  }

  function driveFor(state) {
    return async (endpoint, signal, body) => {
      await refresh(state);
      signal.throwIfAborted();
      const previous = state.access;
      try {
        return await call(DRIVE + endpoint, state, signal, body, true);
      } catch (error) {
        if (error.upstreamCode === 9) await refreshDriveChallenge(state, endpoint, signal, body);
        else if (error.status === 401) await refresh(state, previous);
        else throw error;
        return call(DRIVE + endpoint, state, signal, body, true);
      }
    };
  }

  function activate(state) {
    account = state;
    client = createPikPak({ folder: state.folder, drive: driveFor(state) });
  }

  async function connect(username, password, folder) {
    if (changing) throw new Error('PikPak 设置正在更新');
    if (!key) throw new Error('服务器尚未配置登录密钥');
    changing = true;
    const state = { id: crypto.randomUUID(), device: crypto.randomBytes(16).toString('hex') };
    try {
      const signal = AbortSignal.timeout(15_000);
      const captcha = await call(AUTH + '/shield/captcha/init', state, signal, {
        client_id: CLIENT.client_id, device_id: state.device,
        action: 'POST:' + AUTH + '/auth/signin', meta: { username }
      });
      state.captcha = captcha.captcha_token;
      if (!state.captcha) throw new Error('请先在 PikPak 完成账号验证');
      const session = await call(AUTH + '/auth/signin', state, signal, {
        ...CLIENT, grant_type: 'password', username, password, captcha_token: state.captcha
      });
      captureSession(state, session);
      const drive = driveFor(state);
      const target = await drive('/files/' + encodeURIComponent(folder), signal).catch(error => {
        if ([403, 404].includes(error.status)) throw Object.assign(error, { invalidFolder: true });
        throw error;
      });
      if (target.kind !== 'drive#folder' || target.trashed || target.id !== folder) {
        throw Object.assign(new Error('无效的 PikPak 保存目录'), { invalidFolder: true });
      }
      state.folder = folder;
      state.folderName = target.name || folder;
      saveSession(state);
      legacy = null;
      activate(state);
    } finally { changing = false; }
  }

  function disconnect() {
    if (changing) throw new Error('PikPak 设置正在更新');
    persist(null);
    account = client = legacy = null;
  }

  return {
    connect, disconnect,
    status: () => ({
      connected: Boolean(client || legacy),
      folder: account ? account.folderName || FOLDER : null,
      folderId: account?.folder || null
    }),
    test: () => account && driveFor(account)('/about', AbortSignal.timeout(8000)),
    generation: () => account?.id || (legacy ? 'legacy' : false),
    video: (entry, selectVideo) => entry.cloud === (account?.id || 'legacy')
      ? (client || legacy)?.video(entry, selectVideo) : null
  };
}

module.exports = { createPikPakAccount };
