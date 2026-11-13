'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const registerRemoteControl = require('./remoteControl');

class FakeSocket {
  constructor(id, userId, name, channel) {
    this.id = id;
    this.user = { id: userId, displayName: name };
    this.currentChannel = channel;
    this.handlers = new Map();
    this.outbound = [];
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
  }

  emit(event, payload) {
    this.outbound.push({ event, payload });
  }

  trigger(event, ...args) {
    for (const handler of this.handlers.get(event) || []) handler(...args);
  }

  last(event) {
    return this.outbound.filter(item => item.event === event).at(-1)?.payload;
  }
}

function setup() {
  const code = 'abcdef12';
  const host = new FakeSocket('host-socket', 1, 'Host', code);
  const controller = new FakeSocket('controller-socket', 2, 'Helper', code);
  const sockets = new Map([[host.id, host], [controller.id, controller]]);
  const state = {
    channelUsers: new Map([[code, new Map([
      [1, { id: 1, username: 'Host', socketId: host.id }],
      [2, { id: 2, username: 'Helper', socketId: controller.id }],
    ])]]),
    remoteControlRequests: new Map(),
    remoteControlSessions: new Map(),
    remoteControlRateLimits: new Map(),
  };
  const db = { prepare: () => ({ get: () => ({ streams_enabled: 1 }) }) };
  const ctx = { io: { sockets: { sockets } }, db, state };
  registerRemoteControl(host, ctx);
  registerRemoteControl(controller, ctx);
  host.trigger('remote-control-capability', { hostSupported: true, controllerSupported: true, version: 'moonlight-1', routeSelection: 1 });
  controller.trigger('remote-control-capability', { hostSupported: false, controllerSupported: true, version: 'moonlight-1', routeSelection: 1 });
  return { code, host, controller, state };
}

test('request, consent, signaling, and end stay between channel participants', () => {
  const { code, host, controller, state } = setup();
  let requestResponse;
  controller.trigger('remote-control-request', {
    code,
    targetUserId: host.user.id,
    mode: 'request',
  }, response => { requestResponse = response; });

  assert.equal(requestResponse.ok, true);
  const incoming = host.last('remote-control-requested');
  assert.equal(incoming.role, 'host');
  assert.equal(incoming.from.id, controller.user.id);

  let consentResponse;
  host.trigger('remote-control-response', {
    requestId: incoming.requestId,
    accepted: true,
  }, response => { consentResponse = response; });

  assert.equal(consentResponse.ok, true);
  assert.equal(state.remoteControlRequests.size, 0);
  assert.equal(state.remoteControlSessions.size, 1);
  const hostStart = host.last('remote-control-session-start');
  const controllerStart = controller.last('remote-control-session-start');
  assert.equal(hostStart.role, 'host');
  assert.equal(controllerStart.role, 'controller');
  assert.equal(hostStart.sessionId, controllerStart.sessionId);

  const { sessionId } = hostStart;
  const certificate = '-----BEGIN CERTIFICATE-----\nVEVTVA==\n-----END CERTIFICATE-----\n';
  const ice = { ufrag: 'ABCD', password: 'abcdefghijklmopqrstuvwxyz', candidates: ['candidate'] };
  const endpoint = { basePort: 50000, certificate, iceOffer: ice, videoMode: '1280x720x30', relayOnly: false };
  const viewer = { sessionId, kind: 'viewer', watchId: randomUUID(), certificate };
  const signal = (socket, data, expected) => {
    let result;
    socket.trigger('remote-control-signal', data, reply => { result = reply; });
    assert.equal(result?.ok, expected);
  };

  signal(host, { sessionId, kind: 'offer', endpoint }, false);
  signal(host, viewer, false);
  signal(controller, { ...viewer, transfer: true, privateKey: 'discarded' }, true);
  assert.deepEqual(host.last('remote-control-signal'), { ...viewer, transfer: true });
  signal(controller, viewer, false);
  signal(host, { sessionId, kind: 'offer', endpoint: { ...endpoint, transfer: true, transferPort: 1234, privateKey: 'discarded' } }, true);
  assert.deepEqual(controller.last('remote-control-signal').endpoint, { ...endpoint, bitrateKbps: undefined, transfer: true });
  signal(controller, { sessionId, kind: 'answer', answer: ice }, true);
  assert.deepEqual(host.last('remote-control-signal').answer, ice);
  signal(controller, { sessionId, kind: 'playing' }, true);
  signal(controller, { sessionId, kind: 'input', keyCode: 0x41 }, false);

  controller.trigger('remote-control-end', { sessionId: hostStart.sessionId, reason: 'controller-stopped' });
  assert.equal(state.remoteControlSessions.size, 0);
  assert.equal(host.last('remote-control-session-ended').reason, 'controller-stopped');
});

test('a web-only target cannot host remote control', () => {
  const { code, host, controller } = setup();
  let response;
  host.trigger('remote-control-request', {
    code,
    targetUserId: controller.user.id,
    mode: 'request',
  }, result => { response = result; });
  assert.match(response.error, /Windows Ciacord desktop app/);
  assert.equal(response.desktopRequirement, 'host_desktop_required');
});

test('requests cannot target a user outside the active channel', () => {
  const { code, controller, state } = setup();
  state.channelUsers.get(code).delete(1);
  let response;
  controller.trigger('remote-control-request', {
    code,
    targetUserId: 1,
    mode: 'request',
  }, result => { response = result; });
  assert.match(response.error, /not currently in this channel/);
});

test('leaving the channel revokes an active session', () => {
  const { code, host, controller, state } = setup();
  controller.trigger('remote-control-request', { code, targetUserId: 1, mode: 'request' }, () => {});
  const requestId = host.last('remote-control-requested').requestId;
  host.trigger('remote-control-response', { requestId, accepted: true }, () => {});
  assert.equal(state.remoteControlSessions.size, 1);
  host.trigger('leave-channel', { code });
  assert.equal(state.remoteControlSessions.size, 0);
  assert.equal(controller.last('remote-control-session-ended').reason, 'channel-left');
});

test('a browser or older desktop cannot act as the Moonlight controller', () => {
  const { code, host, controller } = setup();
  controller.trigger('remote-control-capability', { controllerSupported: true, version: '1' });
  let response;
  controller.trigger('remote-control-request', { code, targetUserId: host.user.id }, result => { response = result; });
  assert.match(response.error, /controller needs an updated Windows Ciacord desktop app/);
  assert.equal(response.desktopRequirement, 'controller_desktop_required');
});

test('another connection for the same account cannot signal or end an approved session', () => {
  const { code, host, controller, state } = setup();
  controller.trigger('remote-control-request', { code, targetUserId: host.user.id }, () => {});
  const requestId = host.last('remote-control-requested').requestId;
  host.trigger('remote-control-response', { requestId, accepted: true }, () => {});
  const { sessionId } = host.last('remote-control-session-start');
  controller.id = 'another-controller-socket';
  let response;
  controller.trigger('remote-control-signal', { sessionId, kind: 'viewer' }, result => { response = result; });
  assert.equal(response.ok, false);
  controller.trigger('remote-control-end', { sessionId });
  assert.equal(state.remoteControlSessions.size, 1);
  host.trigger('remote-control-end', { sessionId });
});

test('remote control settings are validated and delivered to both approved desktops', () => {
  const { code, host, controller } = setup();
  const settings = { resolution: 1440, fps: 60, bitrateKbps: 12000, connectionPreference: 'ip-direct' };
  let result;
  const request = options => controller.trigger('remote-control-request',
    { code, targetUserId: host.user.id, settings: options }, response => { result = response; });
  request({ ...settings, fps: 999 });
  assert.match(result.error, /settings/);
  request({ ...settings, connectionPreference: 'haven-relay' });
  assert.match(result.error, /settings/);
  host.trigger('remote-control-capability', { hostSupported: true, version: 'moonlight-1' });
  request(settings);
  assert.equal(result.desktopRequirement, 'host_desktop_required');
  host.trigger('remote-control-capability', { hostSupported: true, version: 'moonlight-1', routeSelection: 1 });
  request({ ...settings, unexpected: true });
  assert.equal(result.ok, true);
  host.trigger('remote-control-response', { requestId: result.requestId, accepted: true }, () => {});
  assert.deepEqual(host.last('remote-control-session-start').settings, settings);
  assert.deepEqual(controller.last('remote-control-session-start').settings, settings);
});
