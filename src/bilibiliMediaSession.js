'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BILIBILI_HLS_DIR } = require('./paths');
const {
  clearBilibiliStreamRegistrations,
  normalizePreferredVideoHeight,
  registerBilibiliStream,
  resolveBilibiliSourceMedia
} = require('./bilibiliMedia');
const {
  calculateDirectorySize,
  initializeBilibiliHlsStorage,
  isBilibiliHlsEnabled,
  removeDirectoryWithRetry,
  startBilibiliHlsRemux
} = require('./bilibiliHlsRemux');

const DEFAULT_VIDEO_HEIGHT = 360;
const DEFAULT_GENERATION_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_STALE_SESSION_MS = 60 * 60 * 1000;
const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MAX_SESSION_BYTES = 1024 * 1024 * 1024;

const sessionsById = new Map();
const currentSessionsByMediaKey = new Map();
const sessionsByTrackId = new Map();
const inFlightSessions = new Map();
const cancelledTrackIds = new Set();
let reservedHlsBytes = 0;
let quotaAdmissionPromise = Promise.resolve();

function readPositiveIntegerEnvironment(name, fallback, maximum) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

function isValidTrackId(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
}

function isValidSessionVersion(value) {
  return typeof value === 'string' && /^\d{13}-[a-f0-9]{16}$/i.test(value);
}

function isAllowedHlsAssetName(value) {
  return value === 'index.m3u8'
    || value === 'init.mp4'
    || /^segment-\d{6}\.m4s$/.test(value);
}

function createMediaKey(sourcePageUrl, selectedSource) {
  const selectedVideoHeight = Number(selectedSource?.selectedVideoHeight)
    || Number(selectedSource?.height)
    || DEFAULT_VIDEO_HEIGHT;
  const credentialVersion = String(selectedSource?.credentialVersion || 'anonymous');
  return crypto
    .createHash('sha256')
    .update(`${sourcePageUrl}|height=${selectedVideoHeight}|codecs=h264-aac-v1|credential=${credentialVersion}`)
    .digest('hex');
}

function createSessionVersion() {
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

function createCancelledError() {
  const error = new Error('Bilibili playback session was cancelled');
  error.code = 'BILIBILI_SESSION_CANCELLED';
  return error;
}

function createDashPayload(trackId, sourcePageUrl, selectedSource) {
  return registerBilibiliStream(
    trackId,
    sourcePageUrl,
    selectedSource,
    selectedSource.expiresAt
  );
}

function createCombinedPayload(trackId, session, dashPayload) {
  if (!session) return dashPayload;
  return {
    ...dashPayload,
    transport: 'hls-fmp4',
    hlsUrl: `/api/bilibili-hls/${trackId}/${session.sessionVersion}/index.m3u8`,
    hlsMime: 'application/vnd.apple.mpegurl'
  };
}

function getTrackSessions(trackId) {
  const trackSessions = sessionsByTrackId.get(trackId) || new Map();
  sessionsByTrackId.set(trackId, trackSessions);
  return trackSessions;
}

function cancelCleanupTimer(session) {
  if (!session.cleanupTimer) return;
  clearTimeout(session.cleanupTimer);
  session.cleanupTimer = null;
}

async function destroySession(session) {
  if (!session || session.destroyed) return;
  session.destroyed = true;
  cancelCleanupTimer(session);
  session.remux?.stop();
  sessionsById.delete(session.sessionId);
  if (currentSessionsByMediaKey.get(session.mediaKey) === session) {
    currentSessionsByMediaKey.delete(session.mediaKey);
  }
  for (const trackId of session.trackIds) {
    const trackSessions = sessionsByTrackId.get(trackId);
    trackSessions?.delete(session.sessionVersion);
    if (trackSessions?.size === 0) sessionsByTrackId.delete(trackId);
  }
  session.trackIds.clear();
  if (session.reservedBytes > 0) {
    reservedHlsBytes = Math.max(0, reservedHlsBytes - session.reservedBytes);
    session.reservedBytes = 0;
  }
  if (session.remux?.completion) {
    await Promise.race([
      session.remux.completion.catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 4000))
    ]);
  }
  try {
    await removeDirectoryWithRetry(session.outputDirectory);
  } catch (error) {
    console.warn(`[BilibiliHLS] Could not remove ${session.sessionVersion}: ${error.message}`);
  }
}

function scheduleSessionCleanup(session, delayMs = DEFAULT_GENERATION_GRACE_MS) {
  if (!session || session.destroyed || session.trackIds.size > 0 || session.cleanupTimer) return;
  session.cleanupTimer = setTimeout(() => {
    session.cleanupTimer = null;
    void destroySession(session);
  }, delayMs);
  session.cleanupTimer.unref?.();
}

function disassociateTrackFromSession(trackId, session) {
  if (!session) return;
  session.trackIds.delete(trackId);
  const trackSessions = sessionsByTrackId.get(trackId);
  trackSessions?.delete(session.sessionVersion);
  if (trackSessions?.size === 0) sessionsByTrackId.delete(trackId);
  scheduleSessionCleanup(session);
}

function associateTrackWithSession(trackId, session) {
  cancelCleanupTimer(session);
  session.trackIds.add(trackId);
  session.lastAccessedAt = Date.now();
  const trackSessions = getTrackSessions(trackId);
  for (const previousSession of trackSessions.values()) {
    if (previousSession !== session) {
      setTimeout(() => disassociateTrackFromSession(trackId, previousSession), DEFAULT_GENERATION_GRACE_MS).unref?.();
    }
  }
  trackSessions.set(session.sessionVersion, session);
}

function withQuotaAdmissionLock(callback) {
  const admissionTask = quotaAdmissionPromise.then(callback, callback);
  quotaAdmissionPromise = admissionTask.catch(() => {});
  return admissionTask;
}

async function reserveSessionCapacity() {
  const maximumTotalBytes = readPositiveIntegerEnvironment(
    'BILIBILI_HLS_MAX_TOTAL_BYTES',
    DEFAULT_MAX_TOTAL_BYTES,
    100 * 1024 * 1024 * 1024
  );
  const reservationBytes = readPositiveIntegerEnvironment(
    'BILIBILI_HLS_MAX_SESSION_BYTES',
    DEFAULT_MAX_SESSION_BYTES,
    20 * 1024 * 1024 * 1024
  );
  return withQuotaAdmissionLock(async () => {
    let currentBytes = await calculateDirectorySize(BILIBILI_HLS_DIR);
    if (currentBytes + reservedHlsBytes + reservationBytes > maximumTotalBytes) {
      const removableSessions = [...sessionsById.values()]
        .filter(session => session.trackIds.size === 0 && session.state !== 'starting')
        .sort((leftSession, rightSession) => leftSession.lastAccessedAt - rightSession.lastAccessedAt);
      for (const session of removableSessions) {
        await destroySession(session);
        currentBytes = await calculateDirectorySize(BILIBILI_HLS_DIR);
        if (currentBytes + reservedHlsBytes + reservationBytes <= maximumTotalBytes) break;
      }
    }
    if (currentBytes + reservedHlsBytes + reservationBytes > maximumTotalBytes) return 0;
    reservedHlsBytes += reservationBytes;
    return reservationBytes;
  });
}

async function createHlsSession(sourcePageUrl, selectedSource, mediaKey, options = {}) {
  await initializeBilibiliHlsStorage();
  const reservedBytes = await reserveSessionCapacity();
  if (!reservedBytes) {
    throw new Error('Bilibili HLS disk quota is full');
  }

  const sessionVersion = createSessionVersion();
  const sessionId = crypto.randomBytes(16).toString('hex');
  const outputDirectory = path.join(BILIBILI_HLS_DIR, sessionId);
  const session = {
    sessionId,
    sessionVersion,
    mediaKey,
    sourcePageUrl,
    outputDirectory,
    state: 'starting',
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    trackIds: new Set(),
    cleanupTimer: null,
    destroyed: false,
    remux: null,
    failureMessage: null,
    reservedBytes
  };
  sessionsById.set(sessionId, session);

  try {
    const startRemux = options.startRemux || startBilibiliHlsRemux;
    session.remux = await startRemux({
      outputDirectory,
      videoUrl: selectedSource.videoUrl,
      audioUrl: selectedSource.audioUrl,
      videoRequestHeaders: selectedSource.videoRequestHeaders,
      audioRequestHeaders: selectedSource.audioRequestHeaders,
      signal: options.signal
    });
    if (session.destroyed) {
      session.remux.stop();
      await session.remux.completion.catch(() => {});
      await removeDirectoryWithRetry(outputDirectory).catch(() => {});
      throw new Error('Bilibili HLS session was cancelled while starting');
    }
    session.state = 'ready';
    currentSessionsByMediaKey.set(mediaKey, session);
    session.remux.completion.then(() => {
      if (session.reservedBytes > 0) {
        reservedHlsBytes = Math.max(0, reservedHlsBytes - session.reservedBytes);
        session.reservedBytes = 0;
      }
      if (!session.destroyed) session.state = 'completed';
    }).catch(error => {
      if (session.reservedBytes > 0) {
        reservedHlsBytes = Math.max(0, reservedHlsBytes - session.reservedBytes);
        session.reservedBytes = 0;
      }
      if (session.destroyed) return;
      session.state = 'failed';
      session.failureMessage = error.message;
      console.warn(`[BilibiliHLS] ${session.sessionVersion} stopped: ${error.message}`);
    });
    return session;
  } catch (error) {
    session.state = 'failed';
    session.failureMessage = error.message;
    await destroySession(session);
    throw error;
  }
}

async function ensureBilibiliPlaybackSession(options) {
  const trackId = String(options.trackId || '');
  const sourcePageUrl = String(options.sourcePageUrl || '');
  if (!isValidTrackId(trackId)) throw new Error('A valid track ID is required for Bilibili playback');
  cancelledTrackIds.delete(trackId);
  const preferredVideoHeight = normalizePreferredVideoHeight(options.preferredVideoHeight);

  const resolveSourceMedia = options.resolveSourceMedia || resolveBilibiliSourceMedia;
  const selectedSource = await resolveSourceMedia(sourcePageUrl, {
    force: options.force === true,
    preferredVideoHeight
  });
  const dashPayload = createDashPayload(trackId, sourcePageUrl, selectedSource);
  if (cancelledTrackIds.has(trackId)) {
    clearBilibiliStreamRegistrations(trackId);
    throw createCancelledError();
  }
  const hlsEnabled = typeof options.hlsEnabled === 'boolean' ? options.hlsEnabled : isBilibiliHlsEnabled();
  if (!hlsEnabled) return dashPayload;

  const mediaKey = createMediaKey(sourcePageUrl, selectedSource);
  if (options.force !== true) {
    const existingSession = currentSessionsByMediaKey.get(mediaKey);
    if (existingSession && !existingSession.destroyed && ['ready', 'completed'].includes(existingSession.state)) {
      associateTrackWithSession(trackId, existingSession);
      return createCombinedPayload(trackId, existingSession, dashPayload);
    }
  }

  const inFlightKey = options.force === true ? `${mediaKey}|force` : mediaKey;
  let inFlightEntry = inFlightSessions.get(inFlightKey);
  if (!inFlightEntry) {
    const abortController = new AbortController();
    inFlightEntry = {
      abortController,
      pendingTrackIds: new Set(),
      promise: createHlsSession(sourcePageUrl, selectedSource, mediaKey, {
        startRemux: options.startRemux,
        signal: abortController.signal
      })
    };
    inFlightSessions.set(inFlightKey, inFlightEntry);
  }
  inFlightEntry.pendingTrackIds.add(trackId);

  try {
    const session = await inFlightEntry.promise;
    if (cancelledTrackIds.has(trackId)) {
      clearBilibiliStreamRegistrations(trackId);
      scheduleSessionCleanup(session);
      throw createCancelledError();
    }
    associateTrackWithSession(trackId, session);
    return createCombinedPayload(trackId, session, dashPayload);
  } catch (error) {
    if (error?.code === 'BILIBILI_SESSION_CANCELLED') throw error;
    console.warn(`[BilibiliHLS] Falling back to DASH: ${error.message}`);
    return dashPayload;
  } finally {
    inFlightEntry.pendingTrackIds.delete(trackId);
    if (inFlightSessions.get(inFlightKey) === inFlightEntry) inFlightSessions.delete(inFlightKey);
  }
}

function lookupBilibiliHlsAsset(trackId, sessionVersion, assetName) {
  if (!isValidTrackId(trackId) || !isValidSessionVersion(sessionVersion) || !isAllowedHlsAssetName(assetName)) {
    return { status: 'missing', asset: null };
  }
  const session = sessionsByTrackId.get(trackId)?.get(sessionVersion);
  if (!session || session.destroyed) return { status: 'missing', asset: null };
  if (session.state === 'failed' && !fs.existsSync(path.join(session.outputDirectory, assetName))) {
    return { status: 'expired', asset: null };
  }
  const assetPath = path.join(session.outputDirectory, assetName);
  if (!fs.existsSync(assetPath)) return { status: 'missing', asset: null };
  session.lastAccessedAt = Date.now();
  return {
    status: 'active',
    asset: {
      path: assetPath,
      assetName,
      sessionVersion,
      trackId,
      contentType: assetName === 'index.m3u8'
        ? 'application/vnd.apple.mpegurl'
        : assetName === 'init.mp4'
          ? 'video/mp4'
          : 'video/iso.segment'
    }
  };
}

function releaseBilibiliPlaybackSession(trackId) {
  if (!isValidTrackId(trackId)) return;
  cancelledTrackIds.add(trackId);
  const cancellationCleanupTimer = setTimeout(() => {
    cancelledTrackIds.delete(trackId);
  }, 2 * 60 * 1000);
  cancellationCleanupTimer.unref?.();
  for (const inFlightEntry of inFlightSessions.values()) {
    inFlightEntry.pendingTrackIds.delete(trackId);
    if (inFlightEntry.pendingTrackIds.size === 0) inFlightEntry.abortController.abort();
  }
  clearBilibiliStreamRegistrations(trackId);
  const trackSessions = sessionsByTrackId.get(trackId);
  if (!trackSessions) return;
  for (const session of [...trackSessions.values()]) disassociateTrackFromSession(trackId, session);
  sessionsByTrackId.delete(trackId);
}

async function pruneBilibiliPlaybackSessions(now = Date.now()) {
  const staleSessionMs = readPositiveIntegerEnvironment(
    'BILIBILI_HLS_STALE_MS',
    DEFAULT_STALE_SESSION_MS,
    24 * 60 * 60 * 1000
  );
  for (const session of [...sessionsById.values()]) {
    if (session.trackIds.size === 0 && now - session.lastAccessedAt >= staleSessionMs) {
      await destroySession(session);
    }
  }
}

async function cleanupAllBilibiliPlaybackSessions() {
  const sessions = [...sessionsById.values()];
  for (const session of sessions) session.remux?.stop();
  await Promise.allSettled(sessions.map(session => destroySession(session)));
  currentSessionsByMediaKey.clear();
  sessionsByTrackId.clear();
  inFlightSessions.clear();
  cancelledTrackIds.clear();
}

module.exports = {
  cleanupAllBilibiliPlaybackSessions,
  ensureBilibiliPlaybackSession,
  isAllowedHlsAssetName,
  isValidSessionVersion,
  lookupBilibiliHlsAsset,
  pruneBilibiliPlaybackSessions,
  releaseBilibiliPlaybackSession
};
