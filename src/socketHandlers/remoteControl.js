'use strict';

const crypto = require('crypto');
const { isInt, isString } = require('./helpers');

const REQUEST_TTL_MS = 30_000;
const SESSION_TTL_MS = 30 * 60_000;
const MAX_SIGNAL_BYTES = 64 * 1024;
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
    emitToUser(session.code, session.hostId, 'remote-control-session-ended', payload);
    emitToUser(session.code, session.controllerId, 'remote-control-session-ended', payload);
  }

  function endSessionsForUser(userId, reason) {
    for (const [sessionId, session] of remoteControlSessions) {
      if (session.hostId === userId || session.controllerId === userId) {
        endSession(sessionId, reason, userId);
      }
    }
    for (const [requestId, request] of remoteControlRequests) {
      if (request.hostId === userId || request.controllerId === userId) {
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

  socket.on('remote-control-capability', (data = {}) => {
    socket.remoteControlCapability = {
      hostSupported: data.hostSupported === true,
      controllerSupported: data.controllerSupported !== false,
      platform: isString(data.platform, 1, 24) ? data.platform : 'web',
      version: isString(data.version, 1, 24) ? data.version : '1',
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
    if (hostSocket.remoteControlCapability?.hostSupported !== true) {
      return safeCallback(callback, { error: 'The computer to be controlled needs Haven Desktop on Windows' });
    }
    if (controllerSocket.remoteControlCapability?.controllerSupported === false) {
      return safeCallback(callback, { error: 'That client cannot control a remote screen' });
    }

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
      initiatorId: socket.user.id,
      responderId: targetUserId,
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
    if (!isActiveChannelMember(request.code, request.hostId) ||
        !isActiveChannelMember(request.code, request.controllerId)) {
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
      createdAt: Date.now(),
      timer: null,
    };
    session.timer = setTimeout(() => endSession(sessionId, 'expired'), SESSION_TTL_MS);
    session.timer.unref?.();
    remoteControlSessions.set(sessionId, session);

    const hostSocket = liveSocketFor(request.code, request.hostId);
    const controllerSocket = liveSocketFor(request.code, request.controllerId);
    const hostName = hostSocket?.user?.displayName || 'Host';
    const controllerName = controllerSocket?.user?.displayName || 'Controller';
    hostSocket?.emit('remote-control-session-start', {
      sessionId,
      channelCode: request.code,
      role: 'host',
      peer: { id: request.controllerId, username: controllerName },
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    controllerSocket?.emit('remote-control-session-start', {
      sessionId,
      channelCode: request.code,
      role: 'controller',
      peer: { id: request.hostId, username: hostName },
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    safeCallback(callback, { ok: true, sessionId });
  });

  socket.on('remote-control-signal', (data) => {
    if (!data || typeof data !== 'object' || !isString(data.sessionId, 1, 64)) return;
    const session = remoteControlSessions.get(data.sessionId);
    if (!session || session.code !== socket.currentChannel) return;
    const isHost = socket.user.id === session.hostId;
    const isController = socket.user.id === session.controllerId;
    if (!isHost && !isController) return;
    const targetUserId = isHost ? session.controllerId : session.hostId;
    let serialized;
    try { serialized = JSON.stringify({ description: data.description, candidate: data.candidate }); }
    catch { return; }
    if (serialized.length > MAX_SIGNAL_BYTES) return;
    emitToUser(session.code, targetUserId, 'remote-control-signal', {
      sessionId: session.id,
      fromUserId: socket.user.id,
      description: data.description || null,
      candidate: data.candidate || null,
    });
  });

  socket.on('remote-control-end', (data = {}) => {
    if (!isString(data.sessionId, 1, 64)) return;
    const session = remoteControlSessions.get(data.sessionId);
    if (!session) return;
    if (socket.user.id !== session.hostId && socket.user.id !== session.controllerId) return;
    endSession(session.id, isString(data.reason, 1, 48) ? data.reason : 'ended', socket.user.id);
  });

  socket.on('enter-channel', (data = {}) => {
    const nextCode = isString(data.code, 8, 8) ? data.code : '';
    for (const session of remoteControlSessions.values()) {
      if ((session.hostId === socket.user.id || session.controllerId === socket.user.id) && session.code !== nextCode) {
        endSession(session.id, 'channel-changed', socket.user.id);
      }
    }
    for (const [requestId, request] of remoteControlRequests) {
      if ((request.hostId === socket.user.id || request.controllerId === socket.user.id) && request.code !== nextCode) {
        clearRequest(requestId, 'channel-changed');
      }
    }
  });

  socket.on('leave-channel', (data = {}) => {
    const code = isString(data.code, 8, 8) ? data.code : '';
    if (!code) return;
    for (const [sessionId, session] of remoteControlSessions) {
      if (session.code === code && (session.hostId === socket.user.id || session.controllerId === socket.user.id)) {
        endSession(sessionId, 'channel-left', socket.user.id);
      }
    }
    for (const [requestId, request] of remoteControlRequests) {
      if (request.code === code && (request.hostId === socket.user.id || request.controllerId === socket.user.id)) {
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
  MAX_SIGNAL_BYTES,
  MAX_REQUESTS_PER_MINUTE,
};
