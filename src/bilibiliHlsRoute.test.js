'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter, once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createBilibiliHlsAssetHandler, parseByteRange } = require('./bilibiliHlsRoute');

class TestResponse extends PassThrough {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = new Map();
    this.bodyChunks = [];
    this.on('data', chunk => this.bodyChunks.push(Buffer.from(chunk)));
  }

  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name) {
    return this.headers.get(name.toLowerCase());
  }

  getBody() {
    return Buffer.concat(this.bodyChunks).toString('utf8');
  }
}

function createRequest(assetName, overrides = {}) {
  const request = new EventEmitter();
  request.method = overrides.method || 'GET';
  request.headers = overrides.headers || {};
  request.params = {
    trackId: 'a1b2c3d4e5f60718293a4b5c',
    sessionVersion: '1700000000000-a1b2c3d4e5f60718',
    assetName
  };
  return request;
}

test('byte Range parsing supports normal, open, and suffix ranges', () => {
  assert.deepEqual(parseByteRange('bytes=2-5', 10), { startByte: 2, endByte: 5 });
  assert.deepEqual(parseByteRange('bytes=7-', 10), { startByte: 7, endByte: 9 });
  assert.deepEqual(parseByteRange('bytes=-3', 10), { startByte: 7, endByte: 9 });
  assert.equal(parseByteRange('bytes=10-11', 10), false);
  assert.equal(parseByteRange('bytes=0-1,4-5', 10), false);
});

test('HLS route serves playlists without caching and segments with immutable caching', async () => {
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-hls-route-'));
  const playlistPath = path.join(temporaryDirectory, 'index.m3u8');
  const segmentPath = path.join(temporaryDirectory, 'segment-000000.m4s');
  await fs.promises.writeFile(playlistPath, '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n');
  await fs.promises.writeFile(segmentPath, '0123456789');

  try {
    const handler = createBilibiliHlsAssetHandler({
      lookupAsset: (_trackId, _sessionVersion, assetName) => ({
        status: 'active',
        asset: {
          path: assetName === 'index.m3u8' ? playlistPath : segmentPath,
          assetName,
          contentType: assetName === 'index.m3u8'
            ? 'application/vnd.apple.mpegurl'
            : 'video/iso.segment'
        }
      })
    });

    const playlistResponse = new TestResponse();
    const playlistFinished = once(playlistResponse, 'finish');
    await handler(createRequest('index.m3u8'), playlistResponse);
    await playlistFinished;
    assert.equal(playlistResponse.statusCode, 200);
    assert.equal(playlistResponse.getHeader('content-type'), 'application/vnd.apple.mpegurl');
    assert.equal(playlistResponse.getHeader('cache-control'), 'private, no-store');
    assert.match(playlistResponse.getBody(), /#EXTM3U/);

    const segmentResponse = new TestResponse();
    const segmentFinished = once(segmentResponse, 'finish');
    await handler(createRequest('segment-000000.m4s', { headers: { range: 'bytes=2-5' } }), segmentResponse);
    await segmentFinished;
    assert.equal(segmentResponse.statusCode, 206);
    assert.equal(segmentResponse.getHeader('content-range'), 'bytes 2-5/10');
    assert.equal(segmentResponse.getHeader('cache-control'), 'private, max-age=3600, immutable');
    assert.equal(segmentResponse.getBody(), '2345');
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('HLS route preserves missing and expired session status', async () => {
  for (const scenario of [
    { lookupStatus: 'missing', expectedStatus: 404 },
    { lookupStatus: 'expired', expectedStatus: 410 }
  ]) {
    const handler = createBilibiliHlsAssetHandler({
      lookupAsset: () => ({ status: scenario.lookupStatus, asset: null })
    });
    const response = new TestResponse();
    const finished = once(response, 'finish');
    await handler(createRequest('index.m3u8'), response);
    await finished;
    assert.equal(response.statusCode, scenario.expectedStatus);
  }
});
