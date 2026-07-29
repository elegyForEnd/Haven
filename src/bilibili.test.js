'use strict';

const bilibiliTestFs = require('node:fs');
const bilibiliTestOs = require('node:os');
const bilibiliTestPath = require('node:path');

process.env.JWT_SECRET = 'test-only-bilibili-credential-encryption-secret';
process.env.HAVEN_DATA_DIR = bilibiliTestFs.mkdtempSync(
  bilibiliTestPath.join(bilibiliTestOs.tmpdir(), 'haven-bilibili-tests-')
);
{
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createWbiMixinKey,
  normalizeBilibiliPlaybackMode,
  normalizeDashFormats,
  parseCanonicalVideoUrl,
  resolveBilibiliPlaybackInfo,
  signWbiParameters
} = require('./bilibili');
const {
  mapQrLoginState,
  splitCombinedSetCookieHeader
} = require('./bilibili');

function createJsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('Bilibili playback mode accepts HLS and official player values only', () => {
  assert.equal(normalizeBilibiliPlaybackMode('hls'), 'hls');
  assert.equal(normalizeBilibiliPlaybackMode('official'), 'official');
  assert.equal(normalizeBilibiliPlaybackMode('invalid'), 'hls');
  assert.equal(normalizeBilibiliPlaybackMode(undefined, 'official'), 'official');
});

test('WBI signing produces a deterministic sorted signature', () => {
  const mixinKey = createWbiMixinKey(
    '7cd084941338484aae1ad9425b84077c',
    '4932caff0ff746eab6f01bf08b70ac45'
  );
  assert.equal(mixinKey, 'ea1db124af3c7062474693fa704f4ff8');

  const signedQuery = signWbiParameters({
    foo: 'one one four',
    bar: '514',
    baz: '1919810'
  }, mixinKey, 1702204169);
  assert.equal(
    signedQuery,
    'bar=514&baz=1919810&foo=one%20one%20four&wts=1702204169&w_rid=c4e16b82e758eadda1303cd7b687a727'
  );
});

test('canonical Bilibili URLs preserve the selected page', () => {
  assert.deepEqual(
    parseCanonicalVideoUrl('https://www.bilibili.com/video/BV1234567890?p=3'),
    { bvid: 'BV1234567890', page: 3 }
  );
  assert.throws(
    () => parseCanonicalVideoUrl('https://example.test/video/BV1234567890'),
    /canonical Bilibili/
  );
  assert.throws(
    () => parseCanonicalVideoUrl('https://www.bilibili.com/video/BV1234567890?p=2abc'),
    /page parameter/
  );
});

test('playback resolution rejects a requested page that does not exist', async () => {
  const fetchImpl = async url => {
    const requestUrl = new URL(url);
    assert.equal(requestUrl.pathname, '/x/web-interface/view');
    return createJsonResponse({
      code: 0,
      data: {
        title: 'One-page video',
        pages: [{ page: 1, cid: 12345, part: 'Part one' }]
      }
    });
  };
  await assert.rejects(
    resolveBilibiliPlaybackInfo(
      'https://www.bilibili.com/video/BV1234567890?p=2',
      {
        fetchImpl,
        requestCredential: { cookieHeader: '', credentialVersion: 'anonymous' }
      }
    ),
    /page 2 does not exist/
  );
});

test('DASH normalization exposes H.264 and AAC candidates with server-only request headers', () => {
  const normalized = normalizeDashFormats({
    timelength: 120000,
    dash: {
      video: [{
        id: 64,
        baseUrl: 'https://video.example.test/720.m4s',
        codecs: 'avc1.640028',
        width: 1280,
        height: 720,
        frameRate: '30000/1001',
        bandwidth: 1500000
      }],
      audio: [{
        id: 30280,
        baseUrl: 'https://audio.example.test/audio.m4s',
        codecs: 'mp4a.40.2',
        bandwidth: 192000
      }]
    }
  }, { Cookie: 'SESSDATA=secret', Referer: 'https://www.bilibili.com/' });

  assert.equal(normalized.duration, 120);
  assert.equal(normalized.formats[0].vcodec, 'avc1.640028');
  assert.equal(normalized.formats[0].fps > 29, true);
  assert.equal(normalized.formats[1].acodec, 'mp4a.40.2');
  assert.equal(normalized.formats[1].http_headers.Cookie, 'SESSDATA=secret');
});

test('playback resolution calls view, nav, and signed playurl APIs with the server credential', async () => {
  const capturedRequests = [];
  const fetchImpl = async (url, options) => {
    const requestUrl = new URL(url);
    capturedRequests.push({ requestUrl, options });
    if (requestUrl.pathname === '/x/web-interface/view') {
      return createJsonResponse({
        code: 0,
        data: {
          title: 'Test video',
          pages: [{ page: 1, cid: 12345, part: 'Part one' }]
        }
      });
    }
    if (requestUrl.pathname === '/x/web-interface/nav') {
      return createJsonResponse({
        code: 0,
        data: {
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
          }
        }
      });
    }
    if (requestUrl.pathname === '/x/player/wbi/playurl') {
      return createJsonResponse({
        code: 0,
        data: {
          timelength: 90000,
          dash: {
            video: [{
              id: 16,
              baseUrl: 'https://video.example.test/360.m4s?deadline=4102444800',
              codecs: 'avc1.64001e',
              width: 640,
              height: 360,
              frameRate: '30',
              bandwidth: 500000
            }],
            audio: [{
              id: 30280,
              baseUrl: 'https://audio.example.test/audio.m4s?deadline=4102444800',
              codecs: 'mp4a.40.2',
              bandwidth: 192000
            }]
          }
        }
      });
    }
    throw new Error(`Unexpected Bilibili API request: ${requestUrl.pathname}`);
  };

  const playbackInfo = await resolveBilibiliPlaybackInfo(
    'https://www.bilibili.com/video/BV1234567890',
    {
      fetchImpl,
      requestCredential: {
        cookieHeader: 'SESSDATA=server-secret',
        credentialVersion: 'test-credential'
      }
    }
  );

  assert.equal(playbackInfo.cid, 12345);
  assert.equal(playbackInfo.formats.length, 2);
  assert.equal(capturedRequests.length, 3);
  assert.equal(capturedRequests.every(request => request.options.headers.Cookie === 'SESSDATA=server-secret'), true);
  assert.equal(playbackInfo.formats.every(format => !format.http_headers.Cookie), true);
  const playbackRequest = capturedRequests.find(request => request.requestUrl.pathname === '/x/player/wbi/playurl');
  assert.equal(playbackRequest.requestUrl.searchParams.get('cid'), '12345');
  assert.equal(playbackRequest.requestUrl.searchParams.get('qn'), '127');
  assert.match(playbackRequest.requestUrl.searchParams.get('w_rid'), /^[a-f0-9]{32}$/);
});

test('QR helpers preserve Expires dates and map Bilibili states', () => {
  const setCookieHeader = 'buvid3=device; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, SESSDATA=session-value; Path=/; HttpOnly';
  const splitHeaders = splitCombinedSetCookieHeader(setCookieHeader);
  assert.equal(splitHeaders.length, 2);
  assert.equal(splitHeaders[0].includes('Wed, 21 Oct 2026'), true);
  assert.equal(mapQrLoginState(86101), 'not_scanned');
  assert.equal(mapQrLoginState(86090), 'scanned_waiting_confirmation');
  assert.equal(mapQrLoginState(86038), 'expired');
  assert.equal(mapQrLoginState(0), 'success');
});
}

{
const assert = require('node:assert/strict');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-bilibili-credential-encryption-secret';

const {
  createCookieHeader,
  decryptCredential,
  encryptCredential,
  sanitizeCookieCollection
} = require('./bilibili');

test('Bilibili credentials use authenticated encryption and reject tampering', () => {
  const credential = {
    cookies: {
      SESSDATA: 'plain-session-secret',
      bili_jct: 'plain-csrf-secret',
      DedeUserID: '123456'
    },
    uid: '123456',
    displayName: 'Test account',
    avatarUrl: 'https://i0.hdslb.com/test-avatar.png'
  };
  const encryptedCredential = encryptCredential(credential);
  assert.equal(encryptedCredential.includes('plain-session-secret'), false);
  assert.equal(encryptedCredential.includes('plain-csrf-secret'), false);
  assert.deepEqual(decryptCredential(encryptedCredential), credential);

  const tamperedCredential = `${encryptedCredential.slice(0, -1)}${encryptedCredential.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(decryptCredential(tamperedCredential), null);
});

test('Bilibili Cookie serialization rejects control characters and injection delimiters', () => {
  const sanitizedCookies = sanitizeCookieCollection({
    SESSDATA: 'valid-session',
    bili_jct: 'valid-csrf',
    malicious: 'value; injected=true',
    lineBreak: 'value\r\nInjected: true',
    'invalid cookie name': 'value'
  });
  assert.deepEqual(sanitizedCookies, {
    SESSDATA: 'valid-session',
    bili_jct: 'valid-csrf'
  });
  assert.equal(
    createCookieHeader(sanitizedCookies),
    'bili_jct=valid-csrf; SESSDATA=valid-session'
  );
});
}

{
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildFfmpegArguments,
  findFfmpegBinary,
  isHlsOutputReady,
  startBilibiliHlsRemux
} = require('./bilibili');

test('ffmpeg arguments remux H.264 and AAC into fMP4 HLS without transcoding', () => {
  const outputDirectory = path.join('C:', 'haven-test', 'hls-output');
  const argumentsList = buildFfmpegArguments({
    outputDirectory,
    videoUrl: 'https://video.example.test/video.m4s',
    audioUrl: 'https://audio.example.test/audio.m4s',
    videoRequestHeaders: {
      Referer: 'https://www.bilibili.com/video/BV1234567890',
      Cookie: 'SESSDATA=server-only'
    },
    audioRequestHeaders: {
      'User-Agent': 'yt-dlp-agent'
    },
    segmentDurationSeconds: 4
  });

  assert.deepEqual(argumentsList.slice(0, 6), [
    '-nostdin', '-hide_banner', '-loglevel', 'warning', '-y', '-rw_timeout'
  ]);
  assert.equal(argumentsList.includes('-c'), true);
  assert.equal(argumentsList[argumentsList.indexOf('-c') + 1], 'copy');
  assert.equal(argumentsList[argumentsList.indexOf('-hls_segment_type') + 1], 'fmp4');
  assert.equal(argumentsList[argumentsList.indexOf('-hls_time') + 1], '4');
  assert.equal(argumentsList[argumentsList.indexOf('-hls_playlist_type') + 1], 'event');
  assert.equal(argumentsList[argumentsList.indexOf('-reconnect') + 1], '1');
  assert.equal(argumentsList[argumentsList.indexOf('-reconnect_streamed') + 1], '1');
  assert.equal(argumentsList.some(argument => argument.includes('SESSDATA=server-only')), false);
  assert.equal(argumentsList.at(-1), path.join(outputDirectory, 'index.m3u8'));
});

test('HLS output is ready only after playlist, init segment, and media segment exist', async () => {
  const outputDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-hls-ready-'));
  try {
    assert.equal(await isHlsOutputReady(outputDirectory), false);
    await fs.promises.writeFile(path.join(outputDirectory, 'index.m3u8'), '#EXTM3U\n');
    await fs.promises.writeFile(path.join(outputDirectory, 'init.mp4'), 'init');
    assert.equal(await isHlsOutputReady(outputDirectory), false);
    await fs.promises.writeFile(path.join(outputDirectory, 'segment-000000.m4s'), 'segment');
    assert.equal(await isHlsOutputReady(outputDirectory), true);
  } finally {
    await fs.promises.rm(outputDirectory, { recursive: true, force: true });
  }
});

test('configured ffmpeg path takes precedence over platform defaults', () => {
  const previousFfmpegPath = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = 'D:\\media-tools\\ffmpeg.exe';
  try {
    assert.equal(findFfmpegBinary(), 'D:\\media-tools\\ffmpeg.exe');
  } finally {
    if (previousFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previousFfmpegPath;
  }
});

test('remux stop force-kills ffmpeg when graceful termination does not close it', async () => {
  const outputDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-hls-stop-'));
  const sentSignals = [];
  const childProcess = new EventEmitter();
  childProcess.stderr = new EventEmitter();
  childProcess.kill = signal => {
    sentSignals.push(signal);
    if (signal === 'SIGKILL') queueMicrotask(() => childProcess.emit('close', null));
    return true;
  };
  const spawnProcess = () => childProcess;

  try {
    const remuxPromise = startBilibiliHlsRemux({
      outputDirectory,
      videoUrl: 'https://video.example.test/video.m4s',
      audioUrl: 'https://audio.example.test/audio.m4s',
      spawnProcess,
      forceKillTimeoutMs: 20
    });
    await Promise.all([
      fs.promises.writeFile(path.join(outputDirectory, 'index.m3u8'), '#EXTM3U\n'),
      fs.promises.writeFile(path.join(outputDirectory, 'init.mp4'), 'init'),
      fs.promises.writeFile(path.join(outputDirectory, 'segment-000000.m4s'), 'segment')
    ]);
    const remux = await remuxPromise;
    remux.stop();
    await remux.completion;
    assert.deepEqual(sentSignals, ['SIGTERM', 'SIGKILL']);
  } finally {
    await fs.promises.rm(outputDirectory, { recursive: true, force: true });
  }
});
}

{
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter, once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createBilibiliHlsAssetHandler, parseByteRange } = require('./bilibili');

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
}

{
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
} = require('./bilibili');
const {
  createBilibiliMediaProxyHandler,
  isPublicIpAddress,
  isValidSingleRangeHeader,
  validateUpstreamUrl
} = require('./bilibili');

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
}

{
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testDataDirectory = process.env.HAVEN_DATA_DIR;

const {
  cleanupAllBilibiliPlaybackSessions,
  ensureBilibiliPlaybackSession,
  isAllowedHlsAssetName,
  isValidSessionVersion,
  lookupBilibiliHlsAsset,
  releaseBilibiliPlaybackSession
} = require('./bilibili');
const { createBilibiliMediaPayload } = require('./bilibili');

const FIRST_TRACK_ID = 'a1b2c3d4e5f60718293a4b5c';
const SECOND_TRACK_ID = 'b1c2d3e4f5a60718293a4b5c';
const SOURCE_PAGE_URL = 'https://www.bilibili.com/video/BV1234567890';

function createSelectedSource(videoHeight = 360, availableVideoHeights = [360]) {
  return {
    videoUrl: `https://video.example.test/video-${videoHeight}.m4s?deadline=4102444800`,
    audioUrl: 'https://audio.example.test/audio.m4s?deadline=4102444800',
    videoMime: 'video/mp4',
    audioMime: 'audio/mp4',
    width: videoHeight >= 720 ? 1280 : 640,
    height: videoHeight,
    duration: 120,
    requestedVideoHeight: videoHeight,
    selectedVideoHeight: videoHeight,
    availableVideoHeights,
    videoRequestHeaders: { Referer: SOURCE_PAGE_URL },
    audioRequestHeaders: { Referer: SOURCE_PAGE_URL },
    expiresAt: Date.now() + 60 * 60 * 1000
  };
}

async function createFakeRemux(options) {
  await fs.promises.mkdir(options.outputDirectory, { recursive: true });
  await Promise.all([
    fs.promises.writeFile(path.join(options.outputDirectory, 'index.m3u8'), '#EXTM3U\n'),
    fs.promises.writeFile(path.join(options.outputDirectory, 'init.mp4'), 'init'),
    fs.promises.writeFile(path.join(options.outputDirectory, 'segment-000000.m4s'), 'segment')
  ]);
  return {
    completion: Promise.resolve(),
    stop() {}
  };
}

test('session and asset validators reject path traversal and malformed generations', () => {
  assert.equal(isValidSessionVersion('1700000000000-a1b2c3d4e5f60718'), true);
  assert.equal(isValidSessionVersion('../session'), false);
  assert.equal(isAllowedHlsAssetName('index.m3u8'), true);
  assert.equal(isAllowedHlsAssetName('segment-000123.m4s'), true);
  assert.equal(isAllowedHlsAssetName('../index.m3u8'), false);
  assert.equal(isAllowedHlsAssetName('segment-1.m4s'), false);
});

test('different tracks share one HLS generation while retaining track-specific DASH fallback', async () => {
  let remuxStartCount = 0;
  const startRemux = async options => {
    remuxStartCount += 1;
    return createFakeRemux(options);
  };
  const resolveSourceMedia = async () => createSelectedSource();

  const [firstMedia, secondMedia] = await Promise.all([
    ensureBilibiliPlaybackSession({
      trackId: FIRST_TRACK_ID,
      sourcePageUrl: SOURCE_PAGE_URL,
      hlsEnabled: true,
      resolveSourceMedia,
      startRemux
    }),
    ensureBilibiliPlaybackSession({
      trackId: SECOND_TRACK_ID,
      sourcePageUrl: SOURCE_PAGE_URL,
      hlsEnabled: true,
      resolveSourceMedia,
      startRemux
    })
  ]);

  assert.equal(remuxStartCount, 1);
  assert.match(firstMedia.hlsUrl, new RegExp(`^/api/bilibili-hls/${FIRST_TRACK_ID}/`));
  assert.match(secondMedia.hlsUrl, new RegExp(`^/api/bilibili-hls/${SECOND_TRACK_ID}/`));
  const firstVersion = firstMedia.hlsUrl.split('/')[4];
  const secondVersion = secondMedia.hlsUrl.split('/')[4];
  assert.equal(firstVersion, secondVersion);
  assert.notEqual(firstMedia.videoUrl, secondMedia.videoUrl);

  const firstLookup = lookupBilibiliHlsAsset(FIRST_TRACK_ID, firstVersion, 'index.m3u8');
  const secondLookup = lookupBilibiliHlsAsset(SECOND_TRACK_ID, secondVersion, 'segment-000000.m4s');
  assert.equal(firstLookup.status, 'active');
  assert.equal(secondLookup.status, 'active');

  const publicPayload = createBilibiliMediaPayload(firstMedia);
  assert.equal(publicPayload.transport, 'hls-fmp4');
  assert.equal(JSON.stringify(publicPayload).includes('example.test'), false);

  releaseBilibiliPlaybackSession(FIRST_TRACK_ID);
  assert.equal(lookupBilibiliHlsAsset(FIRST_TRACK_ID, firstVersion, 'index.m3u8').status, 'missing');
  assert.equal(lookupBilibiliHlsAsset(SECOND_TRACK_ID, secondVersion, 'index.m3u8').status, 'active');
});

test('HLS startup failure returns the existing DASH fallback payload', async () => {
  const fallbackMedia = await ensureBilibiliPlaybackSession({
    trackId: FIRST_TRACK_ID,
    sourcePageUrl: 'https://www.bilibili.com/video/BV0987654321',
    force: true,
    hlsEnabled: true,
    resolveSourceMedia: async () => createSelectedSource(),
    startRemux: async () => { throw new Error('ffmpeg unavailable'); }
  });

  assert.equal(fallbackMedia.hlsUrl, undefined);
  assert.match(fallbackMedia.videoUrl, /^\/api\/bilibili-stream\//);
  assert.match(fallbackMedia.audioUrl, /^\/api\/bilibili-stream\//);
});

test('playback defaults to 360p but forwards an explicitly selected room quality', async () => {
  const requestedHeights = [];
  const resolveSourceMedia = async (_sourcePageUrl, options) => {
    requestedHeights.push(options.preferredVideoHeight);
    return createSelectedSource(options.preferredVideoHeight, [360, 720]);
  };

  const defaultMedia = await ensureBilibiliPlaybackSession({
    trackId: FIRST_TRACK_ID,
    sourcePageUrl: 'https://www.bilibili.com/video/BV6677889900',
    hlsEnabled: false,
    resolveSourceMedia
  });
  releaseBilibiliPlaybackSession(FIRST_TRACK_ID);

  const highQualityMedia = await ensureBilibiliPlaybackSession({
    trackId: SECOND_TRACK_ID,
    sourcePageUrl: 'https://www.bilibili.com/video/BV6677889900',
    preferredVideoHeight: 720,
    hlsEnabled: false,
    resolveSourceMedia
  });

  assert.deepEqual(requestedHeights, [360, 720]);
  assert.equal(defaultMedia.requestedVideoHeight, 360);
  assert.equal(highQualityMedia.requestedVideoHeight, 720);
  assert.deepEqual(highQualityMedia.availableVideoHeights, [360, 720]);
  releaseBilibiliPlaybackSession(SECOND_TRACK_ID);
});

test('different selected qualities use separate HLS generations', async () => {
  let remuxStartCount = 0;
  const startRemux = async options => {
    remuxStartCount += 1;
    return createFakeRemux(options);
  };
  const resolveSourceMedia = async (_sourcePageUrl, options) => (
    createSelectedSource(options.preferredVideoHeight, [360, 720])
  );

  const lowQualityMedia = await ensureBilibiliPlaybackSession({
    trackId: FIRST_TRACK_ID,
    sourcePageUrl: 'https://www.bilibili.com/video/BV5566778899',
    preferredVideoHeight: 360,
    hlsEnabled: true,
    resolveSourceMedia,
    startRemux
  });
  const highQualityMedia = await ensureBilibiliPlaybackSession({
    trackId: SECOND_TRACK_ID,
    sourcePageUrl: 'https://www.bilibili.com/video/BV5566778899',
    preferredVideoHeight: 720,
    hlsEnabled: true,
    resolveSourceMedia,
    startRemux
  });

  assert.equal(remuxStartCount, 2);
  assert.notEqual(lowQualityMedia.hlsUrl.split('/')[4], highQualityMedia.hlsUrl.split('/')[4]);
  releaseBilibiliPlaybackSession(FIRST_TRACK_ID);
  releaseBilibiliPlaybackSession(SECOND_TRACK_ID);
});

test('releasing a track while HLS is starting prevents the completed task from leaking a registration', async () => {
  let resolveRemuxStart;
  const delayedRemux = new Promise(resolve => { resolveRemuxStart = resolve; });
  const pendingMedia = ensureBilibiliPlaybackSession({
    trackId: FIRST_TRACK_ID,
    sourcePageUrl: 'https://www.bilibili.com/video/BV1122334455',
    force: true,
    hlsEnabled: true,
    resolveSourceMedia: async () => createSelectedSource(),
    startRemux: () => delayedRemux
  });

  await new Promise(resolve => setTimeout(resolve, 10));
  releaseBilibiliPlaybackSession(FIRST_TRACK_ID);
  resolveRemuxStart({
    completion: Promise.resolve(),
    stop() {}
  });

  await assert.rejects(pendingMedia, /cancelled/);
});

test.after(async () => {
  await cleanupAllBilibiliPlaybackSessions();
  await fs.promises.rm(testDataDirectory, { recursive: true, force: true });
});
}

