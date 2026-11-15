'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const dns = require('node:dns').promises;
const net = require('node:net');

const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked4.addSubnet(ip, prefix, 'ipv4');
for (const [ip, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['::ffff:0:0', 96]]) blocked6.addSubnet(ip, prefix, 'ipv6');
function isPublicAddress(ip) {
  const type = net.isIP(ip); return type === 4 ? !blocked4.check(ip, 'ipv4') : type === 6 && !blocked6.check(ip, 'ipv6');
}

async function openPublic(url, headers, { hops = 0, allowHttp = false, signal } = {}) {
  if (hops > 5) throw new Error('播放源重定向过多');
  const u = new URL(url);
  if (!(u.protocol === 'https:' || (allowHttp && u.protocol === 'http:')) || u.username || u.password) {
    throw new Error('不支持的播放地址');
  }
  const addresses = await dns.lookup(u.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('播放源地址不可用');
  const addr = addresses[0];
  const transport = u.protocol === 'https:' ? https : http;
  const response = await new Promise((resolve, reject) => {
    const req = transport.get(u, { headers, signal, lookup: (_host, opts, cb) => {
      if (opts?.all) cb(null, [addr]); else cb(null, addr.address, addr.family);
    } }, resolve);
    req.setTimeout(20000, () => req.destroy(new Error('播放源连接超时')));
    req.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
    response.destroy();
    const next = new URL(response.headers.location, u);
    const nextHeaders = next.origin === u.origin ? headers : Object.fromEntries(
      Object.entries(headers).filter(([name]) => !/^(cookie|authorization|x-emby-token)$/i.test(name))
    );
    return openPublic(next.href, nextHeaders, { hops: hops + 1, allowHttp, signal });
  }
  return { response, url: u.href };
}

// Only random capabilities issued from resolver results can reach this relay.
// DNS is validated and pinned on every hop, including HLS segment/key requests.
function createMediaRelay() {
  const entries = new Map();
  function issue(url, referer = '', userAgent = '', upstreamHeaders = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('无效的播放地址');
    if (entries.size > 10000) {
      for (const [key, value] of entries) if (value.until < Date.now()) entries.delete(key);
      if (entries.size > 10000) entries.delete(entries.keys().next().value);
    }
    const key = crypto.randomBytes(20).toString('hex');
    entries.set(key, { url: parsed.href, referer, userAgent, upstreamHeaders, until: Date.now() + 2 * 3600000 });
    return `/api/anime/media/${key}`;
  }
  function rewritePlaylist(text, base, referer, userAgent, upstreamHeaders, credentialUrl = base) {
    const origin = new URL(credentialUrl).origin;
    const issueChild = value => {
      const url = new URL(value, base);
      return issue(url.href, referer, userAgent, url.origin === origin ? upstreamHeaders : undefined);
    };
    return text.split(/\r?\n/).map(line => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${issueChild(uri)}"`);
      return issueChild(line.trim());
    }).join('\n');
  }
  async function handle(req, res) {
    const entry = entries.get(req.params.key);
    if (!entry || entry.until < Date.now()) return res.status(410).json({ error: '播放地址已过期，请重新选择这一话' });
    try {
      const headers = { 'User-Agent': entry.userAgent || 'Mozilla/5.0 Ciacord/1.0', ...entry.upstreamHeaders };
      if (entry.referer) headers.Referer = entry.referer;
      if (req.headers.range && /^bytes=\d*-\d*$/.test(req.headers.range)) headers.Range = req.headers.range;
      const { response: upstream, url } = await openPublic(entry.url, headers);
      if (res.destroyed) { upstream.destroy(); return; }
      if (upstream.statusCode >= 400) { upstream.resume(); return res.status(upstream.statusCode).end(); }
      res.set('Cache-Control', 'private, no-store');
      const hls = /\.m3u8(?:\?|$)/i.test(url) || /mpegurl/i.test(upstream.headers['content-type'] || '');
      if (hls) {
        let body = ''; let bytes = 0;
        upstream.setEncoding('utf8');
        for await (const part of upstream) {
          bytes += Buffer.byteLength(part); if (bytes > 2 * 1024 * 1024) { upstream.destroy(); throw new Error('播放列表过大'); }
          body += part;
        }
        if (!body.trimStart().startsWith('#EXTM3U')) throw new Error('无效的播放列表');
        return res.type('application/vnd.apple.mpegurl').send(
          rewritePlaylist(body, url, entry.referer, entry.userAgent, entry.upstreamHeaders, entry.url)
        );
      }
      // Never turn an upstream HTML error page into same-origin executable HTML.
      const type = upstream.headers['content-type'] || '';
      res.type(/^(?:video|audio)\//i.test(type) || /^application\/(?:octet-stream|mp4)(?:;|$)/i.test(type) ? type : 'application/octet-stream');
      res.set('X-Content-Type-Options', 'nosniff');
      for (const name of ['content-length', 'content-range', 'accept-ranges']) if (upstream.headers[name]) res.set(name, upstream.headers[name]);
      res.status(upstream.statusCode);
      res.on('close', () => upstream.destroy());
      upstream.on('error', () => res.destroy());
      upstream.pipe(res);
    } catch {
      if (!res.headersSent) res.status(502).json({ error: '播放源连接失败，请切换线路' });
      else res.destroy();
    }
  }
  return { issue, handle, rewritePlaylist };
}
module.exports = { createMediaRelay, isPublicAddress, openPublic };
