'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BILIBILI_HLS_DIR } = require('./paths');

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_READY_TIMEOUT_MS = 25000;
const DEFAULT_MAX_SESSION_BYTES = 1024 * 1024 * 1024;
const DEFAULT_SEGMENT_DURATION_SECONDS = 4;
const READY_POLL_INTERVAL_MS = 200;

let activeRemuxProcesses = 0;
const remuxWaiters = [];
let storageInitializationPromise = null;

function readPositiveIntegerEnvironment(name, fallback, maximum) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

function isBilibiliHlsEnabled() {
  return String(process.env.BILIBILI_HLS_ENABLED || 'true').toLowerCase() !== 'false';
}

function findFfmpegBinary() {
  const configuredPath = String(process.env.FFMPEG_PATH || '').trim();
  if (configuredPath) return configuredPath;
  for (const candidatePath of ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    try {
      fs.accessSync(candidatePath, fs.constants.X_OK);
      return candidatePath;
    } catch {}
  }
  return 'ffmpeg';
}

function createFfmpegHeaderBlock(headers) {
  if (!headers || typeof headers !== 'object') return '';
  const allowedNames = new Set(['Accept', 'Origin', 'Referer', 'User-Agent']);
  const headerLines = [];
  for (const [headerName, rawValue] of Object.entries(headers)) {
    if (!allowedNames.has(headerName) || typeof rawValue !== 'string') continue;
    const headerValue = rawValue.trim();
    if (!headerValue || /[\r\n]/.test(headerValue)) continue;
    headerLines.push(`${headerName}: ${headerValue}`);
  }
  return headerLines.length ? `${headerLines.join('\r\n')}\r\n` : '';
}

function appendFfmpegInputArguments(argumentsList, inputUrl, requestHeaders) {
  const headerBlock = createFfmpegHeaderBlock(requestHeaders);
  argumentsList.push(
    '-rw_timeout', '15000000',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5'
  );
  if (headerBlock) argumentsList.push('-headers', headerBlock);
  argumentsList.push('-i', inputUrl);
}

function buildFfmpegArguments(options) {
  const outputDirectory = options.outputDirectory;
  const segmentDurationSeconds = Number.isInteger(options.segmentDurationSeconds)
    ? Math.max(2, Math.min(10, options.segmentDurationSeconds))
    : readPositiveIntegerEnvironment(
      'BILIBILI_HLS_SEGMENT_SECONDS',
      DEFAULT_SEGMENT_DURATION_SECONDS,
      10
    );
  const playlistPath = path.join(outputDirectory, 'index.m3u8');
  const segmentPattern = path.join(outputDirectory, 'segment-%06d.m4s');
  const argumentsList = [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'warning',
    '-y'
  ];

  appendFfmpegInputArguments(argumentsList, options.videoUrl, options.videoRequestHeaders);
  appendFfmpegInputArguments(argumentsList, options.audioUrl, options.audioRequestHeaders);
  argumentsList.push(
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c', 'copy',
    '-max_interleave_delta', '0',
    '-f', 'hls',
    '-hls_segment_type', 'fmp4',
    '-hls_time', String(segmentDurationSeconds),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', segmentPattern,
    playlistPath
  );
  return argumentsList;
}

function acquireRemuxSlot(signal) {
  if (signal?.aborted) return Promise.reject(new Error('Bilibili HLS remux was cancelled'));
  const maximumConcurrent = readPositiveIntegerEnvironment(
    'BILIBILI_HLS_MAX_CONCURRENT',
    DEFAULT_MAX_CONCURRENT,
    16
  );
  if (activeRemuxProcesses < maximumConcurrent) {
    activeRemuxProcesses += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: null, cancelled: false };
    waiter.onAbort = () => {
      waiter.cancelled = true;
      reject(new Error('Bilibili HLS remux was cancelled'));
    };
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    remuxWaiters.push(waiter);
  }).then(() => {
    activeRemuxProcesses += 1;
  });
}

function releaseRemuxSlot() {
  activeRemuxProcesses = Math.max(0, activeRemuxProcesses - 1);
  while (remuxWaiters.length > 0) {
    const nextWaiter = remuxWaiters.shift();
    nextWaiter.signal?.removeEventListener('abort', nextWaiter.onAbort);
    if (nextWaiter.cancelled || nextWaiter.signal?.aborted) continue;
    nextWaiter.resolve();
    break;
  }
}

async function calculateDirectorySize(directoryPath) {
  let totalBytes = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) totalBytes += await calculateDirectorySize(entryPath);
    else if (entry.isFile()) {
      try {
        totalBytes += (await fs.promises.stat(entryPath)).size;
      } catch {}
    }
  }
  return totalBytes;
}

async function removeDirectoryWithRetry(directoryPath, attempts = 5) {
  for (let attemptNumber = 1; attemptNumber <= attempts; attemptNumber += 1) {
    try {
      await fs.promises.rm(directoryPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attemptNumber === attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, attemptNumber * 150));
    }
  }
}

function initializeBilibiliHlsStorage() {
  if (storageInitializationPromise) return storageInitializationPromise;
  storageInitializationPromise = (async () => {
    await fs.promises.mkdir(BILIBILI_HLS_DIR, { recursive: true });
    const entries = await fs.promises.readdir(BILIBILI_HLS_DIR, { withFileTypes: true });
    await Promise.all(entries.map(entry => removeDirectoryWithRetry(path.join(BILIBILI_HLS_DIR, entry.name))));
  })();
  return storageInitializationPromise;
}

async function isHlsOutputReady(outputDirectory) {
  const playlistPath = path.join(outputDirectory, 'index.m3u8');
  const initSegmentPath = path.join(outputDirectory, 'init.mp4');
  try {
    const [playlistStat, initStat, entries] = await Promise.all([
      fs.promises.stat(playlistPath),
      fs.promises.stat(initSegmentPath),
      fs.promises.readdir(outputDirectory)
    ]);
    return playlistStat.size > 0
      && initStat.size > 0
      && entries.some(entryName => /^segment-\d{6}\.m4s$/.test(entryName));
  } catch {
    return false;
  }
}

async function startBilibiliHlsRemux(options) {
  if (!isBilibiliHlsEnabled()) throw new Error('Bilibili HLS is disabled');
  await initializeBilibiliHlsStorage();
  await acquireRemuxSlot(options.signal);
  if (options.signal?.aborted) {
    releaseRemuxSlot();
    throw new Error('Bilibili HLS remux was cancelled');
  }

  const outputDirectory = options.outputDirectory;
  try {
    await fs.promises.mkdir(outputDirectory, { recursive: true });
  } catch (error) {
    releaseRemuxSlot();
    throw error;
  }
  const spawnProcess = options.spawnProcess || spawn;
  const ffmpegArguments = buildFfmpegArguments(options);
  let childProcess;
  try {
    childProcess = spawnProcess(findFfmpegBinary(), ffmpegArguments, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch (error) {
    releaseRemuxSlot();
    throw error;
  }

  let stopped = false;
  let stderrText = '';
  let readySettled = false;
  let completionSettled = false;
  let quotaExceededError = null;
  let forceKillTimer = null;
  let processClosed = false;
  const readyTimeoutMs = readPositiveIntegerEnvironment(
    'BILIBILI_HLS_READY_TIMEOUT_MS',
    DEFAULT_READY_TIMEOUT_MS,
    120000
  );
  const maximumSessionBytes = readPositiveIntegerEnvironment(
    'BILIBILI_HLS_MAX_SESSION_BYTES',
    DEFAULT_MAX_SESSION_BYTES,
    20 * 1024 * 1024 * 1024
  );
  const forceKillTimeoutMs = Number.isInteger(options.forceKillTimeoutMs)
    ? Math.max(1, options.forceKillTimeoutMs)
    : 3000;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (!processClosed) childProcess.kill('SIGTERM');
    forceKillTimer = setTimeout(() => {
      if (!processClosed) childProcess.kill('SIGKILL');
    }, forceKillTimeoutMs);
    forceKillTimer.unref?.();
  };
  const abortRemux = () => stop();
  options.signal?.addEventListener('abort', abortRemux, { once: true });

  const completion = new Promise((resolve, reject) => {
    const finishCompletion = (error) => {
      if (completionSettled) return;
      completionSettled = true;
      clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', abortRemux);
      releaseRemuxSlot();
      if (error) reject(error);
      else resolve();
    };
    childProcess.once('error', error => {
      processClosed = true;
      const unavailableError = error?.code === 'ENOENT'
        ? new Error('ffmpeg is not installed or FFMPEG_PATH is incorrect')
        : new Error(`ffmpeg could not be started: ${error.message}`);
      finishCompletion(unavailableError);
    });
    childProcess.once('close', exitCode => {
      processClosed = true;
      if (quotaExceededError) {
        finishCompletion(quotaExceededError);
        return;
      }
      if (stopped) {
        finishCompletion(null);
        return;
      }
      if (exitCode === 0) finishCompletion(null);
      else finishCompletion(new Error(stderrText.trim().slice(0, 500) || `ffmpeg exited with code ${exitCode}`));
    });
  });

  childProcess.stderr?.on('data', chunk => {
    if (stderrText.length < 8192) stderrText += chunk.toString('utf8');
  });

  const quotaTimer = setInterval(async () => {
    const directoryBytes = await calculateDirectorySize(outputDirectory);
    if (directoryBytes <= maximumSessionBytes || quotaExceededError) return;
    quotaExceededError = new Error('Bilibili HLS session exceeded its disk quota');
    stop();
  }, 2000);
  quotaTimer.unref?.();
  completion.finally(() => clearInterval(quotaTimer)).catch(() => {});

  const readyPromise = new Promise((resolve, reject) => {
    const readyStartedAt = Date.now();
    const pollReady = async () => {
      if (readySettled) return;
      if (await isHlsOutputReady(outputDirectory)) {
        readySettled = true;
        resolve();
        return;
      }
      if (completionSettled) {
        readySettled = true;
        completion.then(
          () => reject(new Error('ffmpeg stopped before the HLS playlist became ready')),
          reject
        );
        return;
      }
      if (Date.now() - readyStartedAt >= readyTimeoutMs) {
        readySettled = true;
        stop();
        reject(new Error('Timed out waiting for Bilibili HLS segments'));
        return;
      }
      setTimeout(pollReady, READY_POLL_INTERVAL_MS);
    };
    void pollReady();
  });

  try {
    await readyPromise;
  } catch (error) {
    stop();
    completion.catch(() => {});
    throw error;
  }

  return {
    childProcess,
    completion,
    ffmpegArguments,
    outputDirectory,
    stop
  };
}

module.exports = {
  buildFfmpegArguments,
  calculateDirectorySize,
  findFfmpegBinary,
  initializeBilibiliHlsStorage,
  isBilibiliHlsEnabled,
  isHlsOutputReady,
  removeDirectoryWithRetry,
  startBilibiliHlsRemux
};
