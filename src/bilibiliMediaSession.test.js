'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-hls-session-'));
process.env.HAVEN_DATA_DIR = testDataDirectory;

const {
  cleanupAllBilibiliPlaybackSessions,
  ensureBilibiliPlaybackSession,
  isAllowedHlsAssetName,
  isValidSessionVersion,
  lookupBilibiliHlsAsset,
  releaseBilibiliPlaybackSession
} = require('./bilibiliMediaSession');
const { createBilibiliMediaPayload } = require('./bilibiliMedia');

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
