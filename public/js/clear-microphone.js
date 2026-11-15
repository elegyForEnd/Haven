export function desktopClearAudio() {
  return (window.ciacordDesktop || window.havenDesktop)?.clearAudio;
}

export function preferredNoiseEngine() {
  if (desktopClearAudio()?.version !== 1) return 'original';
  return localStorage.getItem('ciacord_noise_engine') === 'original' ? 'original' : 'clear';
}

export const DEFAULT_CLEAR_SETTINGS = Object.freeze({
  'Ambience Gain': 0, 'Ambience Mute': 1,
  'Voice Gain': 0, 'Voice Mute': 0,
  'Voice Reverb Gain': 0, 'Voice Reverb Mute': 1,
  'Bypass': 0,
});

export function clearSettings(values) {
  if (values === undefined) {
    try { values = JSON.parse(localStorage.getItem('ciacord_clear_settings') || '{}'); } catch { values = {}; }
  }
  const settings = { ...DEFAULT_CLEAR_SETTINGS };
  for (const name of Object.keys(settings)) {
    const value = values?.[name];
    if (typeof value === 'number' && Number.isFinite(value)) settings[name] = name.endsWith(' Gain') ? Math.max(-60, Math.min(12, value)) : value >= .5 ? 1 : 0;
  }
  return settings;
}

export function saveClearSettings(values) {
  const settings = clearSettings(values);
  localStorage.setItem('ciacord_clear_settings', JSON.stringify(settings));
  return settings;
}

// The native plug-in and PCM stay local to the desktop app.
export class ClearMicrophone {
  static async create(context, onError) {
    const bridge = desktopClearAudio();
    if (!bridge?.version) throw new Error('Clear requires the Windows desktop app');
    await context.audioWorklet.addModule('/js/clear-processor.js');
    const info = await bridge.start({ sampleRate: context.sampleRate, ...(bridge.parametersVersion === 1 ? { settings: clearSettings() } : {}) });
    let node;
    try {
      node = new AudioWorkletNode(context, 'ciacord-clear', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1,
      });
    } catch (error) {
      await bridge.stop(info.id); throw error;
    }
    const instance = new ClearMicrophone();
    Object.assign(instance, { node, bridge, info, stopped: false });
    instance.unsubscribe = bridge.onResult(data => {
      if (instance.stopped || data.id !== info.id) return;
      if (data.error) onError(new Error(data.error));
    });
    node.onprocessorerror = () => onError(new Error('Clear audio worklet failed'));
    try { bridge.connect(info.id, node.port); }
    catch (error) { instance.stop(); throw error; }
    return instance;
  }

  async setSettings(settings) {
    if (this.stopped) throw new Error('Clear stopped');
    if (this.bridge.parametersVersion !== 1) throw new Error('Update the desktop client to adjust Clear');
    const parameters = await this.bridge.parameters(this.info.id, clearSettings(settings));
    this.info.parameters = parameters;
    return parameters;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.node.onprocessorerror = null;
    this.node.disconnect();
    this.bridge.stop(this.info.id).catch(() => {});
  }
}
