'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_SDP_SIZE,
  NATIVE_SCREEN_SIGNAL_EVENTS,
  clearNativeScreenOfferWindows,
  nativeScreenSignalFloodScope,
  registerNativeScreenSignaling,
} = require('../src/socketHandlers/nativeScreen');
const registerVoiceHandlers = require('../src/socketHandlers/voice');

function createHarness({ senderId = 1, sharerId = 1, offerWindows = new Map() } = {}) {
  const handlers = new Map();
  const emitted = [];
  const socket = {
    id: `socket-${senderId}`,
    user: { id: senderId, displayName: `User ${senderId}` },
    on(event, handler) { handlers.set(event, handler); },
  };
  const room = new Map([
    [1, { id: 1, socketId: 'socket-1', nativeScreenVersion: 2, nativeScreenCodecs: ['H264'] }],
    [2, { id: 2, socketId: 'socket-2', nativeScreenVersion: 2, nativeScreenCodecs: ['H264'] }],
  ]);
  const io = {
    to(socketId) {
      return { emit(event, payload) { emitted.push({ socketId, event, payload }); } };
    },
  };
  registerNativeScreenSignaling(socket, {
    io,
    voiceUsers: new Map([['a1b2c3d4', room]]),
    activeScreenSharers: new Map([['a1b2c3d4', new Set([sharerId])]]),
    activeScreenSessions: new Map([['a1b2c3d4', new Map([[
      sharerId,
      { transport: 'native', sessionId: 'native-session-1234', codec: 'H264' },
    ]])]]),
    nativeScreenOfferWindows: offerWindows,
  });
  return { handlers, emitted };
}

const base = {
  code: 'a1b2c3d4',
  targetUserId: 2,
  sessionId: 'native-session-1234',
  negotiationId: 'negotiation-1234',
};

test('dedicated native signaling limits apply only to registered events', () => {
  assert.equal(NATIVE_SCREEN_SIGNAL_EVENTS.has('native-screen-offer'), true);
  assert.equal(NATIVE_SCREEN_SIGNAL_EVENTS.has('native-screen-answer'), true);
  assert.equal(NATIVE_SCREEN_SIGNAL_EVENTS.has('native-screen-ice-candidate'), true);
  assert.equal(NATIVE_SCREEN_SIGNAL_EVENTS.has('native-screen-attacker-controlled'), false);
});

test('relays native screen offers only from the active sharer', () => {
  const accepted = createHarness();
  accepted.handlers.get('native-screen-offer')({
    ...base,
    offer: { type: 'offer', sdp: 'v=0' },
  });
  assert.deepEqual(accepted.emitted, [{
    socketId: 'socket-2',
    event: 'native-screen-offer',
    payload: {
      from: { id: 1, username: 'User 1' },
      channelCode: 'a1b2c3d4',
      sessionId: 'native-session-1234',
      negotiationId: 'negotiation-1234',
      offer: { type: 'offer', sdp: 'v=0' },
    },
  }]);

  const rejected = createHarness({ sharerId: 2 });
  rejected.handlers.get('native-screen-offer')({
    ...base,
    offer: { type: 'offer', sdp: 'v=0' },
  });
  assert.equal(rejected.emitted.length, 0);
});

test('native signal validation does not coerce hostile payload objects', () => {
  const malformed = {
    ...base,
    targetUserId: { toString: null, valueOf: null },
    sessionId: { toString: null, valueOf: null },
    negotiationId: { toString: null, valueOf: null },
    offer: { type: 'offer', sdp: 'v=0' },
  };
  const harness = createHarness();
  assert.doesNotThrow(() => harness.handlers.get('native-screen-offer')(malformed));
  assert.equal(harness.emitted.length, 0);

  const room = new Map([
    [1, { id: 1, socketId: 'socket-1' }],
    [2, { id: 2, socketId: 'socket-2' }],
  ]);
  const context = {
    socket: { id: 'socket-1', user: { id: 1 } },
    voiceUsers: new Map([['a1b2c3d4', room]]),
    activeScreenSessions: new Map([['a1b2c3d4', new Map([[
      1,
      { transport: 'native', sessionId: 'native-session-1234' },
    ]])]]),
  };
  assert.equal(nativeScreenSignalFloodScope('native-screen-offer', malformed, context), 'invalid');
  assert.equal(
    nativeScreenSignalFloodScope('native-screen-offer', base, context),
    'native-screen-offer:2:native-session-1234'
  );
  assert.equal(
    nativeScreenSignalFloodScope('native-screen-offer', { ...base, targetUserId: 999 }, context),
    'invalid'
  );

  const deeplyNested = {};
  let cursor = deeplyNested;
  for (let i = 0; i < 10000; i++) cursor = cursor.child = {};
  assert.doesNotThrow(() => harness.handlers.get('native-screen-offer')({
    ...base,
    offer: deeplyNested,
  }));
  assert.equal(harness.emitted.length, 0);
});

test('accepts gathered native SDP above the old limit and rejects oversized SDP', () => {
  const largeSdp = `v=0\r\n${'a=candidate:native-screen-candidate\r\n'.repeat(600)}`;
  assert.ok(largeSdp.length > 16384);

  const offerHarness = createHarness();
  offerHarness.handlers.get('native-screen-offer')({
    ...base,
    offer: { type: 'offer', sdp: largeSdp },
  });
  assert.equal(offerHarness.emitted.length, 1);

  const answerHarness = createHarness({ senderId: 2, sharerId: 1 });
  answerHarness.handlers.get('native-screen-answer')({
    ...base,
    targetUserId: 1,
    answer: { type: 'answer', sdp: largeSdp },
  });
  assert.equal(answerHarness.emitted.length, 1);

  const oversizedHarness = createHarness();
  oversizedHarness.handlers.get('native-screen-offer')({
    ...base,
    offer: { type: 'offer', sdp: 'x'.repeat(MAX_SDP_SIZE) },
  });
  assert.equal(oversizedHarness.emitted.length, 0);
});

test('rate limits repeated native offers to the same viewer', () => {
  const harness = createHarness();
  for (let index = 0; index < 12; index++) {
    harness.handlers.get('native-screen-offer')({
      ...base,
      negotiationId: `negotiation-${index}`,
      offer: { type: 'offer', sdp: 'v=0' },
    });
  }
  assert.equal(harness.emitted.length, 8);
});

test('native offer rate limits survive sender reconnection', () => {
  const offerWindows = new Map();
  const first = createHarness({ offerWindows });
  const second = createHarness({ offerWindows });
  for (let index = 0; index < 6; index++) {
    first.handlers.get('native-screen-offer')({
      ...base,
      negotiationId: `first-negotiation-${index}`,
      offer: { type: 'offer', sdp: 'v=0' },
    });
    second.handlers.get('native-screen-offer')({
      ...base,
      negotiationId: `second-negotiation-${index}`,
      offer: { type: 'offer', sdp: 'v=0' },
    });
  }
  assert.equal(first.emitted.length + second.emitted.length, 8);
});

test('native offer rate limits are released when either peer leaves voice', () => {
  const windows = new Map([
    ['1:2:a1b2c3d4', [1]],
    ['3:1:a1b2c3d4', [1]],
    ['3:2:a1b2c3d4', [1]],
    ['1:2:ffffffff', [1]],
  ]);

  clearNativeScreenOfferWindows(windows, 'a1b2c3d4', 1);

  assert.deepEqual([...windows.keys()], ['3:2:a1b2c3d4', '1:2:ffffffff']);
});

test('relays native screen answers only to the active sharer', () => {
  const accepted = createHarness({ senderId: 2, sharerId: 1 });
  accepted.handlers.get('native-screen-answer')({
    ...base,
    targetUserId: 1,
    answer: { type: 'answer', sdp: 'v=0' },
  });
  assert.equal(accepted.emitted.length, 1);
  assert.equal(accepted.emitted[0].socketId, 'socket-1');

  const rejected = createHarness({ senderId: 2, sharerId: 2 });
  rejected.handlers.get('native-screen-answer')({
    ...base,
    targetUserId: 1,
    answer: { type: 'answer', sdp: 'v=0' },
  });
  assert.equal(rejected.emitted.length, 0);
});

test('relays ICE in either direction and rejects stale session identifiers', () => {
  const viewer = createHarness({ senderId: 2, sharerId: 1 });
  viewer.handlers.get('native-screen-ice-candidate')({
    ...base,
    targetUserId: 1,
    candidate: { candidate: 'candidate:1', sdpMid: 'video0', sdpMLineIndex: 0 },
  });
  assert.equal(viewer.emitted.length, 1);

  const stale = createHarness();
  stale.handlers.get('native-screen-ice-candidate')({
    ...base,
    sessionId: 'native-session-old1',
    candidate: null,
  });
  assert.equal(stale.emitted.length, 0);
});

function createLifecycleHarness({
  socketId = 'socket-1', ownerSocketId = 'socket-1', streamsEnabled = 1, userId = 1, sharedState, channelMember = true,
} = {}) {
  const handlers = new Map();
  const emitted = [];
  const socket = {
    id: socketId,
    user: { id: userId, username: `User ${userId}`, displayName: `User ${userId}`, isAdmin: false },
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { emitted.push({ socketId, event, payload }); },
    join() {},
    leave() {},
  };
  const state = sharedState || {
    channelUsers: new Map(),
    voiceUsers: new Map([['a1b2c3d4', new Map([
      [1, { id: 1, username: 'User 1', socketId: ownerSocketId, nativeScreenVersion: 2, nativeScreenCodecs: ['H264'] }],
      [2, { id: 2, username: 'User 2', socketId: 'socket-2', nativeScreenVersion: 2, nativeScreenCodecs: ['H264'] }],
    ])]]),
    voiceLastActivity: new Map(),
    activeMusic: new Map(),
    activeScreenSharers: new Map(),
    activeScreenSessions: new Map(),
    activeWebcamUsers: new Map(),
    streamViewers: new Map(),
    pendingTempDelete: new Map(),
    pendingVoiceLeave: new Map(),
  };
  const chain = {
    to() { return chain; },
    emit(event, payload) { emitted.push({ socketId: 'room', event, payload }); },
  };
  const io = {
    sockets: { sockets: new Map() },
    to(target) {
      return {
        to() { return chain; },
        emit(event, payload) { emitted.push({ socketId: target, event, payload }); },
      };
    },
  };
  const db = {
    prepare(sql) {
      return {
        get(code) {
          if (sql.includes('SELECT id, is_dm FROM channels')) return { id: code, is_dm: 0 };
          if (sql.includes('FROM channel_members') && !channelMember) return undefined;
          return { streams_enabled: streamsEnabled, voice_bitrate: 0 };
        },
        all() { return []; },
        run() {},
      };
    },
  };
  registerVoiceHandlers(socket, {
    io,
    db,
    state,
    userHasPermission: () => true,
    getUserEffectiveLevel: () => 0,
    getUserHighestRole: () => null,
    broadcastVoiceUsers() {},
    emitOnlineUsers() {},
    handleVoiceLeave() {},
    touchVoiceActivity() {},
    pruneStaleVoiceUsers() {},
    getMentionableChannelMembers: () => [],
    getActiveMusicSyncState: () => null,
    getMusicQueuePayload: () => [],
  });
  return { handlers, emitted, state, io };
}

test('EasyTier limits credentials and IP visibility to authorized members and removes disconnected nodes', t => {
  const env = {
    HAVEN_EASYTIER_SECRET: 'a'.repeat(64),
    HAVEN_EASYTIER_NETWORK_PREFIX: 'b'.repeat(16),
    HAVEN_EASYTIER_HOST: 'example.test',
  };
  for (const [name, value] of Object.entries(env)) {
    const original = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
  }
  const host = createLifecycleHarness();
  const viewer = createLifecycleHarness({ socketId: 'socket-2', userId: 2, sharedState: host.state });
  const outsider = createLifecycleHarness({ socketId: 'outsider', userId: 3, channelMember: false, sharedState: host.state });
  const code = 'a1b2c3d4';
  const call = (client, event, extra = {}) => {
    let result;
    client.handlers.get(event)({ code, ...extra }, value => { result = value; });
    return result;
  };
  const hostVoice = call(host, 'voice-network');
  const viewerVoice = call(viewer, 'voice-network');
  assert.equal(hostVoice.name, viewerVoice.name);
  assert.notEqual(hostVoice.address, viewerVoice.address);
  assert.equal(call(outsider, 'voice-network'), null);
  assert.equal(call(outsider, 'manual-network', { join: true }), null);

  const manual = call(host, 'manual-network', { join: true }).config;
  assert.notEqual(manual.secret, hostVoice.secret);
  assert.match(manual.address, /^10\.243\./);
  assert.deepEqual(call(viewer, 'manual-network').members, []);
  call(host, 'manual-network', { ready: true });
  assert.deepEqual(call(viewer, 'manual-network').members, [{ name: 'User 1', address: manual.address }]);
  assert.equal(call(outsider, 'manual-network'), null);
  host.handlers.get('disconnect')();
  assert.deepEqual(call(viewer, 'manual-network').members, []);
});

test('GameStream queues viewer handshakes and revokes one viewer without stopping the others', () => {
  const host = createLifecycleHarness();
  host.state.voiceUsers.get('a1b2c3d4').set(3, { id: 3, socketId: 'socket-3' });
  const viewer = createLifecycleHarness({ socketId: 'socket-2', userId: 2, sharedState: host.state });
  const second = createLifecycleHarness({ socketId: 'socket-3', userId: 3, sharedState: host.state });
  const stale = createLifecycleHarness({ socketId: 'old-viewer', userId: 2, sharedState: host.state });
  const signal = { code: 'a1b2c3d4', sharerId: 1, sessionId: 'game-session-123' };
  const firstWatch = { ...signal, watchId: '00000000-0000-4000-8000-000000000001' };
  const secondWatch = { ...signal, watchId: '00000000-0000-4000-8000-000000000002' };
  const certificate = '-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n';
  const endpoint = { address: '192.168.1.2', basePort: 51000, certificate };
  const call = (harness, event, payload) => {
    let result;
    harness.handlers.get(event)(payload, value => { result = value; });
    return result;
  };
  assert.equal(call(host, 'screen-share-started', {
    ...signal, ...endpoint, transport: 'gamestream', videoMode: '1281x720x30',
  }).ok, false);
  assert.equal(call(host, 'screen-share-started', {
    ...signal, ...endpoint, transport: 'gamestream', bitrateKbps: 6000, videoMode: '1280x720x30',
  }).ok, true);
  assert.equal('endpoint' in host.emitted.find(item => item.event === 'screen-share-started').payload, false);
  assert.equal(call(stale, 'gamestream-watch', { ...firstWatch, certificate }), false);
  assert.equal(call(viewer, 'gamestream-watch', { ...firstWatch, certificate }), true);
  assert.equal(call(second, 'gamestream-watch', { ...secondWatch, certificate }), true);
  assert.equal(viewer.emitted.filter(item => item.event === 'gamestream-viewer-request').length +
    second.emitted.filter(item => item.event === 'gamestream-viewer-request').length, 1);
  assert.equal(call(viewer, 'gamestream-ready', { ...firstWatch, accepted: true }), false);
  assert.equal(call(host, 'gamestream-ready', { ...firstWatch, accepted: true }), true);
  assert.deepEqual(host.emitted.find(item => item.event === 'gamestream-connect'), {
    socketId: 'socket-2', event: 'gamestream-connect', payload: {
      ...firstWatch, endpoint: { ...endpoint, addresses: [endpoint.address], bitrateKbps: 6000, videoMode: '1280x720x30' },
      hasAudio: false,
    },
  });
  call(viewer, 'gamestream-playing', firstWatch);
  assert.equal(viewer.emitted.filter(item => item.event === 'gamestream-viewer-request').length, 2);
  assert.equal(call(host, 'gamestream-ready', { ...secondWatch, accepted: true }), true);
  call(second, 'gamestream-playing', secondWatch);
  assert.equal(call(second, 'gamestream-relay-request', secondWatch), true);
  const chunk = { ...signal, seq: 0, index: 0, count: 1, video: true, keyFrame: true,
    timestampUs: 1000, data: Buffer.from([1, 2, 3]) };
  assert.equal(call(viewer, 'gamestream-relay-data', chunk), false);
  assert.equal(call(host, 'gamestream-relay-data', { ...chunk, sessionId: 'stale-session' }), false);
  assert.equal(call(host, 'gamestream-relay-data', chunk), true);
  const recipients = host.emitted.filter(item => item.event === 'gamestream-relay-data');
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].socketId, 'socket-3');
  assert.equal(recipients[0].payload.watchId, secondWatch.watchId);
  assert.equal(call(viewer, 'gamestream-relay-request', firstWatch), true);
  const ws = { bufferedAmount: 0 };
  host.io.sockets.sockets.set('socket-3', { conn: { writeBuffer: [], transport: { socket: ws } } });
  const forwarded = seq => host.emitted.filter(item =>
    item.event === 'gamestream-relay-data' && item.payload.seq === seq).map(item => item.socketId);
  call(host, 'gamestream-relay-data', { ...chunk, seq: 1 });
  assert.deepEqual(forwarded(1), ['socket-2', 'socket-3']);
  ws.bufferedAmount = 256 * 1024;
  call(host, 'gamestream-relay-data', { ...chunk, seq: 2, keyFrame: false });
  assert.deepEqual(forwarded(2), ['socket-2']);
  ws.bufferedAmount = 0;
  call(host, 'gamestream-relay-data', { ...chunk, seq: 3, keyFrame: false });
  assert.deepEqual(forwarded(3), ['socket-2']);
  call(host, 'gamestream-relay-data', { ...chunk, seq: 4 });
  assert.deepEqual(forwarded(4), ['socket-2', 'socket-3']);
  const session = host.state.activeScreenSessions.get(signal.code).get(1);
  session.relayRate.bytes = 4 * 1024 * 1024;
  assert.deepEqual(call(host, 'gamestream-relay-data', { ...chunk, seq: 5 }),
    { ok: false, error: 'rate_limited' });
  session.relayRate.time = 0;
  assert.equal(call(host, 'gamestream-relay-data', { ...chunk, seq: 6 }), true);
  host.state.voiceUsers.get(signal.code).delete(2);
  assert.equal(call(host, 'gamestream-lease', signal), true);
  assert.equal(call(viewer, 'gamestream-lease', firstWatch), false);
  assert.equal(call(second, 'gamestream-lease', secondWatch), true);
  assert.equal(host.emitted.find(item => item.event === 'gamestream-viewer-revoke').payload.watchId, firstWatch.watchId);
  call(second, 'gamestream-unwatch', secondWatch);
  assert.equal(call(host, 'gamestream-relay-data', chunk), false);
  assert.equal(call(second, 'gamestream-watch', { ...secondWatch, certificate }), true);
  assert.deepEqual(call(host, 'screen-share-stopped', { ...signal, sessionId: 'old-game-session' }), { ok: false });
  assert.deepEqual(call(host, 'screen-share-stopped', signal), { ok: true });
  assert.equal(call(host, 'screen-share-started', { ...signal, ...endpoint,
    addresses: ['192.168.1.2', '192.168.200.1'], connectionMode: 'manual', transport: 'gamestream' }).ok, true);
  const configured = host.state.activeScreenSessions.get(signal.code).get(1).endpoint;
  assert.equal(configured.connectionMode, 'manual');
  assert.deepEqual(configured.addresses, [endpoint.address]);
});

test('GameStream ICE signaling stays with the authorized viewer and hides the host IP in relay mode', () => {
  const host = createLifecycleHarness();
  const viewer = createLifecycleHarness({ socketId: 'socket-2', userId: 2, sharedState: host.state });
  const stale = createLifecycleHarness({ socketId: 'old-viewer', userId: 2, sharedState: host.state });
  const signal = { code: 'a1b2c3d4', sharerId: 1, sessionId: 'game-session-ice' };
  const watch = { ...signal, watchId: '00000000-0000-4000-8000-000000000001' };
  const certificate = '-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n';
  const description = {
    ufrag: 'AbCd', password: 'a'.repeat(22), candidates: ['1 1 udp 1 192.0.2.1 55000 typ relay'],
  };
  const call = (harness, event, payload) => {
    let result;
    harness.handlers.get(event)(payload, value => { result = value; });
    return result;
  };
  assert.equal(call(host, 'screen-share-started', { ...signal, address: '192.168.1.5', basePort: 51000,
    certificate, connectionMode: 'relay', transport: 'gamestream' }).ok, true);
  assert.equal(call(viewer, 'gamestream-watch', { ...watch, certificate, iceVersion: 1 }), true);
  assert.equal(viewer.emitted.find(item => item.event === 'gamestream-viewer-request').payload.iceVersion, 1);
  assert.equal(call(viewer, 'gamestream-ice-answer', { ...watch, answer: description }), false);
  assert.equal(call(host, 'gamestream-ready', { ...watch, accepted: true, iceOffer: description }), true);
  assert.deepEqual(host.emitted.find(item => item.event === 'gamestream-connect').payload, {
    ...watch, endpoint: { connectionMode: 'relay', basePort: 51000, certificate }, iceOffer: description, hasAudio: false,
  });
  assert.equal(call(stale, 'gamestream-ice-answer', { ...watch, answer: description }), false);
  assert.equal(call(viewer, 'gamestream-ice-answer', { ...watch, answer: { ...description, candidates: [] } }), false);
  assert.equal(call(viewer, 'gamestream-ice-answer', { ...watch, answer: description }), true);
  assert.equal(call(viewer, 'gamestream-ice-answer', { ...watch, answer: description }), false);
  assert.deepEqual(viewer.emitted.filter(item => item.event === 'gamestream-ice-answer'), [{
    socketId: 'socket-1', event: 'gamestream-ice-answer',
    payload: { code: signal.code, sessionId: signal.sessionId, watchId: watch.watchId, answer: description },
  }]);
});

test('explicit GameStream tunnel modes require capable viewers and cannot fall back to Haven relay', () => {
  const host = createLifecycleHarness();
  const viewer = createLifecycleHarness({ socketId: 'socket-2', userId: 2, sharedState: host.state });
  const certificate = '-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n';
  const call = (harness, event, payload) => {
    let result;
    harness.handlers.get(event)(payload, value => { result = value; });
    return result;
  };
  const signal = { code: 'a1b2c3d4', sharerId: 1, sessionId: 'game-route-test' };
  const watch = { ...signal, watchId: '00000000-0000-4000-8000-000000000001' };
  const start = { ...signal, address: '192.168.1.5', basePort: 51000, certificate, transport: 'gamestream' };
  assert.equal(call(host, 'screen-share-started', { ...start, connectionMode: 'auto', routePreference: 'turn-udp' }).ok, false);
  assert.equal(call(host, 'screen-share-started', { ...start, connectionMode: 'relay', routePreference: 'ice-direct' }).ok, true);
  assert.equal(call(viewer, 'gamestream-watch', { ...watch, certificate, iceVersion: 1 }), false);
  assert.equal(call(viewer, 'gamestream-watch', { ...watch, certificate, iceVersion: 1, connectionVersion: 1 }), true);
  const iceOffer = {
    ufrag: 'AbCd', password: 'a'.repeat(22), candidates: ['1 1 udp 1 192.0.2.1 55000 typ host'],
  };
  assert.equal(call(host, 'gamestream-ready', { ...watch, accepted: true, iceOffer }), true);
  const connect = host.emitted.find(item => item.event === 'gamestream-connect').payload;
  assert.deepEqual(connect.endpoint, { connectionMode: 'relay', routePreference: 'ice-direct', basePort: 51000, certificate });
  assert.deepEqual(connect.iceOffer, iceOffer);
  assert.equal(call(viewer, 'gamestream-ice-answer', { ...watch,
    answer: { ...iceOffer, candidates: ['1 1 udp 1 192.0.2.1 55000 typ relay'] } }), false);
  assert.equal(call(viewer, 'gamestream-relay-request', watch), false);
});

test('automatic GameStream negotiates ICE only after the viewer requests a retry', () => {
  const host = createLifecycleHarness();
  const viewer = createLifecycleHarness({ socketId: 'socket-2', userId: 2, sharedState: host.state });
  const signal = { code: 'a1b2c3d4', sharerId: 1, sessionId: 'game-auto-retry' };
  const watch = { ...signal, watchId: '00000000-0000-4000-8000-000000000001' };
  const cert = data => `-----BEGIN CERTIFICATE-----\n${data}\n-----END CERTIFICATE-----\n`;
  const certificate = cert('AQID');
  const retry = { ...watch, certificate: cert('BAUG') };
  const offer = { ufrag: 'AbCd', password: 'a'.repeat(22),
    candidates: ['1 1 udp 1 192.0.2.1 55000 typ host', '2 1 udp 1 2001:db8::1 55000 typ host'] };
  const call = (client, event, payload) => {
    let result;
    client.handlers.get(event)(payload, value => { result = value; });
    return result;
  };
  assert.equal(call(host, 'screen-share-started', { ...signal, address: '192.168.1.5', basePort: 51000,
    certificate, connectionMode: 'auto', transport: 'gamestream' }).ok, true);
  assert.equal(call(viewer, 'gamestream-watch', { ...watch, certificate, iceVersion: 1, iceAfterDirect: true }), true);
  assert.equal(call(host, 'gamestream-ready', { ...watch, accepted: true, iceOffer: offer }), true);
  const first = host.emitted.find(event => event.event === 'gamestream-connect').payload;
  assert.equal(first.endpoint.connectionMode, 'auto');
  assert.equal(first.iceAfterDirect, true);
  assert.equal(first.iceOffer, undefined);
  assert.equal(call(viewer, 'gamestream-try-ice', retry), true);
  assert.equal(call(viewer, 'gamestream-try-ice', retry), false);
  assert.deepEqual(viewer.emitted.slice(-2).map(event => event.event),
    ['gamestream-viewer-revoke', 'gamestream-viewer-request']);
  assert.equal(call(host, 'gamestream-ready', { ...watch, accepted: true, iceRetry: true, iceOffer: offer }), true);
  const second = host.emitted.filter(event => event.event === 'gamestream-connect').at(-1).payload;
  assert.equal(second.endpoint.routePreference, 'ice-direct');
  assert.deepEqual(second.iceOffer, offer);
  assert.equal(call(viewer, 'gamestream-relay-request', watch), true);
  call(viewer, 'gamestream-nat', { ...watch, nat: 'stable' });
  call(host, 'gamestream-nat', { ...watch, nat: '192.168.1.5' });
  call(host, 'gamestream-nat', { ...watch, nat: 'destination-dependent' });
  call(host, 'gamestream-nat', { ...watch, nat: 'stable' });
  assert.deepEqual(host.emitted.filter(event => event.event === 'gamestream-nat'), [{
    event: 'gamestream-nat', socketId: 'socket-2',
    payload: { ...watch, nat: 'destination-dependent' },
  }]);
});

test('screen lifecycle requires the socket that owns the voice entry', () => {
  const { handlers, state } = createLifecycleHarness({
    socketId: 'socket-old',
    ownerSocketId: 'socket-new',
  });
  handlers.get('screen-share-started')({
    code: 'a1b2c3d4',
    transport: 'native',
    sessionId: 'native-session-1234',
    codec: 'H264',
  });
  assert.equal(state.activeScreenSessions.size, 0);
});

test('screen start acknowledges a channel policy rejection', () => {
  const { handlers, state } = createLifecycleHarness({ streamsEnabled: 0 });
  let response;
  handlers.get('screen-share-started')({ code: 'a1b2c3d4' }, ack => { response = ack; });

  assert.deepEqual(response, { ok: false, error: 'streams_disabled' });
  assert.equal(state.activeScreenSessions.size, 0);
});

test('native screen start rejects an incompatible viewer and acknowledges compatible peers', () => {
  const incompatible = createLifecycleHarness();
  incompatible.state.voiceUsers.get('a1b2c3d4').get(2).nativeScreenVersion = 0;
  let rejected;
  incompatible.handlers.get('screen-share-started')({
    code: 'a1b2c3d4',
    transport: 'native',
    sessionId: 'native-session-1234',
    codec: 'H264',
  }, response => { rejected = response; });
  assert.deepEqual(rejected, { ok: false, error: 'incompatible_viewer' });
  assert.equal(incompatible.state.activeScreenSessions.size, 0);

  const compatible = createLifecycleHarness();
  let accepted;
  compatible.handlers.get('screen-share-started')({
    code: 'a1b2c3d4',
    transport: 'native',
    sessionId: 'native-session-1234',
    codec: 'H264',
  }, response => { accepted = response; });
  assert.deepEqual(accepted, { ok: true, viewerIds: [2] });

  const incompatibleSender = createLifecycleHarness();
  incompatibleSender.state.voiceUsers.get('a1b2c3d4').get(1).nativeScreenCodecs = [];
  let senderRejected;
  incompatibleSender.handlers.get('screen-share-started')({
    code: 'a1b2c3d4',
    transport: 'native',
    sessionId: 'native-session-1234',
    codec: 'H264',
  }, response => { senderRejected = response; });
  assert.deepEqual(senderRejected, { ok: false, error: 'incompatible_sender' });
  assert.equal(incompatibleSender.state.activeScreenSessions.size, 0);

  let malformed;
  compatible.handlers.get('screen-share-started')({
    code: 'a1b2c3d4',
    transport: 'native',
    sessionId: { toString: null, valueOf: null },
  }, response => { malformed = response; });
  assert.deepEqual(malformed, { ok: false, error: 'invalid_session' });
});

test('a stale native stop cannot remove a newer screen session', () => {
  const { handlers, state } = createLifecycleHarness();
  const acknowledgements = [];
  handlers.get('screen-share-started')({
    code: 'a1b2c3d4',
    transport: 'native',
    sessionId: 'native-session-1234',
    codec: 'H264',
  });
  handlers.get('screen-share-stopped')({
    code: 'a1b2c3d4',
    sessionId: 'native-session-old1',
  }, response => acknowledgements.push(response));
  assert.equal(
    state.activeScreenSessions.get('a1b2c3d4').get(1).sessionId,
    'native-session-1234'
  );
  handlers.get('screen-share-stopped')({
    code: 'a1b2c3d4',
    sessionId: 'native-session-1234',
  }, response => acknowledgements.push(response));
  assert.equal(state.activeScreenSessions.size, 0);
  handlers.get('screen-share-stopped')({
    code: 'a1b2c3d4',
    sessionId: 'native-session-1234',
  }, response => acknowledgements.push(response));
  assert.deepEqual(acknowledgements, [{ ok: false }, { ok: true }, { ok: true }]);
});

test('a stale native stop cannot remove a newer browser screen session', () => {
  const { handlers, state } = createLifecycleHarness();
  handlers.get('screen-share-started')({
    code: 'a1b2c3d4',
    transport: 'native',
    sessionId: 'native-session-1234',
    codec: 'H264',
  });
  handlers.get('screen-share-started')({
    code: 'a1b2c3d4',
    transport: 'browser',
  });
  handlers.get('screen-share-stopped')({
    code: 'a1b2c3d4',
    sessionId: 'native-session-1234',
  });

  assert.equal(
    state.activeScreenSessions.get('a1b2c3d4').get(1).transport,
    'browser'
  );
});

test('voice join and no-op rejoin always emit authoritative screen snapshots', () => {
  const harness = createLifecycleHarness();
  harness.handlers.get('voice-join')({ code: 'a1b2c3d4' });
  const joinSnapshot = harness.emitted.find(item => item.event === 'active-screen-sharers');
  assert.deepEqual(joinSnapshot.payload, { channelCode: 'a1b2c3d4', sharers: [] });

  harness.emitted.length = 0;
  harness.handlers.get('voice-rejoin')({ code: 'a1b2c3d4' });
  const rejoinSnapshot = harness.emitted.find(item => item.event === 'active-screen-sharers');
  assert.deepEqual(rejoinSnapshot.payload, { channelCode: 'a1b2c3d4', sharers: [] });
});

test('an old client joining an active native share notifies the sharer', () => {
  const harness = createLifecycleHarness();
  harness.state.activeScreenSharers.set('a1b2c3d4', new Set([2]));
  harness.state.activeScreenSessions.set('a1b2c3d4', new Map([[
    2,
    { transport: 'native', sessionId: 'native-session-1234', codec: 'H264' },
  ]]));

  harness.handlers.get('voice-rejoin')({ code: 'a1b2c3d4' });

  const notification = harness.emitted.find(item =>
    item.socketId === 'socket-2' && item.event === 'native-screen-incompatible-peer'
  );
  assert.deepEqual(notification.payload, {
    channelCode: 'a1b2c3d4',
    userId: 1,
    sessionId: 'native-session-1234',
  });
});

test('a native sharer revalidates incompatible viewers on fast rejoin', () => {
  const harness = createLifecycleHarness();
  harness.state.voiceUsers.get('a1b2c3d4').get(2).nativeScreenVersion = 0;
  harness.state.activeScreenSharers.set('a1b2c3d4', new Set([1]));
  harness.state.activeScreenSessions.set('a1b2c3d4', new Map([[
    1,
    { transport: 'native', sessionId: 'native-session-1234', codec: 'H264' },
  ]]));
  harness.state.pendingVoiceLeave.set('1:a1b2c3d4', {
    timer: setTimeout(() => {}, 60000),
  });

  harness.handlers.get('voice-rejoin')({
    code: 'a1b2c3d4',
    nativeScreenVersion: 2,
    nativeScreenCodecs: ['H264'],
  });

  assert.equal(harness.state.pendingVoiceLeave.has('1:a1b2c3d4'), false);
  const notification = harness.emitted.find(item =>
    item.socketId === 'socket-1' && item.event === 'native-screen-incompatible-peer'
  );
  assert.deepEqual(notification.payload, {
    channelCode: 'a1b2c3d4',
    userId: 2,
    sessionId: 'native-session-1234',
  });
});
