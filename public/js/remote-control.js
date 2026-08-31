// Haven remote assistance. Signaling uses Socket.IO; screen video and input
// travel peer-to-peer over a dedicated WebRTC connection.
(function () {
  const CONTROL_LABEL = 'haven-remote-input-v1';
  const POINTER_LABEL = 'haven-remote-pointer-v1';

  window.HavenRemoteControlManager = class HavenRemoteControlManager {
    constructor(app) {
      this.app = app;
      this.socket = app.socket;
      this.session = null;
      this.capability = {
        hostSupported: false,
        controllerSupported: typeof RTCPeerConnection !== 'undefined',
        platform: 'web',
        version: '1',
      };
      this._signalChain = Promise.resolve();
      this._bindSocketEvents();
      this._detectCapability();
      this.socket.on('connect', () => this.socket.emit('remote-control-capability', this.capability));
      this.socket.on('disconnect', () => {
        if (this.session) this.end('disconnected', true);
      });
      window.addEventListener('haven-desktop-remote-control-ready', () => this._detectCapability());
      window.addEventListener('haven-remote-control-revoked', event => {
        if (this.session && event.detail?.sessionId === this.session.id) {
          this.end(event.detail.reason || 'native-revoked', true);
        }
      });
    }

    async _detectCapability() {
      const bridge = window.havenDesktopRemoteControl;
      if (bridge?.getCapability) {
        try { this.capability = await bridge.getCapability(); } catch {}
      }
      this.socket.emit('remote-control-capability', this.capability);
    }

    request(targetUserId, targetName, mode = 'request') {
      if (!this.app.currentChannel) {
        this._toast(this._tr('open_channel', {}, 'Open a channel before starting remote assistance.'), 'error');
        return;
      }
      if (this.session) {
        this._toast(this._tr('already_active', {}, 'A remote assistance session is already active.'), 'error');
        return;
      }
      this.socket.emit('remote-control-request', {
        code: this.app.currentChannel,
        targetUserId,
        mode: mode === 'invite' ? 'invite' : 'request',
      }, response => {
        if (response?.error) return this._toast(response.error, 'error');
        const key = mode === 'invite' ? 'invitation_sent' : 'request_sent';
        this._toast(this._tr(key, { name: targetName || 'the selected user' }, `Request sent to ${targetName || 'the selected user'}.`), 'info');
      });
    }

    _bindSocketEvents() {
      this.socket.on('remote-control-requested', data => this._onRequested(data));
      this.socket.on('remote-control-request-ended', data => {
        if (data?.reason === 'declined') this._toast(this._tr('declined', {}, 'Remote assistance request declined.'), 'info');
        else if (data?.reason === 'expired') this._toast(this._tr('request_expired', {}, 'Remote assistance request expired.'), 'info');
      });
      this.socket.on('remote-control-session-start', data => this._startSession(data));
      this.socket.on('remote-control-signal', data => {
        this._signalChain = this._signalChain.then(() => this._handleSignal(data)).catch(error => {
          console.error('[RemoteControl] signaling failed:', error);
          this.end('signaling-failed');
        });
      });
      this.socket.on('remote-control-session-ended', data => {
        if (this.session && data?.sessionId === this.session.id) this.end(data.reason || 'ended', true);
      });
    }

    _onRequested(data) {
      if (!data?.requestId || !data.from) return;
      const isHost = data.role === 'host';
      const promptText = isHost
        ? this._tr('confirm_control', { name: data.from.username }, `${data.from.username} is requesting control of this computer. Accept the request?`)
        : this._tr('confirm_assist', { name: data.from.username }, `${data.from.username} is inviting you to remotely assist them. Accept the invitation?`);
      const accepted = window.confirm(promptText);
      this.socket.emit('remote-control-response', { requestId: data.requestId, accepted }, response => {
        if (response?.error) this._toast(response.error, 'error');
      });
    }

    async _startSession(data) {
      if (!data?.sessionId || !data.peer || !['host', 'controller'].includes(data.role)) return;
      if (this.session) await this.end('replaced');
      this.session = {
        id: data.sessionId,
        code: data.channelCode,
        role: data.role,
        peer: data.peer,
        pc: null,
        controlChannel: null,
        pointerChannel: null,
        nativeToken: null,
        screenStream: null,
        pendingCandidates: [],
        ending: false,
        pressedKeys: new Set(),
        pressedButtons: new Set(),
      };

      try {
        const rtcConfig = await this._loadIceConfig();
        if (!this.session || this.session.id !== data.sessionId) return;
        const pc = new RTCPeerConnection(rtcConfig);
        this.session.pc = pc;
        this._configurePeerConnection(pc, this.session);

        if (data.role === 'host') await this._startHost(this.session);
        else this._showControllerOverlay(this.session);
      } catch (error) {
        console.error('[RemoteControl] session start failed:', error);
        this._toast(`Remote assistance could not start: ${error.message || error}`, 'error');
        this.end('start-failed');
      }
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

    _configurePeerConnection(pc, session) {
      pc.onicecandidate = event => {
        if (!event.candidate || !this.session || this.session.id !== session.id) return;
        this.socket.emit('remote-control-signal', {
          sessionId: session.id,
          candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
        });
      };
      pc.onconnectionstatechange = () => {
        if (!this.session || this.session.id !== session.id) return;
        if (pc.connectionState === 'connected') this._setStatus(this._tr('connected', {}, 'Remote control connected'));
        if (['failed', 'closed'].includes(pc.connectionState)) this.end(`peer-${pc.connectionState}`);
        if (pc.connectionState === 'disconnected') {
          clearTimeout(session.disconnectTimer);
          session.disconnectTimer = setTimeout(() => {
            if (pc.connectionState === 'disconnected') this.end('peer-disconnected');
          }, 5000);
        }
      };
      pc.ondatachannel = event => this._adoptDataChannel(session, event.channel);
      pc.ontrack = event => {
        if (session.role !== 'controller' || event.track.kind !== 'video') return;
        const stream = event.streams?.[0] || new MediaStream([event.track]);
        session.remoteStream = stream;
        this._attachRemoteVideo(session, stream);
        event.track.onended = () => this.end('screen-share-ended');
      };
    }

    async _startHost(session) {
      const bridge = window.havenDesktopRemoteControl;
      if (!bridge?.authorize || !this.capability.hostSupported) {
        throw new Error('Hosting remote control requires Haven Desktop on Windows');
      }
      const authorization = await bridge.authorize({
        sessionId: session.id,
        controllerName: session.peer.username,
      });
      if (!authorization?.ok) throw new Error('Remote control was not authorized');
      session.nativeToken = authorization.token;

      const prepared = await bridge.prepareCapture({ sessionId: session.id, token: session.nativeToken });
      if (!prepared?.ok) throw new Error('Could not prepare a controllable display');
      session.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: false,
      });
      const videoTrack = session.screenStream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('No display was selected');
      videoTrack.onended = () => this.end('screen-share-ended');
      session.pc.addTrack(videoTrack, session.screenStream);

      this._adoptDataChannel(session, session.pc.createDataChannel(CONTROL_LABEL, { ordered: true }));
      this._adoptDataChannel(session, session.pc.createDataChannel(POINTER_LABEL, {
        ordered: false,
        maxRetransmits: 0,
      }));
      this._showHostBanner(session);

      const offer = await session.pc.createOffer();
      await session.pc.setLocalDescription(offer);
      this.socket.emit('remote-control-signal', {
        sessionId: session.id,
        description: session.pc.localDescription.toJSON
          ? session.pc.localDescription.toJSON()
          : session.pc.localDescription,
      });
    }

    _adoptDataChannel(session, channel) {
      if (channel.label === CONTROL_LABEL) session.controlChannel = channel;
      else if (channel.label === POINTER_LABEL) session.pointerChannel = channel;
      else { channel.close(); return; }
      channel.binaryType = 'arraybuffer';
      channel.onopen = () => {
        if (session.role === 'controller' && session.controlChannel?.readyState === 'open') {
          this._setStatus(this._tr('click_to_control', {}, 'Click the shared screen to control it'));
        }
      };
      channel.onmessage = event => {
        if (session.role !== 'host' || !session.nativeToken || typeof event.data !== 'string' || event.data.length > 1024) return;
        try {
          const payload = JSON.parse(event.data);
          if (payload.sessionId !== session.id || !payload.input) return;
          window.havenDesktopRemoteControl?.inject(session.nativeToken, payload.input);
        } catch {}
      };
    }

    async _handleSignal(data) {
      const session = this.session;
      if (!session || data?.sessionId !== session.id || !session.pc) return;
      const pc = session.pc;
      if (data.description) {
        const description = new RTCSessionDescription(data.description);
        await pc.setRemoteDescription(description);
        for (const candidate of session.pendingCandidates.splice(0)) {
          await pc.addIceCandidate(candidate).catch(() => {});
        }
        if (description.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.socket.emit('remote-control-signal', {
            sessionId: session.id,
            description: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription,
          });
        }
      } else if (data.candidate) {
        const candidate = new RTCIceCandidate(data.candidate);
        if (pc.remoteDescription) await pc.addIceCandidate(candidate);
        else session.pendingCandidates.push(candidate);
      }
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
            <button type="button" class="remote-control-stop">${this._escape(this._tr('end_session', {}, 'End session'))}</button>
          </div>
          <div class="remote-control-stage">
            <video class="remote-control-video" autoplay playsinline tabindex="0"></video>
            <div class="remote-control-empty">${this._escape(this._tr('waiting_for_screen', { name: session.peer.username }, `Waiting for ${session.peer.username} to choose a screen…`))}</div>
          </div>
        </div>`;
      overlay.querySelector('.remote-control-stop').addEventListener('click', () => this.end('controller-stopped'));
      document.body.appendChild(overlay);
    }

    _attachRemoteVideo(session, stream) {
      const video = document.querySelector('#remote-control-overlay .remote-control-video');
      if (!video) return;
      video.srcObject = stream;
      video.style.display = 'block';
      document.querySelector('#remote-control-overlay .remote-control-empty')?.remove();
      video.play().catch(() => {});
      this._bindControllerInput(session, video);
    }

    _bindControllerInput(session, video) {
      if (session.inputCleanup) session.inputCleanup();
      let queuedMove = null;
      let moveFrame = null;
      const listeners = [];
      const listen = (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        listeners.push(() => target.removeEventListener(type, handler, options));
      };
      const send = (input, pointer = false) => {
        const channel = pointer ? session.pointerChannel : session.controlChannel;
        if (!channel || channel.readyState !== 'open' || channel.bufferedAmount > 128 * 1024) return;
        channel.send(JSON.stringify({ sessionId: session.id, input }));
      };
      const normalizedPoint = event => {
        const rect = video.getBoundingClientRect();
        const vw = video.videoWidth || rect.width;
        const vh = video.videoHeight || rect.height;
        const scale = Math.min(rect.width / vw, rect.height / vh);
        const width = vw * scale;
        const height = vh * scale;
        const left = rect.left + (rect.width - width) / 2;
        const top = rect.top + (rect.height - height) / 2;
        const x = (event.clientX - left) / width;
        const y = (event.clientY - top) / height;
        if (x < 0 || x > 1 || y < 0 || y > 1) return null;
        return { x, y };
      };
      const buttonName = button => ['left', 'middle', 'right', 'back', 'forward'][button] || null;

      listen(video, 'pointermove', event => {
        queuedMove = normalizedPoint(event);
        if (!queuedMove || moveFrame) return;
        moveFrame = requestAnimationFrame(() => {
          moveFrame = null;
          if (queuedMove) send({ type: 'move', ...queuedMove }, true);
          queuedMove = null;
        });
      });
      listen(video, 'pointerdown', event => {
        const point = normalizedPoint(event);
        const button = buttonName(event.button);
        if (!point || !button) return;
        event.preventDefault();
        video.focus({ preventScroll: true });
        send({ type: 'move', ...point }, true);
        send({ type: 'mouseDown', button });
        session.pressedButtons.add(button);
      });
      listen(window, 'pointerup', event => {
        const button = buttonName(event.button);
        if (!button || !session.pressedButtons.has(button)) return;
        send({ type: 'mouseUp', button });
        session.pressedButtons.delete(button);
      }, true);
      listen(video, 'contextmenu', event => event.preventDefault());
      listen(video, 'wheel', event => {
        event.preventDefault();
        send({
          type: 'wheel',
          deltaX: event.deltaX ? Math.sign(event.deltaX) * 120 : 0,
          deltaY: event.deltaY ? -Math.sign(event.deltaY) * 120 : 0,
        });
      }, { passive: false });

      const keyboardActive = () => document.activeElement === video;
      listen(window, 'keydown', event => {
        if (!keyboardActive() || !event.code) return;
        if (event.code === 'Delete' && event.ctrlKey && event.altKey) return;
        event.preventDefault();
        if (!session.pressedKeys.has(event.code)) {
          session.pressedKeys.add(event.code);
        }
        // Preserve the browser's repeat cadence for held Backspace/arrows/text.
        send({ type: 'keyDown', code: event.code });
      }, true);
      listen(window, 'keyup', event => {
        if (!session.pressedKeys.has(event.code)) return;
        event.preventDefault();
        send({ type: 'keyUp', code: event.code });
        session.pressedKeys.delete(event.code);
      }, true);
      const releaseLocalInputs = () => {
        for (const code of session.pressedKeys) send({ type: 'keyUp', code });
        for (const button of session.pressedButtons) send({ type: 'mouseUp', button });
        session.pressedKeys.clear();
        session.pressedButtons.clear();
      };
      listen(window, 'blur', releaseLocalInputs);
      session.inputCleanup = () => {
        releaseLocalInputs();
        if (moveFrame) cancelAnimationFrame(moveFrame);
        listeners.splice(0).forEach(remove => remove());
      };
    }

    _setStatus(text) {
      const status = document.querySelector('.remote-control-status');
      if (status) status.textContent = text;
    }

    async end(reason = 'ended', fromServer = false) {
      const session = this.session;
      if (!session || session.ending) return;
      session.ending = true;
      if (!fromServer) this.socket.emit('remote-control-end', { sessionId: session.id, reason });
      clearTimeout(session.disconnectTimer);
      try { session.inputCleanup?.(); } catch {}
      try { session.controlChannel?.close(); } catch {}
      try { session.pointerChannel?.close(); } catch {}
      try { session.pc?.close(); } catch {}
      try { session.screenStream?.getTracks().forEach(track => track.stop()); } catch {}
      if (session.nativeToken) {
        try { await window.havenDesktopRemoteControl?.revoke({ token: session.nativeToken }); } catch {}
      }
      document.getElementById('remote-control-overlay')?.remove();
      document.getElementById('remote-control-host-banner')?.remove();
      this.session = null;
      this._toast(this._reasonText(reason), reason === 'declined' ? 'info' : 'info');
    }

    _reasonText(reason) {
      const labels = {
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
  };
})();
