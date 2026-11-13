'use strict';

const crypto = require('crypto');
const { isInt, isString } = require('./helpers');

const REQUEST_TTL_MS = 30_000;
const SESSION_TTL_MS = 30 * 60_000;
const PROTOCOL = 'moonlight-1';
const SETUP_TTL_MS = 120_000;
const ROUTES = new Set(['ip-direct', 'auto', 'ice-direct', 'relay', 'turn-tcp', 'turn-udp']);
function validSettings(value) {
  return value && [0, 720, 1080, 1440].includes(value.resolution) && [15, 30, 60].includes(value.fps) &&
    Number.isInteger(value.bitrateKbps) &&
    (value.bitrateKbps === 0 || value.bitrateKbps >= 1000 && value.bitrateKbps <= 50000) &&
    ROUTES.has(value.connectionPreference);
}
const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const validCertificate = value => typeof value === 'string' && value.length <= 4096 &&
  /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/.test(value);
const validIce = value => value && typeof value.ufrag === 'string' && /^[a-z0-9+/]{4,256}$/i.test(value.ufrag) &&
  typeof value.password === 'string' && /^[a-z0-9+/]{22,256}$/i.test(value.password) &&
  Array.isArray(value.candidates) && value.candidates.length > 0 && value.candidates.length <= 32 &&
  value.candidates.every(candidate => typeof candidate === 'string' && candidate.length <= 384 &&
    /^[\x20-\x7e]+$/.test(candidate));
const validEndpoint = value => value && validCertificate(value.certificate) && validIce(value.iceOffer) &&
  Number.isInteger(value.basePort) && value.basePort >= 49000 && value.basePort < 60000 &&
  typeof value.videoMode === 'string' && /^\d{3,4}x\d{3,4}x(?:15|30|60)$/.test(value.videoMode) &&
  (value.bitrateKbps == null || Number.isInteger(value.bitrateKbps) &&
    value.bitrateKbps >= 1000 && value.bitrateKbps <= 50000) && typeof value.relayOnly === 'boolean';
const MAX_REQUESTS_PER_MINUTE = 4;

module.exports = function register(socket, ctx) {
  const { io, db, state } = ctx;
  const {
    channelUsers,
    remoteControlRequests,
    remoteControlSessions,
    remoteControlRateLimits,
  } = state;

  function safeCallback(callback, payload) {
    if (typeof callback === 'function') callback(payload);
  }

  function liveSocketFor(code, userId) {
    const entry = channelUsers.get(code)?.get(userId);
    if (!entry?.socketId) return null;
    return io.sockets.sockets.get(entry.socketId) || null;
  }

  function isActiveChannelMember(code, userId) {
    return !!channelUsers.get(code)?.has(userId);
  }

  function emitToUser(code, userId, eventName, payload) {
    const target = liveSocketFor(code, userId);
    if (target) target.emit(eventName, payload);
  }

  function clearRequest(requestId, reason = 'cancelled') {
    const request = remoteControlRequests.get(requestId);
    if (!request) return;
    clearTimeout(request.timer);
    remoteControlRequests.delete(requestId);
    const payload = { requestId, channelCode: request.code, reason };
    emitToUser(request.code, request.hostId, 'remote-control-request-ended', payload);
    emitToUser(request.code, request.controllerId, 'remote-control-request-ended', payload);
  }

  function endSession(sessionId, reason = 'ended', endedBy = null) {
    const session = remoteControlSessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.timer);
    remoteControlSessions.delete(sessionId);
    const payload = {
      sessionId,
      channelCode: session.code,
      reason,
      endedBy,
    };
    io.sockets.sockets.get(session.hostSocketId)?.emit('remote-control-session-ended', payload);
    io.sockets.sockets.get(session.controllerSocketId)?.emit('remote-control-session-ended', payload);
  }

  function endSessionsForUser(userId, reason) {
    for (const [sessionId, session] of remoteControlSessions) {
      if (session.hostSocketId === socket.id || session.controllerSocketId === socket.id) {
        endSession(sessionId, reason, userId);
      }
    }
    for (const [requestId, request] of remoteControlRequests) {
      if (request.hostSocketId === socket.id || request.controllerSocketId === socket.id) {
        clearRequest(requestId, reason);
      }
    }
  }

  function hasConflictingSession(hostId, controllerId) {
    for (const session of remoteControlSessions.values()) {
      if (session.hostId === hostId || session.controllerId === hostId ||
          session.hostId === controllerId || session.controllerId === controllerId) {
        return true;
      }
    }
    return false;
  }

  function withinRequestLimit(userId) {
    const now = Date.now();
    const cutoff = now - 60_000;
    const recent = (remoteControlRateLimits.get(userId) || []).filter(ts => ts >= cutoff);
    if (recent.length >= MAX_REQUESTS_PER_MINUTE) {
      remoteControlRateLimits.set(userId, recent);
      return false;
    }
    recent.push(now);
    remoteControlRateLimits.set(userId, recent);
    return true;
  }

  function participantSupported(participant, role) {
    return participant?.remoteControlCapability?.version === PROTOCOL &&
      participant.remoteControlCapability[role + 'Supported'] === true;
  }

  socket.on('remote-control-capability', data => {
    socket.remoteControlCapability = {
      hostSupported: data?.hostSupported === true,
      controllerSupported: data?.controllerSupported === true,
      version: data?.version === PROTOCOL ? PROTOCOL : null,
      routeSelection: data?.routeSelection === 1,
    };
  });

  socket.on('remote-control-request', (data, callback) => {
    if (!data || typeof data !== 'object') return safeCallback(callback, { error: 'Invalid request' });
    const code = isString(data.code, 8, 8) ? data.code : '';
    const targetUserId = isInt(data.targetUserId) ? data.targetUserId : 0;
    const mode = data.mode === 'invite' ? 'invite' : 'request';
    if (!code || !targetUserId || targetUserId === socket.user.id) {
      return safeCallback(callback, { error: 'Invalid remote control target' });
    }
    if (socket.currentChannel !== code || !isActiveChannelMember(code, socket.user.id)) {
      return safeCallback(callback, { error: 'Open the channel before starting remote assistance' });
    }
    const targetSocket = liveSocketFor(code, targetUserId);
    if (!targetSocket) return safeCallback(callback, { error: 'That user is not currently in this channel' });
    if (socket.user.isGuest || targetSocket.user?.isGuest) {
      return safeCallback(callback, { error: 'Guest accounts cannot use remote assistance' });
    }
    if (!withinRequestLimit(socket.user.id)) {
      return safeCallback(callback, { error: 'Too many remote control requests; try again shortly' });
    }

    const hostSocket = mode === 'invite' ? socket : targetSocket;
    const controllerSocket = mode === 'invite' ? targetSocket : socket;
    const channelPolicy = db?.prepare?.('SELECT streams_enabled FROM channels WHERE code = ?')?.get?.(code);
    if (channelPolicy?.streams_enabled === 0 && !hostSocket.user?.isAdmin) {
      return safeCallback(callback, { error: 'Screen sharing is disabled in this channel' });
    }
    if (!participantSupported(hostSocket, 'host')) {
      return safeCallback(callback, {
        error: 'The host needs an updated Windows Ciacord desktop app and one active display.',
        desktopRequirement: 'host_desktop_required',
      });
    }
    if (!participantSupported(controllerSocket, 'controller')) {
      return safeCallback(callback, {
        error: 'The controller needs an updated Windows Ciacord desktop app.',
        desktopRequirement: 'controller_desktop_required',
      });
    }

    if (data.settings != null && (!validSettings(data.settings) || mode !== 'request')) {
      return safeCallback(callback, { error: 'Invalid remote control settings' });
    }
    if (data.settings && !hostSocket.remoteControlCapability.routeSelection) {
      return safeCallback(callback, { desktopRequirement: 'host_desktop_required' });
    }
    if (data.settings && !controllerSocket.remoteControlCapability.routeSelection) {
      return safeCallback(callback, { desktopRequirement: 'controller_desktop_required' });
    }
    const settings = data.settings && {
      resolution: data.settings.resolution, fps: data.settings.fps, bitrateKbps: data.settings.bitrateKbps,
      connectionPreference: data.settings.connectionPreference,
    };

    const hostId = hostSocket.user.id;
    const controllerId = controllerSocket.user.id;
    if (hasConflictingSession(hostId, controllerId)) {
      return safeCallback(callback, { error: 'One of you is already in a remote assistance session' });
    }

    for (const [existingId, request] of remoteControlRequests) {
      if (request.hostId === hostId || request.controllerId === hostId ||
          request.hostId === controllerId || request.controllerId === controllerId) {
        clearRequest(existingId, 'replaced');
      }
    }

    const requestId = crypto.randomUUID();
    const request = {
      id: requestId,
      code,
      mode,
      hostId,
      controllerId,
      hostSocketId: hostSocket.id,
      controllerSocketId: controllerSocket.id,
      responderId: targetUserId,
      settings,
      createdAt: Date.now(),
      timer: null,
    };
    request.timer = setTimeout(() => clearRequest(requestId, 'expired'), REQUEST_TTL_MS);
    request.timer.unref?.();
    remoteControlRequests.set(requestId, request);

    targetSocket.emit('remote-control-requested', {
      requestId,
      channelCode: code,
      mode,
      from: { id: socket.user.id, username: socket.user.displayName },
      role: targetUserId === hostId ? 'host' : 'controller',
      expiresAt: Date.now() + REQUEST_TTL_MS,
    });
    safeCallback(callback, { ok: true, requestId });
  });

  socket.on('remote-control-response', (data, callback) => {
    if (!data || typeof data !== 'object' || !isString(data.requestId, 1, 64)) {
      return safeCallback(callback, { error: 'Invalid remote control response' });
    }
    const request = remoteControlRequests.get(data.requestId);
    if (!request || request.responderId !== socket.user.id) {
      return safeCallback(callback, { error: 'Remote control request is no longer available' });
    }
    if (!data.accepted) {
      clearRequest(request.id, 'declined');
      return safeCallback(callback, { ok: true });
    }
    const hostSocket = liveSocketFor(request.code, request.hostId);
    const controllerSocket = liveSocketFor(request.code, request.controllerId);
    if (hostSocket?.id !== request.hostSocketId || controllerSocket?.id !== request.controllerSocketId ||
        socket.id !== (request.responderId === request.hostId ? request.hostSocketId : request.controllerSocketId) ||
        !participantSupported(hostSocket, 'host') || !participantSupported(controllerSocket, 'controller')) {
      clearRequest(request.id, 'unavailable');
      return safeCallback(callback, { error: 'One participant is no longer in the channel' });
    }
    if (hasConflictingSession(request.hostId, request.controllerId)) {
      clearRequest(request.id, 'busy');
      return safeCallback(callback, { error: 'One participant is already in another session' });
    }

    clearTimeout(request.timer);
    remoteControlRequests.delete(request.id);
    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId,
      code: request.code,
      hostId: request.hostId,
      controllerId: request.controllerId,
      hostSocketId: request.hostSocketId,
      controllerSocketId: request.controllerSocketId,
      phase: 'waiting-viewer',
      settings: request.settings,
      setupExpires: Date.now() + SETUP_TTL_MS,
      timer: null,
    };
    session.timer = setTimeout(() => endSession(sessionId, 'setup-timeout'), SETUP_TTL_MS);
    session.timer.unref?.();
    remoteControlSessions.set(sessionId, session);

    const hostName = hostSocket?.user?.displayName || 'Host';
    const controllerName = controllerSocket?.user?.displayName || 'Controller';
    hostSocket?.emit('remote-control-session-start', {
      sessionId,
      channelCode: request.code,
      role: 'host',
      peer: { id: request.controllerId, username: controllerName },
      expiresAt: session.setupExpires,
      ...(session.settings ? { settings: session.settings } : {}),
    });
    controllerSocket?.emit('remote-control-session-start', {
      sessionId,
      channelCode: request.code,
      role: 'controller',
      peer: { id: request.hostId, username: hostName },
      expiresAt: session.setupExpires,
      ...(session.settings ? { settings: session.settings } : {}),
    });
    safeCallback(callback, { ok: true, sessionId });
  });

  socket.on('remote-control-signal', (data, callback) => {
    const reply = ok => safeCallback(callback, { ok });
    if (!validId(data?.sessionId)) return reply(false);
    const session = remoteControlSessions.get(data.sessionId);
    if (!session || session.code !== socket.currentChannel) return reply(false);
    const host = liveSocketFor(session.code, session.hostId);
    const controller = liveSocketFor(session.code, session.controllerId);
    if (host?.id !== session.hostSocketId || controller?.id !== session.controllerSocketId) return reply(false);
    let target, signal;
    if (data.kind === 'viewer' && socket.id === controller.id && session.phase === 'waiting-viewer' &&
        validId(data.watchId) && validCertificate(data.certificate)) {
      session.phase = 'waiting-host';
      target = host;
      signal = { watchId: data.watchId, certificate: data.certificate };
      if (data.transfer === true) signal.transfer = true;
    } else if (data.kind === 'offer' && socket.id === host.id && session.phase === 'waiting-host' &&
        validEndpoint(data.endpoint)) {
      session.phase = 'waiting-answer';
      target = controller;
      const { certificate, iceOffer, basePort, videoMode, bitrateKbps, relayOnly } = data.endpoint;
      signal = { endpoint: { certificate, iceOffer: { ufrag: iceOffer.ufrag, password: iceOffer.password,
        candidates: iceOffer.candidates }, basePort, videoMode, bitrateKbps, relayOnly } };
      if (data.endpoint.transfer === true) signal.endpoint.transfer = true;
      if (['public', 'stable', 'destination-dependent', 'unknown'].includes(data.endpoint.nat)) {
        signal.endpoint.nat = data.endpoint.nat;
      }
    } else if (data.kind === 'answer' && socket.id === controller.id && session.phase === 'waiting-answer' &&
        validIce(data.answer)) {
      session.phase = 'connecting';
      target = host;
      const { ufrag, password, candidates } = data.answer;
      signal = { answer: { ufrag, password, candidates } };
    } else if (data.kind === 'playing' && socket.id === controller.id && session.phase === 'connecting') {
      session.phase = 'playing';
      clearTimeout(session.timer);
      session.timer = setTimeout(() => endSession(session.id, 'expired'), SESSION_TTL_MS);
      session.timer.unref?.();
      target = host;
    } else {
      return reply(false);
    }
    target.emit('remote-control-signal', { sessionId: session.id, kind: data.kind, ...signal });
    reply(true);
  });

  socket.on('remote-control-end', data => {
    if (!validId(data?.sessionId)) return;
    const session = remoteControlSessions.get(data.sessionId);
    if (!session) return;
    if (socket.id !== session.hostSocketId && socket.id !== session.controllerSocketId) return;
    endSession(session.id, isString(data.reason, 1, 48) ? data.reason : 'ended', socket.user.id);
  });

  socket.on('enter-channel', (data = {}) => {
    const nextCode = isString(data.code, 8, 8) ? data.code : '';
    for (const session of remoteControlSessions.values()) {
      if ((session.hostSocketId === socket.id || session.controllerSocketId === socket.id) && session.code !== nextCode) {
        endSession(session.id, 'channel-changed', socket.user.id);
      }
    }
    for (const [requestId, request] of remoteControlRequests) {
      if ((request.hostSocketId === socket.id || request.controllerSocketId === socket.id) && request.code !== nextCode) {
        clearRequest(requestId, 'channel-changed');
      }
    }
  });

  socket.on('leave-channel', (data = {}) => {
    const code = isString(data.code, 8, 8) ? data.code : '';
    if (!code) return;
    for (const [sessionId, session] of remoteControlSessions) {
      if (session.code === code && (session.hostSocketId === socket.id || session.controllerSocketId === socket.id)) {
        endSession(sessionId, 'channel-left', socket.user.id);
      }
    }
    for (const [requestId, request] of remoteControlRequests) {
      if (request.code === code && (request.hostSocketId === socket.id || request.controllerSocketId === socket.id)) {
        clearRequest(requestId, 'channel-left');
      }
    }
  });

  socket.on('disconnect', () => {
    endSessionsForUser(socket.user.id, 'disconnected');
    remoteControlRateLimits.delete(socket.user.id);
  });
};

module.exports.constants = {
  REQUEST_TTL_MS,
  SESSION_TTL_MS,
  SETUP_TTL_MS,
  MAX_REQUESTS_PER_MINUTE,
};
