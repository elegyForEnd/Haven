export function webRtcPerformance(stats, trackId) {
  const reports = Array.from(stats.values());
  const inbound = reports.find(report =>
    report.type === 'inbound-rtp' && (report.kind || report.mediaType) === 'video' &&
    report.trackIdentifier === trackId);
  const transports = reports.filter(report => report.type === 'transport');
  const transport = (inbound?.transportId && stats.get(inbound.transportId)) ||
    (transports.length === 1 ? transports[0] : null);
  const pair = transport?.selectedCandidatePairId && stats.get(transport.selectedCandidatePairId);
  const local = pair && stats.get(pair.localCandidateId)?.candidateType;
  const remote = pair && stats.get(pair.remoteCandidateId)?.candidateType;
  return {
    route: local === 'relay' || remote === 'relay' ? 'relay' : local && remote ? 'direct' : null,
    rtt: Number.isFinite(pair?.currentRoundTripTime) ? pair.currentRoundTripTime * 1000 : null,
    videoBytes: inbound?.bytesReceived,
  };
}

export function attachStreamPerformance(tile, video, voice, userId) {
  const details = document.createElement('details');
  details.className = 'stream-performance';
  const summary = document.createElement('summary');
  summary.textContent = 'ⓘ';
  summary.title = t('voice.stream_performance');
  summary.setAttribute('aria-label', summary.title);
  details.append(summary);
  const list = document.createElement('dl');
  const fields = new Map();
  const labels = new Map();
  const natFields = ['local_nat', 'host_nat'];
  for (const name of ['resolution', 'fps', 'connection', 'bitrate', 'rtt', 'dropped', 'address', ...natFields]) {
    const label = document.createElement('dt');
    label.textContent = t(`voice.stream_stats_${name}`);
    const value = document.createElement('dd');
    label.hidden = value.hidden = natFields.includes(name);
    value.textContent = '—';
    fields.set(name, value);
    labels.set(name, label);
    list.append(label, value);
  }
  const settings = document.createElement('dd');
  settings.className = 'stream-view-quality';
  settings.hidden = true;
  const resolution = document.createElement('select');
  const fps = document.createElement('select');
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  for (const [select, key, values, suffix] of [
    [resolution, 'resolution', [360, 480, 720, 1080, 1440], 'p'],
    [fps, 'fps', [15, 30, 60], ' fps'],
  ]) {
    const label = document.createElement('label');
    label.textContent = t(`voice.stream_quality_${key}`);
    for (const value of [0, ...values]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value ? `${value}${suffix}` : t('voice.gamestream_route_auto');
      select.append(option);
    }
    label.append(select);
    settings.append(label);
  }
  settings.append(status);
  list.append(settings);
  let appliedTrackId, appliedResolution = '0', appliedFps = '0';
  const applyQuality = async () => {
    const trackId = video.srcObject?.getVideoTracks()[0]?.id;
    resolution.disabled = fps.disabled = true;
    status.textContent = '';
    const success = await voice.setScreenViewQuality(userId, Number(resolution.value), Number(fps.value));
    resolution.disabled = fps.disabled = false;
    if (video.srcObject?.getVideoTracks()[0]?.id !== trackId) return;
    if (success) {
      appliedResolution = resolution.value;
      appliedFps = fps.value;
    } else {
      resolution.value = appliedResolution;
      fps.value = appliedFps;
      status.textContent = t('voice.stream_quality_failed');
    }
  };
  resolution.addEventListener('change', applyQuality);
  fps.addEventListener('change', applyQuality);
  details.append(list);
  tile.append(details);
  details.addEventListener('click', event => event.stopPropagation());
  details.addEventListener('dblclick', event => event.stopPropagation());

  let timer, previous, sampling = false, generation = 0;
  const set = (name, value) => { fields.get(name).textContent = value ?? '—'; };
  async function sample() {
    if (!details.open || !details.isConnected) {
      clearInterval(timer);
      return;
    }
    if (sampling) return;
    sampling = true;
    const currentGeneration = generation;
    try {
      const stream = video.srcObject;
      const gs = voice.gameStream?.viewer;
      const gameStream = gs?.sharerId === userId && gs.playback?.stream === stream;
      const trackId = stream?.getVideoTracks()[0]?.id;
      settings.hidden = !trackId || gameStream || !voice.setScreenViewQuality || voice._hasIndependentScreen(userId);
      if (trackId !== appliedTrackId) {
        appliedTrackId = trackId;
        resolution.value = appliedResolution = '0';
        fps.value = appliedFps = '0';
        status.textContent = '';
      }
      const connection = voice._nativeScreenPeers?.get(userId)?.connection || voice.peers?.get(userId)?.connection;
      let metrics = gameStream ? { route: gs.route || (gs.playing && !gs.relayPending ? 'direct' : null),
        rtt: gs.rtt, videoBytes: gs.videoBytes } : {};
      if (!gameStream && connection) {
        try {
          metrics = webRtcPerformance(await connection.getStats(), stream?.getVideoTracks()[0]?.id);
        } catch { /* ICE may be reconnecting. */ }
      }
      if (generation !== currentGeneration || video.srcObject !== stream || !details.isConnected) return;
      const now = performance.now();
      const quality = video.getVideoPlaybackQuality?.();
      const frames = quality && quality.totalVideoFrames - quality.droppedVideoFrames;
      const prior = previous?.stream === stream ? previous : null;
      const elapsed = prior ? (now - prior.now) / 1000 : 0;
      const frameDelta = frames - prior?.frames;
      const byteDelta = metrics.videoBytes - prior?.bytes;
      set('resolution', video.videoWidth && video.videoHeight ? `${video.videoWidth} × ${video.videoHeight}` : null);
      set('fps', elapsed && frameDelta >= 0 ? `${(frameDelta / elapsed).toFixed(1)} fps` : null);
      const protocol = gameStream ? 'GameStream' : 'WebRTC';
      const routeLabel = {
        relay: gameStream ? 'voice.stream_stats_haven_relay' : 'voice.stream_stats_relay',
        direct: 'voice.stream_stats_direct',
        'easytier-direct': 'voice.stream_stats_easytier_direct',
        'easytier-relay': 'voice.stream_stats_easytier_relay',
        'ice-direct': 'voice.stream_stats_ice_direct',
        'punch-direct': 'voice.stream_stats_punch_direct',
        'ice-relay': gs?.routePreference === 'turn-tcp' ? 'voice.gamestream_route_turn_tcp' :
          gs?.routePreference === 'turn-udp' ? 'voice.gamestream_route_turn_udp' : 'voice.stream_stats_turn_relay',
      }[metrics.route] || 'voice.stream_stats_pending';
      set('connection', `${protocol} · ${t(routeLabel)}`);
      set('bitrate', elapsed && byteDelta >= 0 ? `${(byteDelta * 8 / elapsed / 1000000).toFixed(2)} Mbps` : null);
      set('rtt', Number.isFinite(metrics.rtt) ? `${Math.round(metrics.rtt)} ms` : null);
      labels.get('rtt').textContent = t(gameStream && metrics.route === 'relay' ?
        'voice.stream_stats_server_rtt' : 'voice.stream_stats_rtt');
      set('dropped', quality?.droppedVideoFrames);
      set('address', gameStream ? (metrics.route === 'relay' ? location.host : gs.address) : null);
      for (const [index, name] of natFields.entries()) {
        labels.get(name).hidden = fields.get(name).hidden = !gameStream;
        const nat = gameStream && (index === 0 ? gs.localNat : gs.hostNat);
        const key = {
          public: 'public', stable: 'stable', 'destination-dependent': 'nat4', pending: 'pending',
        }[nat] || 'unknown';
        if (gameStream) set(name, t(`voice.stream_nat_${key}`));
      }
      previous = { stream, now, frames, bytes: metrics.videoBytes };
    } finally {
      sampling = false;
    }
  }
  details.addEventListener('toggle', () => {
    clearInterval(timer);
    generation++;
    previous = null;
    if (details.open) {
      sample();
      timer = setInterval(sample, 1000);
    }
  });
}
