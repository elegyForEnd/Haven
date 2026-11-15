// Fixed blocks and bounded buffering: a slow native processor must never
// accumulate seconds of delayed speech. The main thread restores normal audio.
class ClearProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(512);
    this.inputCount = 0;
    this.sequence = 0;
    this.inFlight = 0;
    this.expected = 0;
    this.fifo = new Float32Array(8192);
    this.read = 0;
    this.write = 0;
    this.count = 0;
    this.priming = true;
    this.stopped = false;
    this.failed = false;
    this.waitingSamples = 0;
    this.underruns = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'stop') { this.stopped = true; return; }
      if (this.failed || data.type !== 'pcm') return;
      if (data.sequence !== this.expected++ || data.pcm?.length !== 512) return this.fail('Clear audio block order failed');
      this.inFlight--;
      if (this.count + 512 > 4096) return this.fail('Clear playback queue exceeded latency limit');
      for (const value of data.pcm) { this.fifo[this.write] = value; this.write = (this.write + 1) % this.fifo.length; }
      this.count += 512;
      this.waitingSamples = 0;
    };
  }
  fail(error) {
    if (this.failed) return;
    this.failed = true;
    this.port.postMessage({ type: 'error', error });
  }
  process(inputs, outputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output || this.failed) return true;
    for (let i = 0; i < input.length; i++) {
      this.block[this.inputCount++] = input[i];
      if (this.inputCount === 512) {
        if (this.inFlight >= 12) { this.fail('Clear audio queue exceeded latency limit'); return true; }
        this.inFlight++;
        const pcm = this.block;
        // Copy this small block: Electron MessagePortMain cannot deserialize
        // AudioWorklet messages containing transferred ArrayBuffers.
        this.port.postMessage({ type: 'pcm', sequence: this.sequence++, pcm });
        this.block = new Float32Array(512);
        this.inputCount = 0;
      }
    }
    this.waitingSamples += input.length;
    if (this.waitingSamples > sampleRate * .4) { this.fail('Clear audio response timed out'); return true; }
    if (this.priming && this.count >= 1024) this.priming = false;
    if (this.priming) return true;
    if (this.count < output.length) {
      this.priming = true;
      if (++this.underruns >= 4) this.fail('Clear audio cannot keep up');
      return true;
    }
    for (let i = 0; i < output.length; i++) { output[i] = this.fifo[this.read]; this.read = (this.read + 1) % this.fifo.length; }
    this.count -= output.length;
    return true;
  }
}
registerProcessor('ciacord-clear', ClearProcessor);
