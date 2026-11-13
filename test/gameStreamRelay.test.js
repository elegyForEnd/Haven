const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/js/modules/gamestream-relay.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('relay splits large keyframes below Haven message limits and reconstructs the original bytes', async () => {
  const { GameStreamRelaySender, GameStreamRelayReceiver } = await modulePromise;
  const chunks = [], decoded = [];
  const socket = { connected: true, timeout() { return this; },
    emit(_event, chunk, ack) { chunks.push(chunk); queueMicrotask(() => ack(null, true)); } };
  const sender = new GameStreamRelaySender(socket, { sessionId: 'session' }, () => {});
  const receiver = new GameStreamRelayReceiver({ push: packet => decoded.push(packet) }, () => {});
  const bytes = Buffer.alloc(150000, 123);
  sender.push({ video: true, keyFrame: true, timestampUs: 456, data: bytes });
  await new Promise(resolve => setImmediate(resolve));
  assert(chunks.length > 1);
  for (const chunk of chunks) {
    assert(chunk.data.byteLength <= 32 * 1024);
    receiver.push(chunk);
  }
  assert.equal(decoded.length, 1);
  assert.deepEqual(Buffer.from(decoded[0].data), bytes);
  assert.equal(decoded[0].timestampUs, 456);
  sender.close();
  sender.push({ video: true, keyFrame: true, data: bytes });
  assert.equal(sender.bytes, 0);
});

test('relay discards incomplete frames and requests decoder recovery when the stream has a gap', async () => {
  const { GameStreamRelayReceiver } = await modulePromise;
  let resets = 0;
  const decoded = [];
  const receiver = new GameStreamRelayReceiver({
    push: packet => decoded.push(packet), resetVideo: () => resets++,
  }, () => {});
  const chunk = { seq: 0, index: 0, count: 2, video: true, keyFrame: true,
    timestampUs: 0, data: new Uint8Array([1, 2]) };
  receiver.push(chunk);
  receiver.push({ ...chunk, seq: 1, count: 1 });
  assert.equal(resets, 1);
  assert.equal(decoded.length, 1);
  receiver.push({ ...chunk, seq: 2, index: 1 });
  assert.equal(decoded.length, 1);
});

test('relay drops a stale upload backlog and resumes with a fresh keyframe', async t => {
  const { GameStreamRelaySender } = await modulePromise;
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  let requests = 0;
  const sent = [];
  const socket = { connected: true, timeout() { return this; },
    emit(_event, chunk, ack) { sent.push({ chunk, ack }); } };
  const sender = new GameStreamRelaySender(socket, { sessionId: 'session' }, () => requests++);
  const packet = { video: true, keyFrame: true, timestampUs: 0, data: Buffer.alloc(1) };
  sender.push(packet);
  while (sender.queue.length === 0) sender.push({ ...packet, keyFrame: false });
  const lastSentSeq = sent.at(-1).chunk.seq;
  now = 251;
  sent[0].ack(null, true);
  assert.equal(sender.queue.length, 0);
  assert.equal(requests, 1);
  sender.push({ ...packet, keyFrame: false });
  assert.equal(sent.at(-1).chunk.seq, lastSentSeq);
  sender.push({ ...packet, timestampUs: 251000 });
  assert(sent.at(-1).chunk.seq > lastSentSeq + 1);
  assert.equal(sent.at(-1).chunk.timestampUs, 251000);
});

test('relay caps unacknowledged bytes and recovers from rate limits and lost acknowledgements', async () => {
  const { GameStreamRelaySender } = await modulePromise;
  const sent = [];
  let requests = 0;
  const socket = { connected: true, timeout() { return this; },
    emit(_event, chunk, ack) { sent.push({ chunk, ack }); } };
  const sender = new GameStreamRelaySender(socket, {}, () => requests++);
  const packet = { video: true, keyFrame: true, data: Buffer.alloc(512 * 1024) };
  sender.push(packet);
  assert.equal(sent.reduce((bytes, { chunk }) => bytes + chunk.data.byteLength, 0), 256 * 1024);
  sent[0].ack(null, { ok: false, error: 'rate_limited' });
  sent[1].ack(new Error('ack timeout'));
  assert.equal(sender.active, true);
  assert.equal(sender.queue.length, 0);
  assert.equal(requests, 1);
  sender.push({ ...packet, data: Buffer.alloc(1) });
  assert.equal(sent.at(-1).chunk.keyFrame, true);
  assert.equal(sent.at(-1).chunk.seq, 2);
  sent.at(-1).ack(null, false);
  assert.equal(sender.active, false);
});
