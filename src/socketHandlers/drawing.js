'use strict';

const DRAWING_ROOM_PREFIX = 'drawing:';
const VALID_CHANNEL_CODE = /^[a-f0-9]{8}$/i;
const VALID_STROKE_ID = /^[A-Za-z0-9:_-]{8,96}$/;
const VALID_COLOR = /^#[0-9a-f]{6}$/i;
const VALID_TOOLS = new Set(['pen', 'eraser']);

const MAX_STROKES_PER_BOARD = 300;
const MAX_POINTS_PER_BOARD = 12000;
const MAX_POINTS_PER_STROKE = 800;
const MAX_POINTS_PER_PACKET = 64;
const MAX_ACTIVE_STROKES_PER_SOCKET = 2;
const MAX_ACTIVE_STROKES_PER_BOARD = 32;
const MAX_PACKET_BYTES = 16 * 1024;

const DRAWING_RATE_WINDOW_MS = 1000;
const MAX_EVENTS_PER_WINDOW = 45;
const MAX_POINTS_PER_WINDOW = 1800;
const MAX_BYTES_PER_WINDOW = 96 * 1024;
const STATE_SYNC_WINDOW_MS = 10000;
const MAX_STATE_SYNCS_PER_WINDOW = 6;

function createDrawingBoard(channelId) {
  return {
    channelId,
    revision: 1,
    nextSequence: 1,
    strokes: [],
    activeStrokes: new Map(),
    totalPointCount: 0,
    updatedAt: Date.now(),
    lastParticipantPruneAt: 0,
  };
}

function serializeDrawingStroke(stroke) {
  return {
    id: stroke.id,
    authorId: stroke.authorId,
    authorName: stroke.authorName,
    tool: stroke.tool,
    color: stroke.color,
    width: stroke.width,
    points: stroke.points,
    sequence: stroke.sequence || 0,
  };
}

function normalizePoint(point) {
  if (!point || typeof point !== 'object') return null;

  const normalizedX = Number(point.x);
  const normalizedY = Number(point.y);
  const pressure = Number(point.pressure);

  if (!Number.isFinite(normalizedX) || !Number.isFinite(normalizedY)) return null;
  if (normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) return null;

  return {
    x: Math.round(normalizedX * 100000) / 100000,
    y: Math.round(normalizedY * 100000) / 100000,
    pressure: Number.isFinite(pressure)
      ? Math.round(Math.max(0, Math.min(1, pressure)) * 1000) / 1000
      : 0.5,
  };
}

module.exports = function registerDrawing(socket, context) {
  const { io, db, state } = context;
  const { drawingBoards, drawingParticipants, drawingStateSyncLimits } = state;

  const rateState = {
    windowStartedAt: Date.now(),
    eventCount: 0,
    pointCount: 0,
    byteCount: 0,
    blockedUntil: 0,
  };
  function emitDrawingError(message, options = {}) {
    socket.emit('drawing-error', {
      message,
      resync: options.resync === true,
      code: options.code || null,
      retryAfterMs: Number(options.retryAfterMs) || 0,
    });
  }

  function consumeDrawingRate(payload, pointCount = 0) {
    const now = Date.now();
    if (now < rateState.blockedUntil) {
      return { allowed: false, newlyBlocked: false };
    }
    if (now - rateState.windowStartedAt >= DRAWING_RATE_WINDOW_MS) {
      rateState.windowStartedAt = now;
      rateState.eventCount = 0;
      rateState.pointCount = 0;
      rateState.byteCount = 0;
    }

    let payloadBytes = 0;
    try {
      payloadBytes = Buffer.byteLength(JSON.stringify(payload || {}), 'utf8');
    } catch {
      rateState.blockedUntil = now + 2000;
      return { allowed: false, newlyBlocked: true };
    }

    if (payloadBytes > MAX_PACKET_BYTES) {
      rateState.blockedUntil = now + 2000;
      return { allowed: false, newlyBlocked: true };
    }

    rateState.eventCount += 1;
    rateState.pointCount += pointCount;
    rateState.byteCount += payloadBytes;

    const allowed = rateState.eventCount <= MAX_EVENTS_PER_WINDOW &&
      rateState.pointCount <= MAX_POINTS_PER_WINDOW &&
      rateState.byteCount <= MAX_BYTES_PER_WINDOW;
    if (!allowed) rateState.blockedUntil = now + 2000;
    return { allowed, newlyBlocked: !allowed };
  }

  function consumeStateSyncRate() {
    const now = Date.now();
    const userId = socket.user.id;
    const recentTimestamps = (drawingStateSyncLimits.get(userId) || []).filter(
      (timestamp) => now - timestamp < STATE_SYNC_WINDOW_MS
    );
    if (recentTimestamps.length >= MAX_STATE_SYNCS_PER_WINDOW) {
      drawingStateSyncLimits.set(userId, recentTimestamps);
      return {
        allowed: false,
        retryAfterMs: Math.max(250, STATE_SYNC_WINDOW_MS - (now - recentTimestamps[0]) + 50),
      };
    }
    recentTimestamps.push(now);
    drawingStateSyncLimits.set(userId, recentTimestamps);
    return { allowed: true, retryAfterMs: 0 };
  }

  function resolveAccessibleChannel(channelCode) {
    if (typeof channelCode !== 'string') return null;
    const normalizedCode = channelCode.trim();
    if (!VALID_CHANNEL_CODE.test(normalizedCode)) return null;

    const channel = db.prepare(
      'SELECT id, code, name, is_dm FROM channels WHERE code = ?'
    ).get(normalizedCode);
    if (!channel) return null;

    let membership = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, socket.user.id);

    // Administrators already receive this behavior when entering normal
    // channels. Mirror it here so opening the board cannot fail before the
    // regular enter-channel event has repaired an older membership row.
    if (!membership && socket.user.isAdmin && !channel.is_dm) {
      db.prepare(
        'INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)'
      ).run(channel.id, socket.user.id);
      membership = { allowed: 1 };
    }

    return membership ? channel : null;
  }

  function getActiveDrawingSession() {
    const channelId = Number(socket.drawingChannelId);
    if (!Number.isInteger(channelId) || channelId <= 0) return null;

    const channel = db.prepare(
      'SELECT id, code, name, is_dm FROM channels WHERE id = ?'
    ).get(channelId);
    if (!channel) {
      revokeCurrentDrawingSession(channelId);
      return null;
    }

    const membership = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channelId, socket.user.id);
    if (!membership && !(socket.user.isAdmin && !channel.is_dm)) {
      revokeCurrentDrawingSession(channelId);
      return null;
    }

    const board = drawingBoards.get(channelId);
    if (!board) {
      revokeCurrentDrawingSession(channelId);
      return null;
    }

    return { channel, board };
  }

  function getOrCreateDrawingBoard(channelId) {
    let board = drawingBoards.get(channelId);
    if (!board) {
      board = createDrawingBoard(channelId);
      drawingBoards.set(channelId, board);
    }
    return board;
  }

  function getDrawingRoom(channelId) {
    return `${DRAWING_ROOM_PREFIX}${channelId}`;
  }

  function revokeCurrentDrawingSession(channelId) {
    const board = drawingBoards.get(channelId);
    const canceledStrokeIds = [];
    if (board) {
      for (const [strokeId, stroke] of board.activeStrokes) {
        if (stroke.ownerSocketId !== socket.id) continue;
        board.activeStrokes.delete(strokeId);
        canceledStrokeIds.push(strokeId);
      }
    }

    socket.leave(getDrawingRoom(channelId));
    const participants = drawingParticipants.get(channelId);
    if (participants) {
      participants.delete(socket.id);
      if (participants.size === 0) drawingParticipants.delete(channelId);
    }
    if (socket.drawingChannelId === channelId) socket.drawingChannelId = null;
    socket.emit('drawing-access-revoked', { channelId });

    if (canceledStrokeIds.length) {
      io.to(getDrawingRoom(channelId)).emit('drawing-operation', {
        channelId,
        revision: board?.revision || 1,
        type: 'strokes-canceled',
        strokeIds: canceledStrokeIds,
      });
    }
    broadcastDrawingParticipants(channelId);
  }

  function participantCanAccessChannel(participantSocket, channel) {
    if (!participantSocket?.user || !channel) return false;
    const membership = db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).get(channel.id, participantSocket.user.id);
    return !!membership || (participantSocket.user.isAdmin && !channel.is_dm);
  }

  function pruneUnauthorizedDrawingParticipants(channelId, forcePrune = false) {
    const participants = drawingParticipants.get(channelId);
    if (!participants?.size) return;

    const channel = db.prepare(
      'SELECT id, is_dm FROM channels WHERE id = ?'
    ).get(channelId);
    const board = drawingBoards.get(channelId);
    const now = Date.now();
    if (!forcePrune && board && now - board.lastParticipantPruneAt < 1000) return;
    if (board) board.lastParticipantPruneAt = now;
    const canceledStrokeIds = [];

    for (const socketId of Array.from(participants.keys())) {
      const participantSocket = io.of('/').sockets.get(socketId);
      if (participantSocket?.connected && participantCanAccessChannel(participantSocket, channel)) continue;

      participants.delete(socketId);
      if (board) {
        for (const [strokeId, stroke] of board.activeStrokes) {
          if (stroke.ownerSocketId !== socketId) continue;
          board.activeStrokes.delete(strokeId);
          canceledStrokeIds.push(strokeId);
        }
      }

      if (participantSocket) {
        participantSocket.leave(getDrawingRoom(channelId));
        if (participantSocket.drawingChannelId === channelId) participantSocket.drawingChannelId = null;
        participantSocket.emit('drawing-access-revoked', { channelId });
      }
    }

    if (participants.size === 0) drawingParticipants.delete(channelId);
    if (canceledStrokeIds.length) {
      io.to(getDrawingRoom(channelId)).emit('drawing-operation', {
        channelId,
        revision: board?.revision || 1,
        type: 'strokes-canceled',
        strokeIds: canceledStrokeIds,
      });
    }
  }

  function broadcastDrawingOperation(board, payload, excludeCurrentSocket = false) {
    pruneUnauthorizedDrawingParticipants(board.channelId, payload.type !== 'stroke-points');
    const room = getDrawingRoom(board.channelId);
    const emitter = excludeCurrentSocket ? socket.to(room) : io.to(room);
    emitter.emit('drawing-operation', {
      channelId: board.channelId,
      revision: board.revision,
      ...payload,
    });
  }

  function broadcastDrawingParticipants(channelId) {
    pruneUnauthorizedDrawingParticipants(channelId, true);
    const participants = drawingParticipants.get(channelId);
    const uniqueUsers = new Map();

    if (participants) {
      for (const participant of participants.values()) {
        if (!uniqueUsers.has(participant.userId)) {
          uniqueUsers.set(participant.userId, {
            id: participant.userId,
            username: participant.username,
          });
        }
      }
    }

    io.to(getDrawingRoom(channelId)).emit('drawing-users-update', {
      channelId,
      users: Array.from(uniqueUsers.values()),
    });
  }

  function sendDrawingState(board, channel) {
    const lastSequence = Math.max(0, board.nextSequence - 1);
    socket.emit('drawing-state-start', {
      channelId: channel.id,
      channelCode: channel.code,
      channelName: channel.name,
      revision: board.revision,
      sequence: lastSequence,
      strokeCount: board.strokes.length,
      activeStrokeCount: board.activeStrokes.size,
    });

    // Send each stroke separately so a large board never exceeds Socket.IO's
    // configured per-message buffer limit.
    for (const stroke of board.strokes) {
      socket.emit('drawing-state-stroke', {
        channelId: channel.id,
        active: false,
        stroke: serializeDrawingStroke(stroke),
      });
    }
    for (const stroke of board.activeStrokes.values()) {
      socket.emit('drawing-state-stroke', {
        channelId: channel.id,
        active: true,
        stroke: serializeDrawingStroke(stroke),
      });
    }

    socket.emit('drawing-state-end', {
      channelId: channel.id,
      revision: board.revision,
      sequence: lastSequence,
    });
  }

  function trimDrawingBoard(board) {
    const removedStrokeIds = [];
    while (
      board.strokes.length > MAX_STROKES_PER_BOARD ||
      board.totalPointCount > MAX_POINTS_PER_BOARD
    ) {
      const removedStroke = board.strokes.shift();
      if (!removedStroke) break;
      board.totalPointCount = Math.max(0, board.totalPointCount - removedStroke.points.length);
      removedStrokeIds.push(removedStroke.id);
    }
    return removedStrokeIds;
  }

  function commitActiveStroke(board, stroke) {
    board.activeStrokes.delete(stroke.id);
    if (!stroke.points.length) return [];

    if (!Number.isInteger(stroke.sequence) || stroke.sequence <= 0) {
      stroke.sequence = board.nextSequence;
      board.nextSequence += 1;
    }
    board.strokes.push(stroke);
    board.strokes.sort((firstStroke, secondStroke) => firstStroke.sequence - secondStroke.sequence);
    board.totalPointCount += stroke.points.length;
    board.updatedAt = Date.now();

    broadcastDrawingOperation(board, {
      sequence: stroke.sequence,
      type: 'stroke-end',
      strokeId: stroke.id,
    });

    const removedStrokeIds = trimDrawingBoard(board);
    if (removedStrokeIds.length) {
      broadcastDrawingOperation(board, {
        sequence: Math.max(0, board.nextSequence - 1),
        type: 'strokes-removed',
        strokeIds: removedStrokeIds,
      });
    }

    return removedStrokeIds;
  }

  function discardActiveStroke(board, strokeId) {
    if (!board.activeStrokes.delete(strokeId)) return;
    broadcastDrawingOperation(board, {
      type: 'strokes-canceled',
      strokeIds: [strokeId],
    });
  }

  function finalizeSocketStrokes(board) {
    const ownedStrokes = Array.from(board.activeStrokes.values())
      .filter((stroke) => stroke.ownerSocketId === socket.id);
    for (const stroke of ownedStrokes) commitActiveStroke(board, stroke);
  }

  function leaveDrawingSession(options = {}) {
    const channelId = Number(socket.drawingChannelId);
    if (!Number.isInteger(channelId) || channelId <= 0) return;

    const board = drawingBoards.get(channelId);
    const activeSession = getActiveDrawingSession();
    if (board && activeSession && options.finalizeStrokes !== false) {
      finalizeSocketStrokes(board);
    } else if (board) {
      const ownedStrokeIds = Array.from(board.activeStrokes.values())
        .filter((stroke) => stroke.ownerSocketId === socket.id)
        .map((stroke) => stroke.id);
      for (const strokeId of ownedStrokeIds) discardActiveStroke(board, strokeId);
    }

    socket.leave(getDrawingRoom(channelId));
    const participants = drawingParticipants.get(channelId);
    if (participants) {
      participants.delete(socket.id);
      if (participants.size === 0) drawingParticipants.delete(channelId);
    }

    socket.drawingChannelId = null;
    broadcastDrawingParticipants(channelId);
  }

  socket.on('drawing-join', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const syncRate = consumeStateSyncRate();
    if (!syncRate.allowed) {
      emitDrawingError('Drawing state was requested too frequently.', {
        code: 'sync-rate-limited',
        retryAfterMs: syncRate.retryAfterMs,
      });
      return;
    }
    const channel = resolveAccessibleChannel(payload.code);
    if (!channel) {
      const normalizedCode = typeof payload.code === 'string' ? payload.code.trim() : '';
      const existingChannel = VALID_CHANNEL_CODE.test(normalizedCode)
        ? db.prepare('SELECT id FROM channels WHERE code = ?').get(normalizedCode)
        : null;
      emitDrawingError('You are not allowed to open this channel drawing board.', {
        code: existingChannel ? 'access-revoked' : 'board-unavailable',
      });
      return;
    }

    if (socket.drawingChannelId && socket.drawingChannelId !== channel.id) {
      leaveDrawingSession({ finalizeStrokes: true });
    }

    const board = getOrCreateDrawingBoard(channel.id);
    socket.drawingChannelId = channel.id;
    socket.join(getDrawingRoom(channel.id));

    if (!drawingParticipants.has(channel.id)) drawingParticipants.set(channel.id, new Map());
    drawingParticipants.get(channel.id).set(socket.id, {
      userId: socket.user.id,
      username: socket.user.displayName || socket.user.username,
      joinedAt: Date.now(),
    });

    sendDrawingState(board, channel);
    broadcastDrawingParticipants(channel.id);
  });

  socket.on('drawing-leave', () => {
    leaveDrawingSession({ finalizeStrokes: true });
  });

  socket.on('drawing-sync-request', () => {
    const syncRate = consumeStateSyncRate();
    if (!syncRate.allowed) {
      emitDrawingError('Drawing state was requested too frequently.', {
        code: 'sync-rate-limited',
        retryAfterMs: syncRate.retryAfterMs,
      });
      return;
    }
    const session = getActiveDrawingSession();
    if (!session) {
      emitDrawingError('Drawing session is no longer available.');
      return;
    }
    sendDrawingState(session.board, session.channel);
  });

  socket.on('drawing-stroke-begin', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const drawingRate = consumeDrawingRate(payload, 1);
    if (!drawingRate.allowed) {
      if (drawingRate.newlyBlocked) {
        emitDrawingError('Drawing data is being sent too quickly.', { resync: true });
      }
      return;
    }

    const session = getActiveDrawingSession();
    if (!session) {
      emitDrawingError('Drawing session is no longer available.', { resync: true });
      return;
    }

    const { board } = session;
    if (Number(payload.revision) !== board.revision) {
      emitDrawingError('The drawing board changed. Synchronizing the latest version.', { resync: true });
      return;
    }

    const strokeId = typeof payload.strokeId === 'string' ? payload.strokeId.trim() : '';
    const tool = typeof payload.tool === 'string' ? payload.tool : '';
    const color = typeof payload.color === 'string' ? payload.color.toLowerCase() : '';
    const width = Number(payload.width);
    const point = normalizePoint(payload.point);

    if (!VALID_STROKE_ID.test(strokeId) || !VALID_TOOLS.has(tool) || !point) {
      emitDrawingError('Invalid drawing stroke.');
      return;
    }
    if (!Number.isFinite(width) || width < 1 || width > 48) {
      emitDrawingError('Invalid drawing width.');
      return;
    }
    if (tool === 'pen' && !VALID_COLOR.test(color)) {
      emitDrawingError('Invalid drawing color.');
      return;
    }
    if (board.activeStrokes.has(strokeId) || board.strokes.some((stroke) => stroke.id === strokeId)) {
      emitDrawingError('Duplicate drawing stroke.');
      return;
    }

    const socketActiveStrokeCount = Array.from(board.activeStrokes.values())
      .filter((stroke) => stroke.ownerSocketId === socket.id).length;
    if (
      socketActiveStrokeCount >= MAX_ACTIVE_STROKES_PER_SOCKET ||
      board.activeStrokes.size >= MAX_ACTIVE_STROKES_PER_BOARD
    ) {
      emitDrawingError('Too many drawing strokes are active.', { resync: true });
      return;
    }

    const stroke = {
      id: strokeId,
      authorId: socket.user.id,
      authorName: socket.user.displayName || socket.user.username,
      ownerSocketId: socket.id,
      tool,
      color: tool === 'eraser' ? '#000000' : color,
      width: Math.round(width * 10) / 10,
      points: [point],
      sequence: board.nextSequence,
    };
    board.nextSequence += 1;
    board.activeStrokes.set(strokeId, stroke);
    board.updatedAt = Date.now();

    broadcastDrawingOperation(board, {
      type: 'stroke-begin',
      stroke: serializeDrawingStroke(stroke),
    });
  });

  socket.on('drawing-stroke-points', (payload) => {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.points)) return;
    if (payload.points.length === 0 || payload.points.length > MAX_POINTS_PER_PACKET) {
      emitDrawingError('Invalid drawing point batch.');
      return;
    }
    const drawingRate = consumeDrawingRate(payload, payload.points.length);
    if (!drawingRate.allowed) {
      if (drawingRate.newlyBlocked) {
        const activeSession = getActiveDrawingSession();
        const strokeId = typeof payload.strokeId === 'string' ? payload.strokeId.trim() : '';
        if (activeSession && strokeId) discardActiveStroke(activeSession.board, strokeId);
        emitDrawingError('Drawing data is being sent too quickly.', { resync: true });
      }
      return;
    }

    const session = getActiveDrawingSession();
    if (!session) {
      emitDrawingError('Drawing session is no longer available.', { resync: true });
      return;
    }

    const { board } = session;
    if (Number(payload.revision) !== board.revision) {
      emitDrawingError('The drawing board changed. Synchronizing the latest version.', { resync: true });
      return;
    }

    const strokeId = typeof payload.strokeId === 'string' ? payload.strokeId.trim() : '';
    const stroke = board.activeStrokes.get(strokeId);
    if (!stroke || stroke.ownerSocketId !== socket.id) {
      emitDrawingError('Drawing stroke is no longer active.', { resync: true });
      return;
    }

    const normalizedPoints = payload.points.map(normalizePoint);
    if (normalizedPoints.some((point) => point === null)) {
      discardActiveStroke(board, strokeId);
      emitDrawingError('Invalid drawing point.', { resync: true });
      return;
    }

    const availablePointSlots = MAX_POINTS_PER_STROKE - stroke.points.length;
    if (availablePointSlots <= 0) return;
    const acceptedPoints = normalizedPoints.slice(0, availablePointSlots);
    stroke.points.push(...acceptedPoints);
    board.updatedAt = Date.now();

    broadcastDrawingOperation(board, {
      type: 'stroke-points',
      strokeId,
      points: acceptedPoints,
    }, true);
  });

  socket.on('drawing-stroke-end', (payload) => {
    if (!payload || typeof payload !== 'object') return;

    const session = getActiveDrawingSession();
    if (!session) {
      emitDrawingError('Drawing session is no longer available.', { resync: true });
      return;
    }

    const { board } = session;
    const strokeId = typeof payload.strokeId === 'string' ? payload.strokeId.trim() : '';
    const stroke = board.activeStrokes.get(strokeId);
    if (!stroke || stroke.ownerSocketId !== socket.id) return;

    commitActiveStroke(board, stroke);
  });

  socket.on('drawing-undo', () => {
    const session = getActiveDrawingSession();
    if (!session) {
      emitDrawingError('Drawing session is no longer available.', { resync: true });
      return;
    }

    const { board } = session;
    let strokeIndex = -1;
    for (let index = board.strokes.length - 1; index >= 0; index -= 1) {
      if (board.strokes[index].authorId === socket.user.id) {
        strokeIndex = index;
        break;
      }
    }
    if (strokeIndex < 0) {
      emitDrawingError('You do not have a stroke to undo.');
      return;
    }

    const [removedStroke] = board.strokes.splice(strokeIndex, 1);
    board.totalPointCount = Math.max(0, board.totalPointCount - removedStroke.points.length);
    const sequence = board.nextSequence;
    board.nextSequence += 1;
    board.updatedAt = Date.now();

    broadcastDrawingOperation(board, {
      sequence,
      type: 'stroke-remove',
      strokeId: removedStroke.id,
    });
  });

  socket.on('drawing-clear', () => {
    const session = getActiveDrawingSession();
    if (!session) {
      emitDrawingError('Drawing session is no longer available.', { resync: true });
      return;
    }
    if (!socket.user.isAdmin) {
      emitDrawingError('Only administrators can clear the channel drawing board.');
      return;
    }

    const { board } = session;
    board.revision += 1;
    board.nextSequence = 1;
    board.strokes = [];
    board.activeStrokes.clear();
    board.totalPointCount = 0;
    board.updatedAt = Date.now();

    broadcastDrawingOperation(board, {
      sequence: 0,
      type: 'board-clear',
    });
  });

  socket.on('disconnect', () => {
    leaveDrawingSession({ finalizeStrokes: true });
  });
};
