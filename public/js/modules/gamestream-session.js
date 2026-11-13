import { createGameStreamPlayback } from './gamestream-playback.js?v=4.6.4';
import { GameStreamRelaySender, GameStreamRelayReceiver } from './gamestream-relay.js?v=4.6.13';

const TUNNEL_ONLY = new Set(['ice-direct', 'turn-tcp', 'turn-udp']);

function directIceServers(servers) {
  const urls = (servers || []).flatMap(server => [].concat(server.urls))
    .filter(url => typeof url === 'string');
  // A plain TURN listener can also answer unauthenticated STUN bindings.
  const coturn = urls.filter(url => /^turn:/i.test(url))
    .map(url => url.replace(/^turn:/i, 'stun:').split('?')[0]);
  return [...new Set([...coturn, ...urls.filter(url => /^stuns?:/i.test(url))])].map(urls => ({ urls }));
}

export class GameStreamSession {
  constructor(voice, socket, showError) {
    this.voice = voice;
    this.socket = socket;
    this.showError = showError;
    this.api = window.havenDesktop?.gameStream;
    this.announcements = new Map();
    socket.on('gamestream-viewer-request', data => this.accept(data));
    socket.on('gamestream-viewer-revoke', data => {
      const entry = this.host;
      if (this.current(entry) && data.code === entry.code && data.sessionId === entry.id) {
        this.api.revokeViewer({ id: entry.id, watchId: data.watchId }).catch(() => this.fail(entry));
      }
    });
    socket.on('gamestream-connect', data => this.connect(data));
    socket.on('gamestream-nat', data => {
      const entry = this.viewer;
      if (this.current(entry) && data.code === entry.code && data.sharerId === entry.sharerId &&
          data.sessionId === entry.signal.sessionId && data.watchId === entry.id) entry.hostNat = data.nat;
    });
    socket.on('gamestream-ice-answer', data => {
      const entry = this.host;
      if (this.current(entry) && data.code === entry.code && data.sessionId === entry.id) {
        this.api.answerIce?.({ id: entry.id, watchId: data.watchId, answer: data.answer }).catch(() => {});
      }
    });
    socket.on('gamestream-relay-start', async data => {
      const entry = this.host;
      if (!this.current(entry) || data.code !== entry.code || data.sessionId !== entry.id) return;
      if (!entry.relay?.active) entry.relay = new GameStreamRelaySender(socket, entry.signal,
        () => this.api.startRelay(entry.id).catch(() => {}));
      await this.api.startRelay(entry.id).catch(() => {});
    });
    socket.on('gamestream-relay-data', data => {
      const entry = this.viewer;
      if (this.current(entry) && entry.relayPending && data.code === entry.code &&
          data.sessionId === entry.signal.sessionId && data.watchId === entry.id) entry.relay?.push(data);
    });
    socket.on('gamestream-relay-ended', data => {
      const entry = this.viewer;
      if (this.current(entry) && data.sessionId === entry.signal.sessionId && data.watchId === entry.id) this.fail(entry);
    });
    this.api?.onRelayPackets?.(({ id, packets }) => {
      if (this.host?.id === id) for (const packet of packets) this.host.relay?.push(packet);
    });
    this.api?.onRelayEnded?.(({ id }) => {
      if (this.host?.id === id) {
        this.host.relay?.close();
        this.socket.emit('gamestream-relay-error', this.host.signal);
      }
    });
    socket.on('disconnect', () => {
      this.stopHost();
      this.stopViewer();
      this.announcements.clear();
    });
    this.api?.onPackets(({ id, packets }) => {
      const entry = this.viewer;
      if (entry?.nativeId === id && entry.playback) {
        if (entry.relayPending || entry.retrying) return;
        if (!entry.playing && packets.some(packet => packet.video)) {
          entry.playing = true;
          entry.route = entry.nativeRoute || 'direct';
          clearTimeout(entry.connectionTimer);
          this.socket.emit('gamestream-playing', entry.signal);
        }
        for (const packet of packets) {
          if (packet.video) entry.videoBytes = (entry.videoBytes || 0) + packet.data.byteLength;
          entry.playback.push(packet);
        }
      }
    });
    this.api?.onStats?.(({ id, rtt, address, route }) => {
      if (this.viewer?.nativeId === id && !this.viewer.relayPending && !this.viewer.retrying) {
        this.viewer.rtt = rtt;
        this.viewer.address = address;
        if (route) {
          this.viewer.nativeRoute = route;
          if (this.viewer.playing) this.viewer.route = route;
        }
      }
    });
    this.api?.onEnded(({ id }) => {
      if (this.host?.id === id) this.fail(this.host);
      if (this.viewer?.nativeId === id && !this.viewer.relayPending && !this.viewer.retrying) this.nextRoute(this.viewer);
    });
  }

  send(event, payload, timeoutResult = false) {
    if (!this.socket.connected) return Promise.resolve(false);
    return new Promise(resolve => this.socket.timeout(7000).emit(event, payload, (error, result) =>
      resolve(error ? timeoutResult : result === true || result?.ok === true)));
  }

  async readNAT() {
    if (!this.api?.probeNAT) return 'unknown';
    return await this.api.probeNAT(directIceServers(this.voice.rtcConfig?.iceServers)).catch(() => 'unknown') || 'unknown';
  }

  valid(entry) {
    return this.voice.inVoice && this.voice.currentChannel === entry.code &&
      this.voice._voiceSessionGeneration === entry.generation && this.socket.connected;
  }

  current(entry) {
    return entry && (this.host === entry || this.viewer === entry) && this.valid(entry);
  }

  keepAlive(entry, remote) {
    entry.timer = setInterval(async () => {
      if (!this.current(entry)) return this.fail(entry, false);
      if (entry.renewing) return;
      entry.renewing = true;
      try {
        const sent = performance.now();
        if (remote) {
          // Media traffic shares the same socket. Allow a late renewal while it remains connected.
          const renewed = await this.send('gamestream-lease', entry.signal,
            entry.relayPending || entry.relay?.active ? null : false);
          if (renewed === false) return this.fail(entry);
          if (renewed && entry.route === 'relay') entry.rtt = performance.now() - sent;
        }
        const id = entry.nativeId || entry.id;
        if (this.current(entry) && !entry.relayPending && !entry.retrying && !await this.api.lease(id) &&
            !entry.relayPending && !entry.retrying && id === (entry.nativeId || entry.id)) {
          if (entry === this.viewer && entry.playback) this.nextRoute(entry);
          else this.fail(entry);
        }
      } catch {
        this.fail(entry);
      } finally {
        entry.renewing = false;
      }
    }, 2500);
  }

  async start() {
    if (!this.api || this.host || this.voice.isScreenSharing || !this.voice.inVoice || !this.socket.connected) return false;
    const code = this.voice.currentChannel;
    const generation = this.voice._voiceSessionGeneration;
    let prepared;
    try {
      prepared = await this.api.prepareHost({
        relayOnly: this.voice.rtcConfig?.iceTransportPolicy === 'relay',
        connectionPreference: localStorage.getItem('haven_gamestream_connection'),
        resolution: this.voice.screenResolution,
        fps: this.voice.screenFrameRate,
        bitrateKbps: Number(localStorage.getItem('haven_gamestream_bitrate')),
      });
      if (!prepared) return false;
      const entry = { ...prepared, code, generation };
      if (!this.valid(entry)) {
        await this.api.stop(prepared.id);
        return false;
      }
      entry.signal = { code, sessionId: entry.id, sharerId: this.voice.localUserId };
      entry.nat = this.readNAT();
      this.host = entry;
      const accepted = await this.send('screen-share-started', {
        ...entry.signal, transport: 'gamestream', address: entry.address, addresses: entry.addresses,
        connectionMode: entry.connectionMode, basePort: entry.basePort,
        routePreference: entry.routePreference,
        bitrateKbps: entry.bitrateKbps,
        videoMode: entry.videoMode,
        ...(entry.punchVersion === 1 ? { punchVersion: 1 } : {}),
        certificate: entry.certificate, hasAudio: entry.hasAudio,
      });
      if (!accepted || !this.current(entry)) {
        this.fail(entry, !accepted);
        return false;
      }
      this.voice.isScreenSharing = true;
      this.voice.screenHasAudio = entry.hasAudio;
      this.voice.screenSharers.add(this.voice.localUserId);
      this.keepAlive(entry, true);
      return true;
    } catch {
      if (prepared && this.host?.id === prepared.id) this.fail(this.host);
      else this.showError();
      return false;
    }
  }

  async accept(data) {
    const entry = this.host;
    if (!this.current(entry) || data.code !== entry.code || data.sessionId !== entry.id) return;
    const { watchId, certificate } = data;
    let accepted = false;
    let easyTierReady = false;
    try {
      const host = await this.api.startHost({ id: entry.id, watchId, certificate, reportEasyTier: true });
      accepted = !!host;
      easyTierReady = host?.easyTierReady === true;
    } catch { /* Only this viewer was rejected. */ }
    if (!this.current(entry)) return;
    const iceRetry = data.iceRetry === true && entry.connectionMode === 'auto';
    const iceServers = this.voice.rtcConfig?.iceServers;
    const servers = iceRetry || entry.routePreference === 'ice-direct' ? directIceServers(iceServers) : iceServers;
    const iceOffer = accepted && data.iceVersion === 1 && (entry.connectionMode === 'relay' || iceRetry) &&
      entry.routePreference !== 'haven-relay' && this.api.prepareIce ?
      await this.api.prepareIce({ id: entry.id, watchId, certificate, servers, iceRetry })
        .catch(() => null) : null;
    if (!this.current(entry)) return;
    if (!await this.send('gamestream-ready', { ...entry.signal, watchId, accepted, iceRetry, easyTierReady,
      ...(iceOffer ? { iceOffer } : {}) }) || !accepted) {
      await this.api.revokeViewer({ id: entry.id, watchId }).catch(() => this.fail(entry));
    } else if (!iceRetry) {
      const nat = await entry.nat;
      if (nat && this.current(entry)) this.socket.emit('gamestream-nat', { ...entry.signal, watchId, nat });
    }
  }

  async watch(sharerId) {
    const announcement = this.announcements.get(sharerId);
    if (!announcement) return;
    if (!this.api?.revokeViewer || this.api.relayVersion !== 1 || !globalThis.VideoDecoder || !globalThis.AudioDecoder ||
        !globalThis.MediaStreamTrackGenerator) return this.showError('desktop');
    if (this.viewer || this.preparingViewer) return;
    this.preparingViewer = true;
    const code = this.voice.currentChannel;
    const generation = this.voice._voiceSessionGeneration;
    try {
      const prepared = await this.api.prepareViewer();
      if (!prepared) return this.showError('desktop');
      const entry = { ...prepared, nativeId: prepared.id, code, generation, sharerId };
      if (!this.valid(entry) || this.announcements.get(sharerId) !== announcement) {
        await this.api.stop(entry.id);
        return;
      }
      entry.signal = { code, sharerId, sessionId: announcement, watchId: entry.id };
      this.viewer = entry;
      entry.localNat = 'pending';
      this.readNAT().then(nat => { if (this.current(entry)) entry.localNat = nat; });
      entry.connectionTimer = setTimeout(() => this.fail(entry), 60000);
      if (!await this.send('gamestream-watch', { ...entry.signal, certificate: entry.certificate,
        ...(entry.connectionVersion === 1 ? { connectionVersion: 1 } : {}),
        ...(entry.punchVersion === 1 ? { punchVersion: 1 } : {}),
        ...(entry.iceVersion === 1 ? { iceVersion: 1, iceAfterDirect: !!this.api.retryViewer } : {}) })) {
        return this.fail(entry);
      }
      if (this.current(entry)) this.keepAlive(entry, true);
    } catch {
      if (this.viewer) this.fail(this.viewer);
      else this.showError();
    } finally {
      this.preparingViewer = false;
    }
  }

  async connect(data) {
    const entry = this.viewer;
    if (!this.current(entry) || data.code !== entry.code || data.sharerId !== entry.sharerId ||
        data.sessionId !== entry.signal.sessionId || data.watchId !== entry.id ||
        (data.iceRetry ? !entry.retrying : entry.playback)) return;
    try {
      clearTimeout(entry.connectionTimer);
      entry.retrying = false;
      entry.hasAudio = data.hasAudio;
      if (!data.iceRetry) {
        entry.routePreference = data.endpoint.routePreference;
        entry.iceAfterDirect = data.iceAfterDirect && !!this.api.retryViewer;
      }
      entry.connectionTimer = setTimeout(() => this.nextRoute(entry), data.iceOffer ? 40000 : 25000);
      entry.playback ??= createGameStreamPlayback({
        requestKeyFrame: () => entry.relayPending ? this.socket.emit('gamestream-relay-keyframe', entry.signal) :
          this.api.requestKeyFrame(entry.nativeId).catch(() => {}),
        onError: () => this.fail(entry),
      });
      const relayOnly = data.endpoint.connectionMode === 'relay';
      if (entry.routePreference === 'haven-relay') return this.useRelay(entry);
      let answered = false;
      if (data.iceOffer && this.api.prepareIce) {
        const iceServers = this.voice.rtcConfig?.iceServers;
        const answer = await this.api.prepareIce({
          ...data.endpoint, id: entry.nativeId, watchId: entry.nativeId, offer: data.iceOffer,
          servers: data.endpoint.routePreference === 'ice-direct' ? directIceServers(iceServers) : iceServers,
          relayOnly,
        }).catch(() => null);
        if (!this.current(entry) || entry.relayPending) return;
        if (answer) answered = await this.send('gamestream-ice-answer', { ...entry.signal, answer });
      }
      if (!this.current(entry) || entry.relayPending) return;
      if (relayOnly && !answered) return this.nextRoute(entry);
      const nativeId = entry.nativeId;
      const connection = await this.api.connectViewer({ ...data.endpoint, id: nativeId });
      if (entry.retrying || entry.nativeId !== nativeId) return;
      if (!connection || !this.current(entry)) {
        return this.nextRoute(entry);
      }
      if (entry.relayPending) return;
      entry.nativeRoute = connection.route || 'direct';
      if (entry.playing) entry.route = entry.nativeRoute;
      if (connection.address) entry.address = connection.address;
      this.attachViewer(entry);
    } catch {
      this.nextRoute(entry);
    }
  }

  async nextRoute(entry) {
    if (!this.current(entry) || entry.relayPending || entry.retrying) return;
    if (!entry.iceAfterDirect) return this.useRelay(entry);
    entry.iceAfterDirect = false;
    entry.retrying = true;
    entry.playing = false;
    entry.route = null;
    entry.nativeRoute = null;
    entry.rtt = undefined;
    entry.address = undefined;
    entry.playback.resetVideo();
    clearTimeout(entry.connectionTimer);
    entry.connectionTimer = setTimeout(() => {
      entry.retrying = false;
      this.useRelay(entry);
    }, 35000);
    try {
      const next = await this.api.retryViewer(entry.nativeId);
      if (!this.current(entry) || entry.relayPending) {
        if (next) await this.api.stop(next.id);
        return;
      }
      if (next) {
        entry.nativeId = next.id;
        if (await this.send('gamestream-try-ice', { ...entry.signal, certificate: next.certificate })) return;
        if (!entry.retrying) return;
      }
    } catch { /* Haven relay is the final route. */ }
    entry.retrying = false;
    this.useRelay(entry);
  }

  attachViewer(entry) {
    if (!this.current(entry) || entry.attached) return;
    entry.attached = true;
    this.voice._screenDelivered.add(entry.sharerId);
    this.voice.onScreenStream?.(entry.sharerId, entry.playback.stream, { force: true });
    if (entry.hasAudio) this.voice._playScreenAudio(entry.sharerId, entry.playback.stream);
  }

  async useRelay(entry) {
    if (!this.current(entry) || entry.relayPending) return;
    if (TUNNEL_ONLY.has(entry.routePreference)) return this.fail(entry, 'connection');
    if (!this.api?.relayVersion || !entry.playback) return this.fail(entry);
    entry.relayPending = true;
    entry.playing = false;
    entry.route = null;
    entry.rtt = undefined;
    entry.playback.resetVideo();
    clearTimeout(entry.connectionTimer);
    entry.connectionTimer = setTimeout(() => this.fail(entry), 30000);
    entry.relay = new GameStreamRelayReceiver(entry.playback, bytes => {
      entry.videoBytes = (entry.videoBytes || 0) + bytes;
      entry.route = 'relay';
      entry.playing = true;
      clearTimeout(entry.connectionTimer);
    });
    await this.api.closeDirect(entry.nativeId).catch(() => {});
    if (!this.current(entry) || !await this.send('gamestream-relay-request', entry.signal)) this.fail(entry);
    else this.attachViewer(entry);
  }

  announce(userId, sessionId) {
    if (this.announcements.get(userId) === sessionId) return;
    this.clear(userId);
    this.announcements.set(userId, sessionId);
  }

  clear(userId) {
    this.announcements.delete(userId);
    if (this.viewer?.sharerId === userId) this.stopViewer();
  }

  stopHost() {
    const entry = this.host;
    if (!entry) return;
    this.host = null;
    clearInterval(entry.timer);
    entry.relay?.close();
    this.api.stop(entry.nativeId || entry.id).catch(() => {});
    this.voice.isScreenSharing = false;
    this.voice.screenHasAudio = false;
    this.voice.screenSharers.delete(this.voice.localUserId);
    this.socket.emit('screen-share-stopped', entry.signal);
    this.voice.onScreenStream?.(this.voice.localUserId, null);
    this.voice.onWebcamStatusChange?.();
  }

  stopViewer() {
    const entry = this.viewer;
    if (!entry) return;
    this.viewer = null;
    clearInterval(entry.timer);
    clearTimeout(entry.connectionTimer);
    if (entry.relay) entry.relay.pending = null;
    entry.playback?.close();
    this.api.stop(entry.nativeId).catch(() => {});
    this.socket.emit('gamestream-unwatch', entry.signal);
    this.voice.onScreenStream?.(entry.sharerId, null);
    document.getElementById(`voice-audio-screen-${entry.sharerId}`)?.remove();
    const gain = this.voice.screenGainNodes.get(entry.sharerId);
    gain?.disconnect();
    this.voice.screenGainNodes.delete(entry.sharerId);
  }

  fail(entry, show = true) {
    if (this.host === entry) this.stopHost();
    else if (this.viewer === entry) this.stopViewer();
    else return;
    if (show) this.showError(typeof show === 'string' ? show : undefined);
  }
}
