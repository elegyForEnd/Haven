'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registerDrawing = require('./drawing');

class FakeDatabase {
  constructor() {
    this.channels = new Map([
      [1, { id: 1, code: 'a1b2c3d4', name: 'general', is_dm: 0 }],
    ]);
    this.memberships = new Set(['1:10', '1:20']);
  }

  prepare(sql) {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();
    return {
      get: (...parameters) => {
        if (normalizedSql.includes('FROM channels WHERE code = ?')) {
          return Array.from(this.channels.values()).find(
            (channel) => channel.code === parameters[0]
          );
        }
        if (normalizedSql.includes('FROM channels WHERE id = ?')) {
          return this.channels.get(Number(parameters[0]));
        }
        if (normalizedSql.includes('FROM channel_members')) {
          return this.memberships.has(`${parameters[0]}:${parameters[1]}`) ? { allowed: 1 } : undefined;
        }
        throw new Error(`Unsupported get query: ${normalizedSql}`);
      },
      run: (...parameters) => {
        if (normalizedSql.startsWith('INSERT OR IGNORE INTO channel_members')) {
          this.memberships.add(`${parameters[0]}:${parameters[1]}`);
          return { changes: 1 };
        }
        throw new Error(`Unsupported run query: ${normalizedSql}`);
      },
    };
  }

  close() {}
}

class FakeSocket {
  constructor(io, id, user) {
    this.io = io;
    this.id = id;
    this.user = user;
    this.connected = true;
    this.rooms = new Set([id]);
    this.handlers = new Map();
    this.receivedEvents = [];
    this.drawingChannelId = null;
    io.sockets.sockets.set(id, this);
  }

  on(eventName, handler) {
    this.handlers.set(eventName, handler);
  }

  emit(eventName, payload) {
    this.receivedEvents.push({ eventName, payload });
  }

  join(roomName) {
    this.rooms.add(roomName);
  }

  leave(roomName) {
    this.rooms.delete(roomName);
  }

  to(roomName) {
    return this.io.createRoomEmitter(roomName, this.id);
  }

  trigger(eventName, payload) {
    const handler = this.handlers.get(eventName);
    assert.ok(handler, `Missing handler for ${eventName}`);
    handler(payload);
  }

  eventsNamed(eventName) {
    return this.receivedEvents.filter((event) => event.eventName === eventName);
  }
}

class FakeIo {
  constructor() {
    const socketMap = new Map();
    this.sockets = { sockets: socketMap };
    this.namespace = { sockets: socketMap };
  }

  of() {
    return this.namespace;
  }

  to(roomName) {
    return this.createRoomEmitter(roomName, null);
  }

  in(roomName) {
    return {
      socketsLeave: () => {
        for (const socket of this.sockets.sockets.values()) socket.leave(roomName);
      },
    };
  }

  createRoomEmitter(roomName, excludedSocketId) {
    return {
      emit: (eventName, payload) => {
        for (const socket of this.sockets.sockets.values()) {
          if (socket.id === excludedSocketId || !socket.rooms.has(roomName)) continue;
          socket.emit(eventName, payload);
        }
      },
    };
  }
}

function createDrawingFixture() {
  const database = new FakeDatabase();
  const io = new FakeIo();
  const state = {
    drawingBoards: new Map(),
    drawingParticipants: new Map(),
    drawingStateSyncLimits: new Map(),
  };

  return { database, io, state };
}

function registerDrawingSocket(fixture, socketId, user) {
  const socket = new FakeSocket(fixture.io, socketId, user);
  registerDrawing(socket, {
    io: fixture.io,
    db: fixture.database,
    state: fixture.state,
  });
  return socket;
}

test('drawing board synchronizes completed strokes and undo', () => {
  const fixture = createDrawingFixture();
  const firstSocket = registerDrawingSocket(fixture, 'socket-10', {
    id: 10,
    username: 'alice',
    displayName: 'Alice',
    isAdmin: false,
  });
  const secondSocket = registerDrawingSocket(fixture, 'socket-20', {
    id: 20,
    username: 'bob',
    displayName: 'Bob',
    isAdmin: false,
  });

  firstSocket.trigger('drawing-join', { code: 'a1b2c3d4' });
  secondSocket.trigger('drawing-join', { code: 'a1b2c3d4' });
  assert.equal(firstSocket.drawingChannelId, 1);
  assert.ok(firstSocket.rooms.has('drawing:1'));

  firstSocket.trigger('drawing-stroke-begin', {
    revision: 1,
    strokeId: 'stroke-alice-0001',
    tool: 'pen',
    color: '#ff4d8d',
    width: 5,
    point: { x: 0.1, y: 0.2, pressure: 0.5 },
  });
  firstSocket.trigger('drawing-stroke-points', {
    revision: 1,
    strokeId: 'stroke-alice-0001',
    points: [
      { x: 0.2, y: 0.3, pressure: 0.5 },
      { x: 0.3, y: 0.4, pressure: 0.7 },
    ],
  });
  firstSocket.trigger('drawing-stroke-end', {
    revision: 1,
    strokeId: 'stroke-alice-0001',
  });

  const board = fixture.state.drawingBoards.get(1);
  assert.equal(board.strokes.length, 1);
  assert.equal(board.strokes[0].points.length, 3);
  assert.equal(board.strokes[0].sequence, 1);
  assert.ok(secondSocket.eventsNamed('drawing-operation').some(
    (event) => event.payload.type === 'stroke-end' && event.payload.strokeId === 'stroke-alice-0001'
  ));

  firstSocket.trigger('drawing-undo');
  assert.equal(board.strokes.length, 0);
  assert.ok(secondSocket.eventsNamed('drawing-operation').some(
    (event) => event.payload.type === 'stroke-remove' && event.payload.strokeId === 'stroke-alice-0001'
  ));

  fixture.database.close();
});

test('drawing board bounds active strokes and rejects non-members', () => {
  const fixture = createDrawingFixture();
  const memberSocket = registerDrawingSocket(fixture, 'socket-10', {
    id: 10,
    username: 'alice',
    displayName: 'Alice',
    isAdmin: false,
  });
  const outsiderSocket = registerDrawingSocket(fixture, 'socket-30', {
    id: 30,
    username: 'mallory',
    displayName: 'Mallory',
    isAdmin: false,
  });

  outsiderSocket.trigger('drawing-join', { code: 'a1b2c3d4' });
  assert.equal(outsiderSocket.drawingChannelId, null);
  assert.equal(outsiderSocket.eventsNamed('drawing-error').length, 1);

  memberSocket.trigger('drawing-join', { code: 'a1b2c3d4' });
  for (const strokeId of ['stroke-active-001', 'stroke-active-002']) {
    memberSocket.trigger('drawing-stroke-begin', {
      revision: 1,
      strokeId,
      tool: 'pen',
      color: '#44aaff',
      width: 4,
      point: { x: 0.1, y: 0.1, pressure: 0.5 },
    });
  }
  memberSocket.trigger('drawing-stroke-begin', {
    revision: 1,
    strokeId: 'stroke-active-003',
    tool: 'pen',
    color: '#44aaff',
    width: 4,
    point: { x: 0.2, y: 0.2, pressure: 0.5 },
  });

  const board = fixture.state.drawingBoards.get(1);
  assert.equal(board.activeStrokes.size, 2);
  assert.ok(memberSocket.eventsNamed('drawing-error').some(
    (event) => event.payload.message === 'Too many drawing strokes are active.'
  ));

  fixture.database.close();
});

test('drawing state synchronization limit is shared across user connections', () => {
  const fixture = createDrawingFixture();
  const firstSocket = registerDrawingSocket(fixture, 'socket-10-a', {
    id: 10,
    username: 'alice',
    displayName: 'Alice',
    isAdmin: false,
  });
  const secondSocket = registerDrawingSocket(fixture, 'socket-10-b', {
    id: 10,
    username: 'alice',
    displayName: 'Alice',
    isAdmin: false,
  });

  for (let requestIndex = 0; requestIndex < 3; requestIndex += 1) {
    firstSocket.trigger('drawing-join', { code: 'a1b2c3d4' });
    secondSocket.trigger('drawing-join', { code: 'a1b2c3d4' });
  }
  firstSocket.trigger('drawing-join', { code: 'a1b2c3d4' });

  const latestError = firstSocket.eventsNamed('drawing-error').at(-1);
  assert.equal(latestError.payload.code, 'sync-rate-limited');
  assert.ok(latestError.payload.retryAfterMs > 0);

  fixture.database.close();
});

test('drawing composition order is fixed when each stroke begins', () => {
  const fixture = createDrawingFixture();
  const memberSocket = registerDrawingSocket(fixture, 'socket-10', {
    id: 10,
    username: 'alice',
    displayName: 'Alice',
    isAdmin: false,
  });
  memberSocket.trigger('drawing-join', { code: 'a1b2c3d4' });

  memberSocket.trigger('drawing-stroke-begin', {
    revision: 1,
    strokeId: 'stroke-started-first',
    tool: 'pen',
    color: '#ff4d8d',
    width: 5,
    point: { x: 0.1, y: 0.1, pressure: 0.5 },
  });
  memberSocket.trigger('drawing-stroke-begin', {
    revision: 1,
    strokeId: 'stroke-started-second',
    tool: 'eraser',
    color: '#000000',
    width: 10,
    point: { x: 0.2, y: 0.2, pressure: 0.5 },
  });
  memberSocket.trigger('drawing-stroke-end', {
    revision: 1,
    strokeId: 'stroke-started-second',
  });
  memberSocket.trigger('drawing-stroke-end', {
    revision: 1,
    strokeId: 'stroke-started-first',
  });

  const board = fixture.state.drawingBoards.get(1);
  assert.deepEqual(board.strokes.map((stroke) => stroke.id), [
    'stroke-started-first',
    'stroke-started-second',
  ]);
  assert.deepEqual(board.strokes.map((stroke) => stroke.sequence), [1, 2]);

  fixture.database.close();
});

test('drawing session is revoked when channel membership disappears', () => {
  const fixture = createDrawingFixture();
  const memberSocket = registerDrawingSocket(fixture, 'socket-10', {
    id: 10,
    username: 'alice',
    displayName: 'Alice',
    isAdmin: false,
  });
  memberSocket.trigger('drawing-join', { code: 'a1b2c3d4' });
  fixture.database.memberships.delete('1:10');

  memberSocket.trigger('drawing-sync-request');

  assert.equal(memberSocket.drawingChannelId, null);
  assert.ok(memberSocket.eventsNamed('drawing-access-revoked').some(
    (event) => event.payload.channelId === 1
  ));
  assert.ok(!memberSocket.rooms.has('drawing:1'));

  fixture.database.close();
});
