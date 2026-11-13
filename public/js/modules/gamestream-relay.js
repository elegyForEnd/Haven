const CHUNK_BYTES = 32 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_INFLIGHT = 32;
const MAX_UPLOAD_INFLIGHT_BYTES = 256 * 1024;
const MAX_QUEUE_AGE_MS = 250;

export class GameStreamRelaySender {
  constructor(socket, signal, requestKeyFrame) {
    this.socket = socket;
    this.signal = signal;
    this.requestKeyFrame = requestKeyFrame;
    this.queue = [];
    this.bytes = 0;
    this.inflight = 0;
    this.inflightBytes = 0;
    this.seq = 0;
    this.active = true;
    this.needsKeyFrame = true;
  }

  push(packet) {
    if (!this.active || !packet.data?.byteLength) return;
    const queuedAt = performance.now();
    if (packet.data.byteLength > MAX_FRAME_BYTES ||
        (this.queue.length && queuedAt - this.queue[0].queuedAt > MAX_QUEUE_AGE_MS) ||
        this.bytes + packet.data.byteLength > 8 * 1024 * 1024) {
      this.discardQueue();
    }
    if (packet.data.byteLength > MAX_FRAME_BYTES ||
        (this.needsKeyFrame && !(packet.video && packet.keyFrame))) return;
    if (packet.video && packet.keyFrame) this.needsKeyFrame = false;
    const data = new Uint8Array(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength);
    const seq = this.seq++;
    const count = Math.ceil(data.byteLength / CHUNK_BYTES);
    for (let index = 0; index < count; index++) {
      const chunk = data.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
      this.queue.push({ ...this.signal, seq, index, count, queuedAt, video: packet.video,
        keyFrame: packet.keyFrame, timestampUs: packet.timestampUs || 0, data: chunk });
      this.bytes += chunk.byteLength;
    }
    this.drain();
  }

  discardQueue() {
    if (this.needsKeyFrame && this.queue.length === 0) return;
    this.queue.length = 0;
    this.bytes = 0;
    // Signal a discontinuity even if the unsent tail belonged to the last frame sent.
    this.seq++;
    const requestKeyFrame = !this.needsKeyFrame;
    this.needsKeyFrame = true;
    if (requestKeyFrame) this.requestKeyFrame();
  }

  drain() {
    while (this.active && this.inflight < MAX_UPLOAD_INFLIGHT && this.queue.length && this.socket.connected &&
        this.inflightBytes + this.queue[0].data.byteLength <= MAX_UPLOAD_INFLIGHT_BYTES) {
      if (performance.now() - this.queue[0].queuedAt > MAX_QUEUE_AGE_MS) {
        this.discardQueue();
        return;
      }
      const { queuedAt, ...chunk } = this.queue.shift();
      this.bytes -= chunk.data.byteLength;
      this.inflight++;
      this.inflightBytes += chunk.data.byteLength;
      this.socket.timeout(5000).emit('gamestream-relay-data', chunk, (error, accepted) => {
        this.inflight--;
        this.inflightBytes -= chunk.data.byteLength;
        if (!this.active) return;
        if (error || accepted?.error === 'rate_limited') {
          this.discardQueue();
        } else if (accepted !== true) {
          this.close();
        }
        this.drain();
      });
    }
  }

  close() {
    this.active = false;
    this.queue.length = 0;
    this.bytes = 0;
  }
}

export class GameStreamRelayReceiver {
  constructor(playback, onVideo) {
    this.playback = playback;
    this.onVideo = onVideo;
    this.needsKeyFrame = true;
  }

  discardFrame() {
    const interruptedVideo = this.pending?.video;
    this.pending = null;
    if (interruptedVideo || !this.needsKeyFrame) this.playback.resetVideo?.();
    this.needsKeyFrame = true;
  }

  push(chunk) {
    const data = chunk.data instanceof ArrayBuffer ? new Uint8Array(chunk.data) : chunk.data;
    if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > CHUNK_BYTES ||
        !Number.isSafeInteger(chunk.seq) || !Number.isInteger(chunk.count) ||
        chunk.count < 1 || chunk.count > 128 || !Number.isInteger(chunk.index) ||
        chunk.index < 0 || chunk.index >= chunk.count) return;
    if (!this.pending || this.pending.seq !== chunk.seq) {
      if (this.pending?.video || (this.lastSeq != null && chunk.seq !== this.lastSeq + 1)) this.discardFrame();
      this.pending = null;
      this.lastSeq = chunk.seq;
      if (chunk.index !== 0 || (this.needsKeyFrame && !(chunk.video && chunk.keyFrame))) return;
      this.pending = { ...chunk, parts: [], bytes: 0 };
    }
    const pending = this.pending;
    if (pending.parts.length !== chunk.index || pending.count !== chunk.count ||
        pending.video !== chunk.video || pending.timestampUs !== chunk.timestampUs) {
      this.discardFrame();
      return;
    }
    pending.bytes += data.byteLength;
    if (pending.bytes > MAX_FRAME_BYTES) { this.discardFrame(); return; }
    pending.parts.push(data);
    if (pending.parts.length !== pending.count) return;
    const frame = new Uint8Array(pending.bytes);
    let offset = 0;
    for (const part of pending.parts) { frame.set(part, offset); offset += part.byteLength; }
    this.pending = null;
    if (pending.video) {
      this.needsKeyFrame = false;
      this.onVideo(frame.byteLength);
    }
    this.playback.push({ ...pending, data: frame });
  }
}
