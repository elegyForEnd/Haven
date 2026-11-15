'use strict';

const { chromium } = require('playwright-core');
const { openPublic } = require('./anime-media');

let browser;
let active = 0;

async function captureMedia(target, { userAgent, referer, cookies, match, signal, open = openPublic }) {
  if (active >= 6 || signal.aborted) return [];
  active++;
  let context;
  try {
    browser ||= chromium.launch({
      executablePath: process.env.ANIME_CHROMIUM_PATH || '/usr/bin/chromium',
      timeout: 5000,
      proxy: { server: 'http://127.0.0.1:1', bypass: '<-loopback>' },
      args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']
    }).then(instance => {
      instance.once('disconnected', () => { browser = null; });
      return instance;
    }).catch(error => { browser = null; throw error; });
    const instance = await browser;
    context = await instance.newContext({ userAgent, serviceWorkers: 'block', acceptDownloads: false });
    const videos = new Map();
    let requests = 0;
    let received = 0;
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(5500)]);
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', async route => {
      const request = route.request();
      const url = request.url();
      try {
        if (timeout.aborted || request.method() !== 'GET' || ++requests > 35 ||
          !['document', 'script', 'fetch', 'xhr', 'media'].includes(request.resourceType())) return await route.abort();
        const headers = request.headers();
        const media = match(url);
        if (media) {
          videos.set(media, { referer: headers.referer || referer });
          return await route.abort();
        }
        const upstream = await open(url, {
          'User-Agent': userAgent,
          ...(headers.referer && { Referer: headers.referer }),
          ...(headers.origin && { Origin: headers.origin }),
          ...(cookies && new URL(url).origin === new URL(target).origin && { Cookie: cookies })
        }, { signal: timeout, allowHttp: true });
        const response = upstream.response;
        const redirectedMedia = match(upstream.url);
        if (redirectedMedia) {
          videos.set(redirectedMedia, { referer: headers.referer || referer });
          response.destroy();
          return await route.abort();
        }
        if (upstream.url !== url) {
          response.destroy();
          return await route.fulfill({ status: 302, headers: { location: upstream.url } });
        }
        const type = response.headers['content-type'] || 'application/octet-stream';
        if (/^(video|audio)\//i.test(type) || /mpegurl/i.test(type)) {
          if (response.statusCode >= 200 && response.statusCode < 300 &&
              url.startsWith('https://') && !/\.(?:ts|m4s)(?:[?#]|$)/i.test(url)) {
            videos.set(url, { referer: headers.referer || referer, ...(/mpegurl/i.test(type) && { type: 'hls' }) });
          }
          response.destroy();
          return await route.abort();
        }
        const chunks = [];
        for await (const chunk of response) {
          received += chunk.length;
          if (received > 6 * 1024 * 1024) {
            response.destroy();
            return await route.abort();
          }
          chunks.push(chunk);
        }
        const forwarded = { 'content-type': type };
        for (const name of ['access-control-allow-origin', 'access-control-allow-credentials']) {
          if (response.headers[name]) forwarded[name] = response.headers[name];
        }
        await route.fulfill({ status: response.statusCode, headers: forwarded, body: Buffer.concat(chunks) });
      } catch {
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage();
    await page.goto(target, { referer, waitUntil: 'domcontentloaded', timeout: 4200 }).catch(() => {});
    const deadline = Date.now() + 3200;
    while (!timeout.aborted && !videos.size && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return [...videos].map(([url, metadata]) => ({ url, ...metadata }));
  } finally {
    try { await context?.close(); } finally { active--; }
  }
}

module.exports = { captureMedia };
