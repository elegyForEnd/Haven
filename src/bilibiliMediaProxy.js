'use strict';

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

module.exports = {
  createBilibiliMediaProxyHandler,
  isPublicIpAddress,
  isValidSingleRangeHeader,
  validateUpstreamUrl
};
