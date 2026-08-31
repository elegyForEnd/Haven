'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
  host.trigger('remote-control-capability', { hostSupported: true, controllerSupported: true, platform: 'win32' });
  controller.trigger('remote-control-capability', { hostSupported: false, controllerSupported: true, platform: 'web' });
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

  host.trigger('remote-control-signal', {
    sessionId: hostStart.sessionId,
    description: { type: 'offer', sdp: 'test-sdp' },
  });
  assert.deepEqual(controller.last('remote-control-signal').description, { type: 'offer', sdp: 'test-sdp' });

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
  assert.match(response.error, /Haven Desktop on Windows/);
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
