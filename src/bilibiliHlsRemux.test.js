'use strict';

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
} = require('./bilibiliHlsRemux');

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
