const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('a failed direct viewer automatically subscribes to relay and updates its measured route', async () => {
  const encode = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const root = path.join(__dirname, '../public/js/modules');
  let source = fs.readFileSync(path.join(root, 'gamestream-session.js'), 'utf8');
  const relay = encode(fs.readFileSync(path.join(root, 'gamestream-relay.js'), 'utf8'));
  const playback = encode('export const createGameStreamPlayback = () => globalThis.testPlayback;');
  source = source.replace(/'\.\/gamestream-playback\.js(?:\?[^']*)?'/, JSON.stringify(playback))
    .replace(/'\.\/gamestream-relay\.js(?:\?[^']*)?'/, JSON.stringify(relay));
  const handlers = new Map(), sent = [];
  let ended, packets;
  const socket = {
    connected: true, on: (name, callback) => handlers.set(name, callback),
    timeout() { return this; },
    emit(name, data, ack) { sent.push({ name, data }); ack?.(null, true); },
  };
  let closedDirect = false, errors = 0, attached = 0;
  const api = {
    relayVersion: 1, revokeViewer() {},
    onPackets(callback) { packets = callback; }, onStats() {}, onRelayPackets() {}, onRelayEnded() {},
    onEnded(callback) { ended = callback; },
    prepareViewer: async () => ({ id: 'viewer-1', certificate: 'certificate' }),
    connectViewer: async () => true, requestKeyFrame: async () => {},
    closeDirect: async () => { closedDirect = true; },
    stop: async () => {}, lease: async () => true,
  };
  globalThis.window = { havenDesktop: { gameStream: api } };
  globalThis.document = { getElementById: () => null };
  globalThis.VideoDecoder = globalThis.AudioDecoder = globalThis.MediaStreamTrackGenerator = function () {};
  globalThis.testPlayback = { stream: {}, push() {}, resetVideo() {}, close() {} };
  const voice = {
    inVoice: true, currentChannel: 'a1b2c3d4', _voiceSessionGeneration: 1,
    localUserId: 2, _screenDelivered: new Set(), screenGainNodes: new Map(),
    onScreenStream: () => { attached++; },
  };
  const { GameStreamSession } = await import(encode(source));
  const session = new GameStreamSession(voice, socket, () => { errors++; });
  try {
    session.announce(1, 'session-1');
    await session.watch(1);
    await session.connect({ code: voice.currentChannel, sharerId: 1, sessionId: 'session-1',
      watchId: 'viewer-1', endpoint: {}, hasAudio: false });
    ended({ id: 'viewer-1' });
    await new Promise(resolve => setImmediate(resolve));
    assert(closedDirect);
    assert(sent.some(item => item.name === 'gamestream-relay-request'));
    assert.equal(session.viewer.route, null);
    handlers.get('gamestream-relay-data')({ code: voice.currentChannel, sessionId: 'session-1',
      watchId: 'viewer-1', seq: 0, index: 0, count: 1, video: true, keyFrame: true,
      timestampUs: 0, data: new Uint8Array([1, 2, 3]) });
    assert.equal(session.viewer.route, 'relay');
    assert.equal(session.viewer.videoBytes, 3);
    assert.equal(attached, 1);
    assert.equal(errors, 0);
    session.stopViewer();
    api.connectViewer = () => { throw new Error('Forced relay must skip the direct attempt'); };
    session.announce(1, 'session-2');
    await session.watch(1);
    await session.connect({ code: voice.currentChannel, sharerId: 1, sessionId: 'session-2',
      watchId: 'viewer-1', endpoint: { connectionMode: 'relay' }, hasAudio: false });
    assert.equal(session.viewer.relayPending, true);
    assert.equal(errors, 0);
    session.stopViewer();

    const answer = { ufrag: 'answer' };
    api.prepareViewer = async () => ({ id: 'viewer-1', certificate: 'certificate', iceVersion: 1 });
    api.prepareIce = async options => {
      assert.equal(options.relayOnly, true);
      return answer;
    };
    api.connectViewer = async () => ({ route: 'ice-relay', address: '192.0.2.1:52000' });
    session.announce(1, 'session-3');
    await session.watch(1);
    await session.connect({ code: voice.currentChannel, sharerId: 1, sessionId: 'session-3',
      watchId: 'viewer-1', endpoint: { connectionMode: 'relay' }, iceOffer: { ufrag: 'offer' }, hasAudio: false });
    assert.equal(sent.find(item => item.name === 'gamestream-ice-answer').data.answer, answer);
    packets({ id: 'viewer-1', packets: [{ video: true, data: new Uint8Array([1]) }] });
    assert.equal(session.viewer.route, 'ice-relay');
    assert.equal(session.viewer.address, '192.0.2.1:52000');
    session.stopViewer();

    const attempts = [];
    api.retryViewer = async id => {
      attempts.push('retry ' + id);
      return { id: 'second-native', certificate: 'fresh-certificate' };
    };
    api.connectViewer = async ({ id }) => {
      attempts.push(id);
      return { route: id === 'viewer-1' ? 'direct' : 'ice-direct' };
    };
    api.prepareIce = async () => answer;
    session.announce(1, 'session-4');
    await session.watch(1);
    const connect = { code: voice.currentChannel, sharerId: 1, sessionId: 'session-4',
      watchId: 'viewer-1', hasAudio: false };
    await session.connect({ ...connect, endpoint: { connectionMode: 'auto' }, iceAfterDirect: true });
    assert.deepEqual(attempts, ['viewer-1']);
    ended({ id: 'viewer-1' });
    await new Promise(resolve => setImmediate(resolve));
    const retry = sent.find(item => item.name === 'gamestream-try-ice');
    assert.equal(retry.data.watchId, 'viewer-1');
    assert.equal(retry.data.certificate, 'fresh-certificate');
    await session.connect({ ...connect, endpoint: { connectionMode: 'relay', routePreference: 'ice-direct' },
      iceRetry: true, iceOffer: { ufrag: 'offer' } });
    assert.deepEqual(attempts, ['viewer-1', 'retry viewer-1', 'second-native']);
    packets({ id: 'second-native', packets: [{ video: true, data: new Uint8Array([1]) }] });
    assert.equal(session.viewer.route, 'ice-direct');
    ended({ id: 'second-native' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.viewer.relayPending, true);
  } finally {
    session.stopViewer();
    delete globalThis.testPlayback;
  }
});
