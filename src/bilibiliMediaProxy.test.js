'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const test = require('node:test');

const {
  clearBilibiliMedia,
  createBilibiliMediaPayload,
  getBilibiliStreamExpiry,
  lookupBilibiliStream,
  registerBilibiliStream,
  selectBrowserFormats
} = require('./bilibiliMedia');
const {
  createBilibiliMediaProxyHandler,
  isPublicIpAddress,
  isValidSingleRangeHeader,
  validateUpstreamUrl
} = require('./bilibiliMediaProxy');

const TRACK_ID = 'a1b2c3d4e5f60718293a4b5c';
const SOURCE_PAGE_URL = 'https://www.bilibili.com/video/BV1234567890';
const TEST_STREAM_VERSION = '1700000000000-1';

function getStreamVersion(proxyUrl) {
  return new URL(proxyUrl, 'https://haven.example.test').searchParams.get('v');
}

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

  setTimeout() {}

  getBody() {
    return Buffer.concat(this.bodyChunks).toString('utf8');
  }
}

function createTestRequest(overrides = {}) {
  const request = new EventEmitter();
  request.method = overrides.method || 'GET';
  request.headers = overrides.headers || {};
  request.params = {
    trackId: overrides.trackId || TRACK_ID,
    mediaKind: overrides.mediaKind || 'video'
  };
  request.query = { v: overrides.streamVersion || TEST_STREAM_VERSION };
  request.setTimeout = () => {};
  return request;
}

function createUpstreamResponse(statusCode, headers = {}, body = '') {
  const response = Readable.from(body ? [Buffer.from(body)] : []);
  response.statusCode = statusCode;
  response.headers = headers;
  return response;
}

function createMockRequestFactory(responses, capturedRequests) {
  return (target, options, callback) => {
    const request = new EventEmitter();
    request.destroyedByProxy = false;
    request.setTimeout = (_timeoutMs, timeoutCallback) => {
      request.timeoutCallback = timeoutCallback;
    };
    request.destroy = error => {
      request.destroyedByProxy = true;
      if (error) queueMicrotask(() => request.emit('error', error));
    };
    request.end = () => {
      const upstreamResponse = responses.shift();
      if (upstreamResponse) queueMicrotask(() => callback(upstreamResponse));
    };
    capturedRequests.push({ target, options, request });
    return request;
  };
}

function createActiveLookup(overrides = {}) {
  return {
    status: 'active',
    resource: {
      trackId: TRACK_ID,
      mediaKind: 'video',
      upstreamUrl: 'https://media.example.test/video.m4s',
      upstreamHostname: 'media.example.test',
      contentType: 'video/mp4',
      expiresAt: Date.now() + 60000,
      ...overrides
    }
  };
}

const resolvePublicTestAddress = async () => [{ address: '93.184.216.34', family: 4 }];

test('format selection follows requested room quality and reports available heights', () => {
  const previousMaximumHeight = process.env.BILIBILI_VIDEO_MAX_HEIGHT;
  process.env.BILIBILI_VIDEO_MAX_HEIGHT = '1080';
  try {
    const formatInfo = {
      duration: 120,
      formats: [
        { url: 'https://video.example.test/240.mp4', ext: 'mp4', vcodec: 'avc1.640015', acodec: 'none', height: 240, width: 426, fps: 30, tbr: 300 },
        { url: 'https://video.example.test/360.mp4', ext: 'mp4', vcodec: 'avc1.64001e', acodec: 'none', height: 360, width: 640, fps: 30, tbr: 500 },
        { url: 'https://video.example.test/720.mp4', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 720, width: 1280, fps: 30, tbr: 1500 },
        { url: 'https://video.example.test/720-heavy.mp4', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 720, width: 1280, fps: 60, tbr: 3500 },
        { url: 'https://video.example.test/1080.mp4', ext: 'mp4', vcodec: 'avc1.640032', acodec: 'none', height: 1080, width: 1920, fps: 30, tbr: 3000 },
        { url: 'https://audio.example.test/audio.m4a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 192, tbr: 192 }
      ]
    };

    const mediumQuality = selectBrowserFormats(formatInfo, 480);
    const highQuality = selectBrowserFormats(formatInfo, 1080);
    assert.equal(mediumQuality.selectedVideoHeight, 360);
    assert.equal(mediumQuality.requestedVideoHeight, 480);
    assert.deepEqual(mediumQuality.availableVideoHeights, [240, 360, 720, 1080]);
    assert.equal(highQuality.selectedVideoHeight, 1080);
    assert.equal(selectBrowserFormats(formatInfo, 360).selectedVideoHeight, 360);
    assert.equal(selectBrowserFormats(formatInfo, 720).videoUrl.includes('720-heavy'), false);
  } finally {
    if (previousMaximumHeight === undefined) delete process.env.BILIBILI_VIDEO_MAX_HEIGHT;
    else process.env.BILIBILI_VIDEO_MAX_HEIGHT = previousMaximumHeight;
  }
});

test('track registry returns simple same-origin video and audio stream paths', () => {
  const expiresAt = Date.now() + 60000;
  const media = registerBilibiliStream(TRACK_ID, SOURCE_PAGE_URL, {
    videoUrl: 'https://video.example.test/video.m4s',
    audioUrl: 'https://audio.example.test/audio.m4s',
    videoMime: 'video/mp4',
    audioMime: 'audio/mp4',
    width: 1920,
    height: 1080,
    duration: 120
  }, expiresAt);

  assert.match(media.videoUrl, new RegExp(`^/api/bilibili-stream/${TRACK_ID}/video\\?v=\\d{13}-\\d+$`));
  assert.match(media.audioUrl, new RegExp(`^/api/bilibili-stream/${TRACK_ID}/audio\\?v=\\d{13}-\\d+$`));
  const initialStreamVersion = getStreamVersion(media.videoUrl);
  assert.equal(lookupBilibiliStream(TRACK_ID, 'video', initialStreamVersion).resource.upstreamHostname, 'video.example.test');
  assert.equal(lookupBilibiliStream(TRACK_ID, 'audio', initialStreamVersion).resource.upstreamHostname, 'audio.example.test');
  assert.equal(JSON.stringify(createBilibiliMediaPayload(media)).includes('example.test'), false);

  const hlsPayload = createBilibiliMediaPayload({
    ...media,
    hlsUrl: `/api/bilibili-hls/${TRACK_ID}/1700000000000-a1b2c3d4e5f60718/index.m3u8`
  });
  assert.equal(hlsPayload.transport, 'hls-fmp4');
  assert.match(hlsPayload.hlsUrl, /^\/api\/bilibili-hls\//);

  const refreshedMedia = registerBilibiliStream(TRACK_ID, SOURCE_PAGE_URL, {
    videoUrl: 'https://video.example.test/refreshed-video.m4s',
    audioUrl: 'https://audio.example.test/refreshed-audio.m4s',
    videoMime: 'video/mp4',
    audioMime: 'audio/mp4'
  }, expiresAt);
  assert.notEqual(refreshedMedia.videoUrl, media.videoUrl);
  const refreshedStreamVersion = getStreamVersion(refreshedMedia.videoUrl);
  assert.equal(lookupBilibiliStream(TRACK_ID, 'video', refreshedStreamVersion).resource.upstreamUrl.includes('refreshed-video'), true);
  assert.equal(lookupBilibiliStream(TRACK_ID, 'video', initialStreamVersion).resource.upstreamUrl.includes('refreshed-video'), false);

  clearBilibiliMedia(SOURCE_PAGE_URL, TRACK_ID);
  assert.equal(lookupBilibiliStream(TRACK_ID, 'video', initialStreamVersion).status, 'missing');
});

test('track registry rejects user-controlled and malformed identifiers', () => {
  assert.throws(() => registerBilibiliStream('not-a-track', SOURCE_PAGE_URL, {
    videoUrl: 'https://video.example.test/video.m4s',
    audioUrl: 'https://audio.example.test/audio.m4s'
  }, Date.now() + 60000), /track ID/);
  assert.equal(lookupBilibiliStream('../private', 'video', TEST_STREAM_VERSION).status, 'missing');
  assert.equal(lookupBilibiliStream(TRACK_ID, 'other', TEST_STREAM_VERSION).status, 'missing');
  assert.equal(lookupBilibiliStream(TRACK_ID, 'video', 'invalid-version').status, 'missing');
});

test('stream expiry stops new requests before the upstream signature expires', () => {
  const createdAt = Date.now();
  const expiresAt = createdAt + 60000;
  assert.equal(getBilibiliStreamExpiry({ createdAt, expiresAt }), expiresAt - 5000);
});

test('public IP validation blocks private and reserved networks', () => {
  assert.equal(isPublicIpAddress('93.184.216.34'), true);
  assert.equal(isPublicIpAddress('127.0.0.1'), false);
  assert.equal(isPublicIpAddress('10.0.0.1'), false);
  assert.equal(isPublicIpAddress('169.254.169.254'), false);
  assert.equal(isPublicIpAddress('::1'), false);
  assert.equal(isPublicIpAddress('fd00::1'), false);
  assert.equal(isPublicIpAddress('::ffff:7f00:1'), false);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
});

test('single Range validation rejects multiple and reversed ranges', () => {
  assert.equal(isValidSingleRangeHeader(undefined), true);
  assert.equal(isValidSingleRangeHeader('bytes=0-1023'), true);
  assert.equal(isValidSingleRangeHeader('bytes=1024-'), true);
  assert.equal(isValidSingleRangeHeader('bytes=-1024'), true);
  assert.equal(isValidSingleRangeHeader('bytes=10-1'), false);
  assert.equal(isValidSingleRangeHeader('bytes=0-1,5-10'), false);
});

test('upstream validation requires HTTPS, the registered host, and public DNS', async () => {
  await assert.rejects(
    validateUpstreamUrl('http://media.example.test/video', 'media.example.test', resolvePublicTestAddress),
    /unsafe/
  );
  await assert.rejects(
    validateUpstreamUrl('https://other.example.test/video', 'media.example.test', resolvePublicTestAddress),
    /changed unexpectedly/
  );
  await assert.rejects(
    validateUpstreamUrl('https://private.example.test/video', 'private.example.test', async () => [{ address: '127.0.0.1', family: 4 }]),
    /private address/
  );
  const dualStackTarget = await validateUpstreamUrl(
    'https://media.example.test/video',
    'media.example.test',
    async () => [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '93.184.216.34', family: 4 }
    ]
  );
  assert.equal(dualStackTarget.resolvedAddress.address, '93.184.216.34');
});

test('proxy injects Bilibili headers and streams a 206 Range response', async () => {
  const capturedRequests = [];
  const upstreamResponses = [createUpstreamResponse(206, {
    'content-type': 'application/octet-stream',
    'content-length': '5',
    'content-range': 'bytes 10-14/100',
    'accept-ranges': 'bytes'
  }, 'media')];
  const handler = createBilibiliMediaProxyHandler({
    lookupResource: () => createActiveLookup({
      sourcePageUrl: SOURCE_PAGE_URL,
      requestHeaders: {
        Cookie: 'SESSDATA=server-only-cookie',
        Referer: SOURCE_PAGE_URL,
        'User-Agent': 'yt-dlp-compatible-agent'
      }
    }),
    resolveHostname: resolvePublicTestAddress,
    requestFactory: createMockRequestFactory(upstreamResponses, capturedRequests)
  });
  const request = createTestRequest({ headers: { range: 'bytes=10-14' } });
  const response = new TestResponse();
  const finished = once(response, 'finish');

  await handler(request, response);
  await finished;

  assert.equal(response.statusCode, 206);
  assert.equal(response.getHeader('content-range'), 'bytes 10-14/100');
  assert.equal(response.getHeader('content-type'), 'video/mp4');
  assert.equal(response.getBody(), 'media');
  assert.equal(capturedRequests[0].options.headers.Range, 'bytes=10-14');
  assert.equal(capturedRequests[0].options.headers.Referer, SOURCE_PAGE_URL);
  assert.equal(capturedRequests[0].options.headers.Cookie, 'SESSDATA=server-only-cookie');
  assert.equal(capturedRequests[0].options.headers['User-Agent'], 'yt-dlp-compatible-agent');
});

test('proxy preserves 416 and HEAD responses without a body', async () => {
  for (const scenario of [
    { method: 'GET', statusCode: 416, headers: { range: 'bytes=1000-' } },
    { method: 'HEAD', statusCode: 200, headers: {} }
  ]) {
    const capturedRequests = [];
    const upstreamResponses = [createUpstreamResponse(scenario.statusCode, {
      'content-range': scenario.statusCode === 416 ? 'bytes */100' : undefined,
      'content-length': '100'
    }, 'must-not-be-forwarded')];
    const handler = createBilibiliMediaProxyHandler({
      lookupResource: () => createActiveLookup(),
      resolveHostname: resolvePublicTestAddress,
      requestFactory: createMockRequestFactory(upstreamResponses, capturedRequests)
    });
    const request = createTestRequest({ method: scenario.method, headers: scenario.headers });
    const response = new TestResponse();
    const finished = once(response, 'finish');

    await handler(request, response);
    await finished;

    assert.equal(response.statusCode, scenario.statusCode);
    assert.equal(response.getBody(), '');
  }
});

test('proxy returns 404, 410, and 416 without contacting upstream', async () => {
  for (const scenario of [
    { lookup: { status: 'missing', resource: null }, headers: {}, expected: 404 },
    { lookup: { status: 'expired', resource: null }, headers: {}, expected: 410 },
    { lookup: createActiveLookup(), headers: { range: 'bytes=0-1,4-5' }, expected: 416 }
  ]) {
    const capturedRequests = [];
    const handler = createBilibiliMediaProxyHandler({
      lookupResource: () => scenario.lookup,
      resolveHostname: resolvePublicTestAddress,
      requestFactory: createMockRequestFactory([], capturedRequests)
    });
    const request = createTestRequest({ headers: scenario.headers });
    const response = new TestResponse();
    const finished = once(response, 'finish');

    await handler(request, response);
    await finished;

    assert.equal(response.statusCode, scenario.expected);
    assert.equal(capturedRequests.length, 0);
  }
});

test('proxy rejects a redirect to a private address', async () => {
  const capturedRequests = [];
  const upstreamResponses = [createUpstreamResponse(302, { location: 'https://127.0.0.1/private' })];
  const handler = createBilibiliMediaProxyHandler({
    lookupResource: () => createActiveLookup(),
    resolveHostname: resolvePublicTestAddress,
    requestFactory: createMockRequestFactory(upstreamResponses, capturedRequests)
  });
  const request = createTestRequest();
  const response = new TestResponse();
  const finished = once(response, 'finish');

  await handler(request, response);
  await finished;

  assert.equal(response.statusCode, 502);
  assert.equal(capturedRequests.length, 1);
});

test('proxy rejects a full-file response when the browser requested a Range', async () => {
  const capturedRequests = [];
  const upstreamResponses = [createUpstreamResponse(200, {
    'content-length': '1000',
    'content-type': 'video/mp4'
  }, 'must-not-be-forwarded')];
  const handler = createBilibiliMediaProxyHandler({
    lookupResource: () => createActiveLookup(),
    resolveHostname: resolvePublicTestAddress,
    requestFactory: createMockRequestFactory(upstreamResponses, capturedRequests)
  });
  const request = createTestRequest({ headers: { range: 'bytes=10-14' } });
  const response = new TestResponse();
  const finished = once(response, 'finish');

  await handler(request, response);
  await finished;

  assert.equal(response.statusCode, 502);
  assert.equal(response.getHeader('x-haven-bilibili-status'), 'range-not-honored');
  assert.equal(response.getBody(), '');
});

test('proxy reserves capacity for audio when video requests are saturated', async () => {
  const capturedRequests = [];
  const handler = createBilibiliMediaProxyHandler({
    lookupResource: (_trackId, mediaKind) => createActiveLookup({
      mediaKind,
      upstreamUrl: `https://media.example.test/${mediaKind}.m4s`,
      contentType: `${mediaKind}/mp4`
    }),
    resolveHostname: resolvePublicTestAddress,
    requestFactory: createMockRequestFactory([], capturedRequests),
    maxConcurrentRequests: 2,
    reservedAudioRequests: 1
  });

  const activeVideoResponse = new TestResponse();
  await handler(createTestRequest({ mediaKind: 'video' }), activeVideoResponse);

  const rejectedVideoResponse = new TestResponse();
  const rejectedVideoFinished = once(rejectedVideoResponse, 'finish');
  await handler(createTestRequest({ mediaKind: 'video' }), rejectedVideoResponse);
  await rejectedVideoFinished;

  const activeAudioResponse = new TestResponse();
  await handler(createTestRequest({ mediaKind: 'audio' }), activeAudioResponse);

  assert.equal(rejectedVideoResponse.statusCode, 503);
  assert.equal(rejectedVideoResponse.getHeader('x-haven-bilibili-status'), 'video-capacity-reserved-for-audio');
  assert.equal(capturedRequests.length, 2);

  activeVideoResponse.emit('close');
  activeAudioResponse.emit('close');
});

test('proxy destroys the upstream request when the browser disconnects', async () => {
  const capturedRequests = [];
  const handler = createBilibiliMediaProxyHandler({
    lookupResource: () => createActiveLookup(),
    resolveHostname: resolvePublicTestAddress,
    requestFactory: createMockRequestFactory([], capturedRequests)
  });
  const request = createTestRequest();
  const response = new TestResponse();

  await handler(request, response);
  response.emit('close');

  assert.equal(capturedRequests[0].request.destroyedByProxy, true);
});
