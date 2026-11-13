import { attachStreamPerformance } from './modules/stream-performance.js?v=4.6.21';
import { createGameStreamPlayback } from './modules/gamestream-playback.js?v=4.6.4';

const KEY_CODES = new Map(Object.entries({
  Backspace: 0x08, Tab: 0x09, Enter: 0x0d, NumpadEnter: 0x0d,
  Pause: 0x13, CapsLock: 0x14, Escape: 0x1b, Space: 0x20, PageUp: 0x21,
  PageDown: 0x22, End: 0x23, Home: 0x24, ArrowLeft: 0x25, ArrowUp: 0x26,
  ArrowRight: 0x27, ArrowDown: 0x28, PrintScreen: 0x2c, Insert: 0x2d, Delete: 0x2e,
  MetaLeft: 0x5b, MetaRight: 0x5c, ContextMenu: 0x5d,
  NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d,
  NumpadDecimal: 0x6e, NumpadDivide: 0x6f, NumLock: 0x90, ScrollLock: 0x91,
  ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3,
  AltLeft: 0xa4, AltRight: 0xa5, AudioVolumeMute: 0xad, AudioVolumeDown: 0xae,
  AudioVolumeUp: 0xaf, MediaTrackNext: 0xb0, MediaTrackPrevious: 0xb1, MediaStop: 0xb2,
  MediaPlayPause: 0xb3, Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd,
  Period: 0xbe, Slash: 0xbf, Backquote: 0xc0, BracketLeft: 0xdb, Backslash: 0xdc,
  BracketRight: 0xdd, Quote: 0xde, IntlBackslash: 0xe2,
}));
for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') KEY_CODES.set('Key' + letter, letter.charCodeAt(0));
for (let digit = 0; digit <= 9; digit++) {
  KEY_CODES.set('Digit' + digit, 0x30 + digit);
  KEY_CODES.set('Numpad' + digit, 0x60 + digit);
}
for (let key = 1; key <= 24; key++) KEY_CODES.set('F' + key, 0x6f + key);

const EXTENDED_KEYS = new Set([
  'NumpadEnter', 'NumpadDivide', 'ControlRight', 'AltRight', 'PrintScreen', 'Insert', 'Delete',
  'Home', 'End', 'PageUp', 'PageDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'MetaLeft', 'MetaRight', 'ContextMenu', 'NumLock',
]);

export class HavenRemoteControlManager {
  constructor(app) {
    this.app = app;
    this.socket = app.socket;
    this.session = null;
    this.api = window.ciacordDesktop?.gameStream ?? window.havenDesktop?.gameStream;
    this._bindSocketEvents();
    this._detectCapability();
    this.socket.on('connect', () => this._detectCapability());
    this.socket.on('disconnect', () => {
      this.requestPicker?.close();
      this.end('disconnected', true);
    });
    this.api?.onAssistanceEnded?.(({ sessionId, reason }) => {
      if (this.session?.id === sessionId) this.end(reason || 'screen-share-ended');
    });
    this.api?.onAssistanceShortcut?.(({ id, action, result }) => {
      const session = this.session;
      if (session?.nativeId === id) session.localShortcut?.(action, result);
    });
    this.api?.onStats?.(({ id, route, address, rtt }) => {
      const session = this.session;
      if (session?.nativeId !== id || !session.metrics) return;
      Object.assign(session.metrics, { route, address, rtt });
    });
    this.api?.onPackets?.(({ id, packets }) => {
      const session = this.session;
      if (!session || session.nativeId !== id || session.ending || !session.playback) return;
      for (const packet of packets) {
        if (packet.video && session.metrics) session.metrics.videoBytes += packet.data.byteLength;
        session.playback.push(packet);
      }
    });
  }

  async _detectCapability() {
    const capability = await this.api?.assistanceCapability?.().catch(() => null);
    if (this.socket.connected) this.socket.emit('remote-control-capability', capability || {});
    return capability;
  }

  async request(targetUserId, targetName, mode = 'request') {
    if (!this.app.currentChannel) {
      this._toast(this._tr('open_channel', {}, 'Open a channel before starting remote assistance.'), 'error');
      return;
    }
    if (this.session) {
      this._toast(this._tr('already_active', {}, 'A remote assistance session is already active.'), 'error');
      return;
    }
    const capability = await this._detectCapability();
    if (!capability?.[mode === 'invite' ? 'hostSupported' : 'controllerSupported']) {
      this._showDesktopRequirement(mode === 'invite' ? 'host_desktop_required' : 'controller_desktop_required');
      return;
    }
    const code = this.app.currentChannel;
    const settings = mode === 'request' ? await this._chooseRequestSettings(capability) : undefined;
    if ((mode === 'request' && !settings) || this.session || code !== this.app.currentChannel || !this.socket.connected) return;
    this.socket.emit('remote-control-request', {
      code,
      targetUserId,
      ...(settings ? { settings } : {}),
      mode: mode === 'invite' ? 'invite' : 'request',
    }, response => {
      if (response?.desktopRequirement) return this._showDesktopRequirement(response.desktopRequirement);
      if (response?.error) return this._toast(response.error, 'error');
      const key = mode === 'invite' ? 'invitation_sent' : 'request_sent';
      this._toast(this._tr(key, { name: targetName || 'the selected user' }, `Request sent to ${targetName || 'the selected user'}.`), 'info');
    });
  }

  async _chooseRequestSettings(capability) {
    if (this.requestPicker) return null;
    if (capability.routeSelection !== 1) {
      this._showDesktopRequirement('controller_desktop_required');
      return null;
    }
    const picker = document.createElement('dialog');
    this.requestPicker = picker;
    picker.className = 'remote-control-settings';
    const form = document.createElement('form');
    form.method = 'dialog';
    const heading = document.createElement('h3');
    heading.textContent = this._tr('request_settings', {}, 'Remote control settings');
    form.append(heading);
    const sharedLabel = (key, fallback) => {
      const translated = window.t?.(`voice.${key}`);
      return translated && translated !== `voice.${key}` ? translated : fallback;
    };
    const option = (name, labelText, values, initial) => {
      const label = document.createElement('label');
      label.textContent = labelText;
      const select = document.createElement('select');
      select.name = name;
      for (const [value, text] of values) select.add(new Option(text, value));
      if (values.some(([value]) => String(value) === String(initial))) select.value = initial;
      label.append(select);
      form.append(label);
    };
    const quality = this.app.voice;
    option('resolution', sharedLabel('stream_quality_resolution', 'Resolution'), [
      [0, this._tr('native_resolution', {}, 'Native resolution')], ...[720, 1080, 1440].map(value => [value, `${value}p`]),
    ], quality?.screenResolution ?? 1080);
    option('fps', sharedLabel('stream_quality_fps', 'Frame rate'), [15, 30, 60].map(value => [value, `${value} fps`]),
      quality?.screenFrameRate ?? 60);
    const automatic = sharedLabel('gamestream_route_auto', 'Automatic');
    const bitrateOptions = document.getElementById('gamestream-bitrate-select')?.options;
    const bitrates = [2000, 4000, 6000, 8000, 12000, 16000, 20000];
    option('bitrateKbps', this._tr('request_bitrate', {}, 'Bitrate'), [[0, automatic],
      ...(bitrateOptions ? Array.from(bitrateOptions).filter(item => Number(item.value) > 0)
        .map(item => [Number(item.value), item.textContent]) : bitrates.map(value => [value, `${value / 1000} Mbps`]))],
    Number(localStorage.getItem('haven_gamestream_bitrate')));
    option('connectionPreference', sharedLabel('gamestream_route_label', 'GameStream connection'), [
      ['ip-direct', 'IP direct'], ['auto', automatic], ['ice-direct', 'ICE direct only'],
      ['relay', 'Automatic relay'], ['turn-tcp', 'TURN over TCP only'], ['turn-udp', 'TURN over UDP only'],
    ].map(([value, text]) => [value, sharedLabel(`gamestream_route_${value.replaceAll('-', '_')}`, text)]), 'ip-direct');
    const actions = document.createElement('div');
    actions.className = 'remote-control-settings-actions';
    for (const [value, label] of [
      ['cancel', this._tr('request_cancel', {}, 'Cancel')],
      ['request', this._tr('request_control', {}, 'Request control')],
    ]) {
      const button = document.createElement('button');
      button.type = 'submit';
      button.className = 'remote-control-option';
      button.value = value;
      button.textContent = label;
      actions.append(button);
    }
    form.append(actions);
    picker.append(form);
    document.body.append(picker);
    try {
      await new Promise(resolve => {
        picker.addEventListener('close', resolve, { once: true });
        picker.showModal();
      });
      if (picker.returnValue !== 'request') return null;
      const values = new FormData(form);
      return {
        resolution: Number(values.get('resolution')), fps: Number(values.get('fps')),
        bitrateKbps: Number(values.get('bitrateKbps')), connectionPreference: values.get('connectionPreference'),
      };
    } finally {
      this.requestPicker = null;
      picker.remove();
    }
  }

  _showDesktopRequirement(key) {
    const message = key === 'host_desktop_required'
      ? 'The host needs an updated Windows Ciacord desktop app and one active display.'
      : 'The controller needs an updated Windows Ciacord desktop app.';
    this._toast(this._tr(key, {}, message), 'error');
  }

  _bindSocketEvents() {
    this.socket.on('remote-control-requested', data => this._onRequested(data));
    this.socket.on('remote-control-request-ended', data => {
      if (data?.reason === 'declined') this._toast(this._tr('declined', {}, 'Remote assistance request declined.'), 'info');
      else if (data?.reason === 'expired') this._toast(this._tr('request_expired', {}, 'Remote assistance request expired.'), 'info');
    });
    this.socket.on('remote-control-session-start', data => this._startSession(data));
    this.socket.on('remote-control-signal', data => {
      const session = this.session;
      if (!session || session.id !== data?.sessionId || session.ending) return;
      this._handleSignal(session, data).catch(error => this._fail(session, error));
    });
    this.socket.on('remote-control-session-ended', data => {
      if (this.session && data?.sessionId === this.session.id) this.end(data.reason || 'ended', true);
    });
  }

  async _onRequested(data) {
    if (!data?.requestId || !data.from || this.app.currentChannel !== data.channelCode) return;
    const isHost = data.role === 'host';
    const promptText = isHost
      ? this._tr('confirm_control', { name: data.from.username }, `${data.from.username} is requesting control of this computer. Accept the request?`)
      : this._tr('confirm_assist', { name: data.from.username }, `${data.from.username} is inviting you to remotely assist them. Accept the invitation?`);
    const accepted = await this.app._showConfirmModal(
      this._tr('menu', {}, 'Remote assistance'),
      promptText,
      { danger: isHost }
    );
    if (!this.socket.connected || this.app.currentChannel !== data.channelCode) return;
    this.socket.emit('remote-control-response', { requestId: data.requestId, accepted }, response => {
      if (response?.error) this._toast(response.error, 'error');
    });
  }

  async _startSession(data) {
    if (!data?.sessionId || !data.peer || !['host', 'controller'].includes(data.role)) return;
    if (this.session) this.end('replaced');
    const session = { id: data.sessionId, code: data.channelCode, role: data.role, peer: data.peer, settings: data.settings };
    this.session = session;
    if (session.role === 'host') return;

    try {
      this._showControllerOverlay(session);
      const prepared = await this.api?.prepareAssistanceViewer(session.id);
      if (!await this._useNative(session, prepared)) return;
      session.transferCapable = prepared.transfer === true;
      session.captureCapable = prepared.captureShortcuts === true;
      if (!await this._signal(session, 'viewer', { watchId: prepared.id, certificate: prepared.certificate, transfer: prepared.transfer })) {
        throw new Error('Viewer registration failed');
      }
    } catch (error) {
      this._fail(session, error);
    }
  }

  _signal(session, kind, data = {}) {
    if (this.session !== session || session.ending || !this.socket.connected) return Promise.resolve(false);
    return new Promise(resolve => {
      this.socket.timeout(7000).emit('remote-control-signal', { sessionId: session.id, kind, ...data },
        (error, result) => resolve(!error && result?.ok === true));
    });
  }

  async _useNative(session, prepared) {
    if (this.session !== session || session.ending) {
      if (prepared) await this.api.stop(prepared.id);
      return false;
    }
    if (!prepared) throw new Error('The desktop could not prepare the session');
    session.nativeId = prepared.id;
    session.lease = setInterval(async () => {
      if (!await this.api.lease(prepared.id).catch(() => false)) {
        this._fail(session, new Error('The desktop stream closed'));
      }
    }, 2500);
    return true;
  }

  async _handleSignal(session, data) {
    if (session.role === 'host' && data.kind === 'viewer') {
      session.watchId = data.watchId;
      const config = await this._loadIceConfig();
      if (this.session !== session || session.ending) return;
      const nat = this.api.probeNAT?.(config.iceServers).catch(() => 'unknown');
      const prepared = await this.api?.prepareAssistanceHost({
        sessionId: session.id,
        watchId: data.watchId,
        transfer: data.transfer === true,
        certificate: data.certificate,
        controllerName: session.peer.username,
        servers: config.iceServers,
        relayOnly: config.iceTransportPolicy === 'relay',
        resolution: this.app.voice?.screenResolution,
        fps: this.app.voice?.screenFrameRate,
        bitrateKbps: Number(localStorage.getItem('haven_gamestream_bitrate')),
        ...session.settings,
      });
      if (!await this._useNative(session, prepared)) return;
      this._showHostBanner(session);
      if (!await this._signal(session, 'offer', { endpoint: { ...prepared, nat: await nat } })) throw new Error('Host offer failed');
    } else if (session.role === 'host' && data.kind === 'answer') {
      if (!await this.api.answerIce({ id: session.nativeId, watchId: session.watchId, answer: data.answer })) {
        throw new Error('The host tunnel rejected the answer');
      }
    } else if (session.role === 'host' && data.kind === 'playing') {
      await this.api.assistancePlaying(session.nativeId);
    } else if (session.role === 'controller' && data.kind === 'offer') {
      const endpoint = data.endpoint;
      session.transfer = endpoint.transfer === true && session.transferCapable;
      const config = await this._loadIceConfig();
      if (this.session !== session || session.ending) return;
      const connectionPreference = session.settings?.connectionPreference;
      session.metrics = { sharerId: session.peer.id, videoBytes: 0, routePreference: connectionPreference,
        localNat: 'pending', hostNat: endpoint.nat };
      this.api.probeNAT?.(config.iceServers).then(nat => { session.metrics.localNat = nat; }).catch(() => {
        session.metrics.localNat = 'unknown';
      });
      const relayOnly = endpoint.relayOnly || config.iceTransportPolicy === 'relay';
      const answer = await this.api.prepareAssistanceIce({
        id: session.nativeId, certificate: endpoint.certificate, offer: endpoint.iceOffer,
        basePort: endpoint.basePort, servers: config.iceServers, relayOnly, transfer: session.transfer, connectionPreference,
      });
      if (!answer || !await this._signal(session, 'answer', { answer })) throw new Error('The viewer tunnel could not start');
      if (this.session !== session || session.ending) return;
      session.playback = createGameStreamPlayback({
        requestKeyFrame: () => this.api.requestKeyFrame(session.nativeId).catch(() => {}),
        onError: error => this._fail(session, error),
      });
      session.metrics.playback = session.playback;
      this._attachRemoteVideo(session, session.playback.stream);
      const connection = await this.api.connectViewer({
        id: session.nativeId, certificate: endpoint.certificate, basePort: endpoint.basePort,
        videoMode: endpoint.videoMode, bitrateKbps: endpoint.bitrateKbps, connectionMode: 'relay',
      });
      if (!connection) throw new Error('Moonlight could not connect to the host');
      session.metrics.route ??= connection.route;
      session.metrics.address ??= connection.address;
    }
  }

  _fail(session, error) {
    if (this.session !== session || session.ending) return;
    console.warn('[RemoteControl]', error);
    this.end('connection-failed');
  }

  async _loadIceConfig() {
    const fallback = {
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.relay.metered.ca:80' },
      ],
    };
    try {
      const token = localStorage.getItem('haven_token');
      const response = await fetch('/api/ice-servers', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) return fallback;
      const data = await response.json();
      return {
        iceServers: Array.isArray(data.iceServers) && data.iceServers.length ? data.iceServers : fallback.iceServers,
        ...(data.iceTransportPolicy === 'relay' ? { iceTransportPolicy: 'relay' } : {}),
      };
    } catch { return fallback; }
  }

  _showHostBanner(session) {
    document.getElementById('remote-control-host-banner')?.remove();
    const banner = document.createElement('div');
    banner.id = 'remote-control-host-banner';
    banner.className = 'remote-control-host-banner';
    banner.innerHTML = `<span class="remote-control-live-dot"></span><span>${this._escape(this._tr('host_banner', { name: session.peer.username }, `${session.peer.username} can control this computer`))}</span><button type="button">${this._escape(this._tr('stop_control', {}, 'Stop control'))}</button>`;
    banner.querySelector('button').addEventListener('click', () => this.end('host-stopped'));
    document.body.appendChild(banner);
  }

  _showControllerOverlay(session) {
    document.getElementById('remote-control-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'remote-control-overlay';
    overlay.className = 'remote-control-overlay';
    overlay.innerHTML = `
      <div class="remote-control-window">
        <div class="remote-control-toolbar">
          <span>${this._escape(this._tr('window_title', { name: session.peer.username }, `Remote assistance with ${session.peer.username}`))}</span>
          <span class="remote-control-status">${this._escape(this._tr('waiting', {}, 'Waiting for shared screen…'))}</span>
          <select class="remote-control-option remote-control-capture" hidden
            aria-label="${this._escape(this._tr('capture_label', {}, 'Capture system shortcuts'))}">
            <option value="off">${this._escape(this._tr('capture_off', {}, 'Shortcuts off'))}</option>
            <option value="fullscreen">${this._escape(this._tr('capture_fullscreen', {}, 'Capture in fullscreen'))}</option>
            <option value="focused">${this._escape(this._tr('capture_focused', {}, 'Capture while focused'))}</option>
          </select>
          <button type="button" class="remote-control-option remote-control-cursor"></button>
          <button type="button" class="remote-control-option remote-control-fullscreen"></button>
          <button type="button" class="remote-control-stop">${this._escape(this._tr('end_session', {}, 'End session'))}</button>
        </div>
        <div class="remote-control-stage">
          <video class="remote-control-video" autoplay muted playsinline tabindex="0"></video>
          <div class="remote-control-empty">${this._escape(this._tr('waiting_for_screen', { name: session.peer.username }, `Waiting for ${session.peer.username} to choose a screen…`))}</div>
        </div>
      </div>`;
    overlay.querySelector('.remote-control-stop').addEventListener('click', () => this.end('controller-stopped'));
    document.body.appendChild(overlay);
    this._bindViewerOptions(session, overlay);
  }

  _bindViewerOptions(session, overlay) {
    const video = overlay.querySelector('video');
    const cursor = overlay.querySelector('.remote-control-cursor');
    const fullscreen = overlay.querySelector('.remote-control-fullscreen');
    const capture = overlay.querySelector('.remote-control-capture');
    const isFullscreen = () => document.fullscreenElement === overlay;
    let hidden = localStorage.getItem('ciacord_remote_cursor_hidden') === 'true';
    const savedMode = localStorage.getItem('ciacord_remote_shortcuts');
    capture.value = ['off', 'fullscreen', 'focused'].includes(savedMode) ? savedMode : 'fullscreen';

    const updateCursor = () => {
      video.classList.toggle('remote-control-cursor-hidden', hidden);
      cursor.textContent = hidden ? this._tr('cursor_show', {}, 'Show pointer') : this._tr('cursor_hide', {}, 'Hide pointer');
      cursor.setAttribute('aria-pressed', String(hidden));
    };
    const toggleCursor = () => {
      hidden = !hidden;
      localStorage.setItem('ciacord_remote_cursor_hidden', String(hidden));
      updateCursor();
    };
    const updateFullscreen = () => {
      fullscreen.textContent = isFullscreen()
        ? this._tr('fullscreen_exit', {}, 'Exit fullscreen') : this._tr('fullscreen_enter', {}, 'Fullscreen');
      fullscreen.setAttribute('aria-pressed', String(isFullscreen()));
      syncCapture();
    };
    const toggleFullscreen = async () => {
      try {
        if (isFullscreen()) await document.exitFullscreen();
        else await overlay.requestFullscreen();
        video.focus({ preventScroll: true });
      } catch (error) {
        console.warn('[RemoteControl] Fullscreen unavailable', error);
      }
    };
    const syncCapture = async () => {
      if (!session.captureCapable || !session.inputCleanup || session.ending) return;
      const enabled = document.activeElement === video && document.hasFocus() &&
        (capture.value === 'focused' || capture.value === 'fullscreen' && isFullscreen());
      const revision = session.captureRevision = (session.captureRevision || 0) + 1;
      const active = await this.api.captureAssistanceShortcuts(session.nativeId, enabled).catch(() => false);
      if (session.captureRevision !== revision || session.ending) return;
      session.capturing = active;
      if (enabled && !active) this._toast(this._tr('capture_failed', {}, 'Could not capture system shortcuts.'), 'error');
    };
    const saveCapture = () => {
      localStorage.setItem('ciacord_remote_shortcuts', capture.value);
      video.focus({ preventScroll: true });
      syncCapture();
    };
    session.localShortcut = (action, result) => {
      if (action === 'fullscreen') toggleFullscreen();
      else if (action === 'cursor') toggleCursor();
      else if (action === 'capture' && session.captureCapable) {
        capture.value = capture.value === 'off' ? 'focused' : 'off';
        saveCapture();
      } else if (action === 'released') {
        session.captureRevision++;
        session.capturing = false;
      } else if (action === 'paste') {
        video.parentElement.dispatchEvent(new CustomEvent('haven-assistance-paste-result', { detail: result }));
      }
    };
    cursor.addEventListener('click', toggleCursor);
    fullscreen.addEventListener('click', toggleFullscreen);
    capture.addEventListener('change', saveCapture);
    capture.title = 'Ctrl+Alt+Shift+K';
    fullscreen.title = 'Ctrl+Alt+Shift+X';
    cursor.title = 'Ctrl+Alt+Shift+C';
    video.addEventListener('focus', syncCapture);
    video.addEventListener('blur', syncCapture);
    window.addEventListener('focus', syncCapture);
    document.addEventListener('fullscreenchange', updateFullscreen);
    session.optionsCleanup = () => {
      window.removeEventListener('focus', syncCapture);
      document.removeEventListener('fullscreenchange', updateFullscreen);
      if (isFullscreen()) document.exitFullscreen().catch(() => {});
    };
    session.enableViewerOptions = () => {
      capture.hidden = !session.captureCapable;
      syncCapture();
    };
    updateCursor();
    updateFullscreen();
  }

  _attachRemoteVideo(session, stream) {
    const video = document.querySelector('#remote-control-overlay .remote-control-video');
    if (!video) return;
    video.style.display = 'block';
    video.style.visibility = 'hidden';
    video.addEventListener('loadeddata', async () => {
      if (this.session !== session || session.ending) return;
      if (!await this._signal(session, 'playing')) return this._fail(session, new Error('Session expired'));
      if (this.session !== session || session.ending) return;
      video.style.visibility = 'visible';
      document.querySelector('#remote-control-overlay .remote-control-empty')?.remove();
      this._setStatus(this._tr('click_to_control', {}, 'Click the shared screen to control it'));
      this._bindControllerInput(session, video);
      session.enableViewerOptions?.();
      const overlay = document.getElementById('remote-control-overlay');
      if (session.metrics && overlay) {
        attachStreamPerformance(overlay.querySelector('.remote-control-toolbar'), video,
          { gameStream: { viewer: session.metrics } }, session.peer.id);
      }
      if (session.transfer) {
        const stage = video.parentElement;
        stage.dataset.transferId = session.nativeId;
        this._setStatus(this._tr('transfer_ready', {}, 'Click to control · Ctrl+V to paste text · Drop files here'));
        stage.addEventListener('dragover', event => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        });
        stage.addEventListener('drop', event => {
          if (!event.isTrusted || !event.dataTransfer.files.length) return;
          event.preventDefault();
          this._setStatus(this._tr('transfer_sending', {}, 'Sending files…'));
        });
        stage.addEventListener('haven-assistance-paste-result', event => {
          if (event.detail === 'empty') {
            this._toast(this._tr('clipboard_empty', {}, 'The local clipboard has no text.'), 'info');
          } else if (event.detail !== 'saved') {
            this._toast(this._tr('clipboard_failed', {}, 'Could not paste the local clipboard.'), 'error');
          }
        });
        stage.addEventListener('haven-assistance-file-result', event => {
          const result = event.detail;
          const labels = {
            saved: this._tr('transfer_saved', {}, 'Files saved on the remote computer.'),
            partial: this._tr('transfer_partial', {}, 'Some files were saved on the remote computer.'),
          };
          this._setStatus(labels[result] || this._tr('transfer_failed', {}, 'File transfer was declined or failed.'));
        });
      }
    }, { once: true });
    video.srcObject = stream;
    video.play().catch(error => this._fail(session, error));
  }

  _bindControllerInput(session, video) {
    const listeners = [];
    const keys = new Set();
    const buttons = new Set();
    let interceptedPaste = false;
    const localKeys = new Set();
    let queuedMove;
    let frame;
    const listen = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      listeners.push(() => target.removeEventListener(type, handler, options));
    };
    const send = (...events) => this.api.sendAssistanceInput(session.nativeId, events);
    const point = event => {
      const rect = video.getBoundingClientRect();
      const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
      const width = video.videoWidth * scale;
      const height = video.videoHeight * scale;
      if (!width || !height) return null;
      const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
      const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return null;
      return [1, Math.round(x * 10000), Math.round(y * 10000), 0];
    };
    const clearMove = () => {
      cancelAnimationFrame(frame);
      frame = null;
      queuedMove = null;
    };
    listen(video, 'pointermove', event => {
      if (!event.isTrusted || document.activeElement !== video) return;
      queuedMove = point(event);
      if (!queuedMove || frame != null) return;
      frame = requestAnimationFrame(() => {
        if (queuedMove) send(queuedMove);
        clearMove();
      });
    });
    listen(video, 'pointerdown', event => {
      if (!event.isTrusted) return;
      const position = point(event);
      const button = event.button + 1;
      if (!position || button < 1 || button > 5) return;
      event.preventDefault();
      video.focus({ preventScroll: true });
      clearMove();
      send(position, [2, button, 1, 0]);
      buttons.add(button);
    });
    listen(window, 'pointerup', event => {
      const button = event.button + 1;
      if (!event.isTrusted || !buttons.delete(button)) return;
      send([2, button, 0, 0]);
    }, true);
    listen(video, 'contextmenu', event => event.preventDefault());
    listen(video, 'wheel', event => {
      if (!event.isTrusted || document.activeElement !== video || !point(event)) return;
      event.preventDefault();
      send([4, Math.sign(event.deltaX) * 120, -Math.sign(event.deltaY) * 120, 0]);
    }, { passive: false });

    const keyEvent = (code, down) => [3, KEY_CODES.get(code), Number(down), EXTENDED_KEYS.has(code) ? 0x10 : 0];
    listen(window, 'keydown', event => {
      if (!event.isTrusted || document.activeElement !== video || !KEY_CODES.has(event.code)) return;
      if (event.code === 'Delete' && event.ctrlKey && event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey && event.altKey && event.shiftKey && !event.metaKey) {
        const action = { KeyC: 'cursor', KeyX: 'fullscreen', KeyK: 'capture' }[event.code];
        if (action) {
          localKeys.add(event.code);
          if (!event.repeat) session.localShortcut?.(action);
          return;
        }
      }
      if (session.transfer && event.code === 'KeyV' && event.ctrlKey &&
          !event.altKey && !event.shiftKey && !event.metaKey) {
        interceptedPaste = true;
        return;
      }
      if (event.repeat || keys.has(event.code)) return;
      keys.add(event.code);
      send(keyEvent(event.code, true));
    }, true);
    listen(window, 'keyup', event => {
      if (!event.isTrusted) return;
      if (localKeys.delete(event.code)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.code === 'KeyV' && interceptedPaste) {
        interceptedPaste = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!keys.delete(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
      send(keyEvent(event.code, false));
    }, true);
    const release = () => {
      interceptedPaste = false;
      clearMove();
      const events = [...Array.from(keys, code => keyEvent(code, false)),
        ...Array.from(buttons, button => [2, button, 0, 0])];
      for (let i = 0; i < events.length; i += 32) send(...events.slice(i, i + 32));
      keys.clear();
      buttons.clear();
    };
    listen(video, 'blur', release);
    listen(video, 'pointercancel', release);
    listen(window, 'blur', release);
    session.inputCleanup = () => {
      release();
      listeners.splice(0).forEach(remove => remove());
    };
  }

  _setStatus(text) {
    const status = document.querySelector('.remote-control-status');
    if (status) status.textContent = text;
  }

  end(reason = 'ended', fromServer = false) {
    const session = this.session;
    if (!session || session.ending) return;
    session.ending = true;
    if (!fromServer && this.socket.connected) this.socket.emit('remote-control-end', { sessionId: session.id, reason });
    clearInterval(session.lease);
    session.inputCleanup?.();
    session.optionsCleanup?.();
    session.playback?.close();
    this.api?.stopAssistance(session.id).catch(() => {});
    document.getElementById('remote-control-overlay')?.remove();
    document.getElementById('remote-control-host-banner')?.remove();
    this.session = null;
    this._toast(this._reasonText(reason), reason === 'connection-failed' ? 'error' : 'info');
  }

  _reasonText(reason) {
    const labels = {
      'connection-failed': this._tr('connection_failed', {}, 'Could not establish the Moonlight remote assistance session.'),
      'setup-timeout': this._tr('connection_failed', {}, 'Could not establish the Moonlight remote assistance session.'),
      'emergency-stop': this._tr('ended_emergency', {}, 'Remote control stopped with the emergency shortcut.'),
      'screen-share-ended': this._tr('ended_screen', {}, 'Remote assistance ended because screen sharing stopped.'),
      'channel-changed': this._tr('ended_channel', {}, 'Remote assistance ended because a participant changed channels.'),
      'channel-left': this._tr('ended_channel', {}, 'Remote assistance ended because a participant left the channel.'),
      'disconnected': this._tr('ended_disconnect', {}, 'Remote assistance ended because a participant disconnected.'),
      'expired': this._tr('ended_expired', {}, 'Remote assistance session expired.'),
    };
    return labels[reason] || this._tr('ended', {}, 'Remote assistance ended.');
  }

  _toast(message, type) {
    this.app._showToast?.(message, type || 'info', null, 6000);
  }

  _tr(key, params, fallback) {
    try {
      const translated = typeof window.t === 'function'
        ? window.t(`remote_control.${key}`, params || {})
        : (typeof t === 'function' ? t(`remote_control.${key}`, params || {}) : '');
      return translated && translated !== `remote_control.${key}` ? translated : fallback;
    } catch { return fallback; }
  }

  _escape(value) {
    return this.app._escapeHtml ? this.app._escapeHtml(String(value || 'User')) : String(value || 'User');
  }
}
