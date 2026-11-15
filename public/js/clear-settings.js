import { desktopClearAudio, clearSettings, saveClearSettings, DEFAULT_CLEAR_SETTINGS } from './clear-microphone.js';

// A local mixer for Clear's three separated channels. Gains are dB, converted
// by the plug-in's own VST3 controller rather than an assumed gain curve.
export function initializeClearSettings({ getVoice, t }) {
  const panel = document.getElementById('voice-clear-panel');
  if (!panel) return { update() {} };
  const fieldset = panel.querySelector('fieldset');
  const status = panel.querySelector('[role="status"]');
  const supported = desktopClearAudio()?.parametersVersion === 1;
  let settings = clearSettings();
  let timer;
  let revision = 0;
  const controls = [...panel.querySelectorAll('[data-clear-parameter]')];
  function render(parameters = []) {
    for (const control of controls) {
      const name = control.dataset.clearParameter;
      if (control.type === 'checkbox') control.checked = !!settings[name];
      else {
        control.value = settings[name];
        const native = parameters.find(parameter => parameter.name === name);
        document.getElementById(control.id + '-value').textContent = `${native?.display || Number(settings[name]).toFixed(1)} dB`;
      }
    }
  }
  async function apply(version) {
    if (version !== revision) return;
    const voice = getVoice();
    if (!voice?._clearMicrophone || voice.noiseEngine !== 'clear') {
      status.textContent = t('voice_settings.clear_params_saved'); return;
    }
    status.textContent = t('voice_settings.clear_params_applying');
    try {
      const parameters = await voice.setClearSettings(settings);
      if (version === revision) { render(parameters || []); status.textContent = t('voice_settings.clear_params_applied'); }
    } catch (error) {
      if (version === revision) {
        status.textContent = t('voice_settings.clear_params_failed');
        status.title = error.message;
      }
    }
  }
  function queue(delay) {
    settings = saveClearSettings(settings);
    render();
    status.title = '';
    const version = ++revision;
    clearTimeout(timer);
    timer = setTimeout(() => apply(version), delay);
  }
  for (const control of controls) control.addEventListener(control.type === 'range' ? 'input' : 'change', () => {
    settings[control.dataset.clearParameter] = control.type === 'checkbox' ? Number(control.checked) : Number(control.value);
    queue(control.type === 'range' ? 100 : 0);
  });
  panel.querySelector('[data-clear-reset]').addEventListener('click', () => {
    settings = { ...DEFAULT_CLEAR_SETTINGS }; queue(0);
  });
  render();
  return {
    update(selected, stereo, engineStatus) {
      panel.hidden = !selected;
      fieldset.disabled = !supported || stereo || engineStatus?.actual === 'loading';
      if (!supported) status.textContent = t('voice_settings.clear_params_upgrade');
      else if (!status.textContent) status.textContent = t('voice_settings.clear_params_hint');
    },
  };
}
