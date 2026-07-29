import Hls from '/vendor/hls.mjs';

function clampTime(value, duration = Infinity) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(number, Number.isFinite(duration) ? duration : Infinity));
}

function isSafeHlsMediaUrl(value) {
  try {
    const parsed = new URL(value, window.location.origin);
    return parsed.origin === window.location.origin
      && /^\/api\/bilibili-hls\/[a-f0-9]{24}\/\d{13}-[a-f0-9]{16}\/index\.m3u8$/i.test(parsed.pathname)
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

function safePlay(media) {
  try {
    const result = media.play();
    return result && typeof result.catch === 'function' ? result : Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
}

function getFiniteMediaDuration(mediaElement, fallbackDuration) {
  const knownDuration = Number(fallbackDuration);
  if (Number.isFinite(knownDuration) && knownDuration > 0) return knownDuration;
  const nativeDuration = Number(mediaElement?.duration);
  return Number.isFinite(nativeDuration) && nativeDuration > 0 ? nativeDuration : 0;
}

function isSafeMediaUrl(value, expectedMediaKind) {
  try {
    const parsed = new URL(value, window.location.origin);
    const pathMatch = parsed.pathname.match(/^\/api\/bilibili-stream\/([a-f0-9]{24})\/(video|audio)$/i);
    const streamVersion = parsed.searchParams.get('v');
    const retryNumber = parsed.searchParams.get('retry');
    const allowedParameterCount = retryNumber === null ? 1 : 2;
    return parsed.origin === window.location.origin
      && pathMatch
      && pathMatch[2].toLowerCase() === expectedMediaKind
      && parsed.searchParams.size === allowedParameterCount
      && /^\d{13}-\d+$/.test(streamVersion || '')
      && (retryNumber === null || /^\d{1,2}$/.test(retryNumber))
      && !parsed.hash;
  } catch {
    return false;
  }
}

export default {
  _destroyBilibiliPlayer() {
    const player = this._musicBiliPlayer;
    if (!player) return;
    player.destroy();
    this._musicBiliPlayer = null;
  },

  _initBilibiliPlayer(container, media, volume) {
    this._destroyBilibiliPlayer();
    if (container && isSafeHlsMediaUrl(media?.hlsUrl)) {
      const nativeHlsSupported = document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '';
      if (nativeHlsSupported || Hls.isSupported()) {
        const initialized = this._initBilibiliHlsPlayer(container, media, volume, nativeHlsSupported);
        if (initialized) return true;
      }
    }
    return this._initBilibiliDashPlayer(container, media, volume);
  },

  _initBilibiliHlsPlayer(container, media, volume, useNativeHls = false) {
    this._destroyBilibiliPlayer();
    if (!container || !isSafeHlsMediaUrl(media?.hlsUrl)) return false;

    container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'music-embed-wrapper bilibili-native-wrapper';
    const video = document.createElement('video');
    video.className = 'music-bilibili-video';
    video.playsInline = true;
    video.preload = 'auto';
    video.volume = Math.max(0, Math.min(100, Number(volume) || 0)) / 100;

    const unlock = document.createElement('button');
    unlock.type = 'button';
    unlock.className = 'bilibili-sync-unlock';
    unlock.textContent = 'Playback was blocked. Click to retry.';
    unlock.style.display = 'none';
    wrapper.append(video, unlock);
    container.appendChild(wrapper);

    let hls = null;
    let destroyed = false;
    let ready = false;
    let endedSent = false;
    let buffering = true;
    let fallbackStarted = false;
    let networkRecoveryAttempts = 0;
    let mediaRecoveryAttempts = 0;
    let networkRecoveryTimer = null;
    let refreshFallbackTimer = null;
    let pendingSeekTarget = null;
    let pendingSeekShouldResume = false;
    let pendingSeekRetryTimer = null;
    let pendingSeekLastAttemptAt = 0;
    let pendingSeekCanCompleteAt = 0;
    let playlistGeneratedTimelineEnd = 0;
    const trackId = this._musicTrackId;
    const seekConfirmationToleranceSeconds = 1.5;

    const getBufferedAhead = () => {
      if (!Number.isFinite(video.currentTime)) return 0;
      for (let rangeIndex = 0; rangeIndex < video.buffered.length; rangeIndex += 1) {
        const rangeStart = video.buffered.start(rangeIndex);
        const rangeEnd = video.buffered.end(rangeIndex);
        if (video.currentTime >= rangeStart - 0.1 && video.currentTime <= rangeEnd + 0.1) {
          return Math.max(0, rangeEnd - video.currentTime);
        }
      }
      return 0;
    };

    const canSeekTo = seconds => {
      const targetSeconds = Number(seconds);
      if (!Number.isFinite(targetSeconds)) return false;
      for (let rangeIndex = 0; rangeIndex < video.seekable.length; rangeIndex += 1) {
        if (targetSeconds >= video.seekable.start(rangeIndex) - 0.25
          && targetSeconds <= video.seekable.end(rangeIndex) + 0.25) return true;
      }
      for (let rangeIndex = 0; rangeIndex < video.buffered.length; rangeIndex += 1) {
        if (targetSeconds >= video.buffered.start(rangeIndex) - 0.25
          && targetSeconds <= video.buffered.end(rangeIndex) + 0.25) return true;
      }
      return false;
    };

    const updateGeneratedTimelineEndFromDetails = details => {
      if (!Array.isArray(details?.fragments)) return;
      for (const fragment of details.fragments) {
        const fragmentEnd = Number(fragment.start) + Number(fragment.duration);
        if (Number.isFinite(fragmentEnd)) {
          playlistGeneratedTimelineEnd = Math.max(
            playlistGeneratedTimelineEnd,
            fragmentEnd
          );
        }
      }
    };

    const getGeneratedTimelineEnd = () => {
      let generatedEnd = playlistGeneratedTimelineEnd;
      for (let rangeIndex = 0; rangeIndex < video.seekable.length; rangeIndex += 1) {
        generatedEnd = Math.max(generatedEnd, video.seekable.end(rangeIndex));
      }
      for (let rangeIndex = 0; rangeIndex < video.buffered.length; rangeIndex += 1) {
        generatedEnd = Math.max(generatedEnd, video.buffered.end(rangeIndex));
      }
      for (const level of hls?.levels || []) {
        updateGeneratedTimelineEndFromDetails(level?.details);
      }
      generatedEnd = Math.max(generatedEnd, playlistGeneratedTimelineEnd);
      return Number.isFinite(generatedEnd) ? generatedEnd : 0;
    };

    const showUnlock = () => {
      if (destroyed) return;
      unlock.style.display = '';
      this._setMusicActivityHint('Playback was blocked. Click the player to retry.');
    };

    const play = async () => {
      if (destroyed) throw new Error('media-not-ready');
      if (Number.isFinite(pendingSeekTarget)) {
        pendingSeekShouldResume = true;
        return;
      }
      try {
        await safePlay(video);
        unlock.style.display = 'none';
        this._setMusicActivityHint('');
      } catch {
        showUnlock();
        throw new Error('autoplay-blocked');
      }
    };

    const pause = () => {
      pendingSeekShouldResume = false;
      video.pause();
    };
    const completePendingSeek = () => {
      if (!Number.isFinite(pendingSeekTarget)) return;
      const shouldResume = pendingSeekShouldResume;
      pendingSeekTarget = null;
      pendingSeekShouldResume = false;
      pendingSeekLastAttemptAt = 0;
      pendingSeekCanCompleteAt = 0;
      clearInterval(pendingSeekRetryTimer);
      pendingSeekRetryTimer = null;
      buffering = video.readyState < 3;
      if (shouldResume) {
        safePlay(video).catch(() => {
          video.addEventListener('canplay', () => {
            if (!destroyed && this._musicPlaying) safePlay(video).catch(showUnlock);
          }, { once: true });
        });
      }
      this._setMusicActivityHint('');
    };

    const tryApplyPendingSeek = () => {
      if (destroyed || !Number.isFinite(pendingSeekTarget)) return;
      const targetSeconds = pendingSeekTarget;
      const currentSeconds = Number(video.currentTime);
      const reachedTarget = Number.isFinite(currentSeconds)
        && Math.abs(currentSeconds - targetSeconds) <= seekConfirmationToleranceSeconds;
      if (reachedTarget && !video.seeking && Date.now() >= pendingSeekCanCompleteAt) {
        completePendingSeek();
        return;
      }

      const generatedEnd = getGeneratedTimelineEnd();
      const generatedRangeIsKnown = generatedEnd > 0;
      if (generatedRangeIsKnown && targetSeconds > generatedEnd + 0.25) {
        this._setMusicActivityHint(
          `Preparing requested HLS position (${Math.floor(generatedEnd)}s / ${Math.floor(targetSeconds)}s)…`
        );
        return;
      }

      // Keep the target authoritative until the media element confirms the
      // seek. Clearing it immediately lets a rejected MediaSource seek redraw
      // the slider at the old position, which looks like an instant bounce.
      const attemptNow = Date.now();
      if (video.seeking || attemptNow - pendingSeekLastAttemptAt < 3000) return;
      pendingSeekLastAttemptAt = attemptNow;
      pendingSeekCanCompleteAt = attemptNow + 250;
      this._setMusicActivityHint(`Seeking Bilibili HLS to ${Math.floor(targetSeconds)}s…`);
      if (hls) hls.stopLoad();
      try { video.currentTime = targetSeconds; } catch {}
      if (hls) hls.startLoad(targetSeconds);
    };

    const seekTo = seconds => {
      const duration = getFiniteMediaDuration(video, media.duration);
      const targetSeconds = clampTime(seconds, duration || Infinity);
      pendingSeekTarget = targetSeconds;
      pendingSeekShouldResume = !!this._musicPlaying || !video.paused;
      pendingSeekLastAttemptAt = 0;
      pendingSeekCanCompleteAt = 0;
      buffering = true;
      video.pause();
      clearInterval(pendingSeekRetryTimer);
      pendingSeekRetryTimer = setInterval(tryApplyPendingSeek, 500);
      tryApplyPendingSeek();
    };

    const fallbackToDash = reason => {
      if (destroyed || fallbackStarted || this._musicTrackId !== trackId) return;
      fallbackStarted = true;
      const authoritativeState = this._getEffectiveMusicSyncState?.(this._musicAuthoritativeSyncState);
      const activeContainer = wrapper.parentElement || container;
      const fallbackSyncState = {
        isPlaying: typeof authoritativeState?.isPlaying === 'boolean'
          ? authoritativeState.isPlaying
          : !!this._musicPlaying,
        positionSeconds: Number(video.currentTime) || Number(authoritativeState?.positionSeconds) || 0,
        durationSeconds: getFiniteMediaDuration(video, media.duration) || null,
        updatedAt: Date.now()
      };
      this._setMusicActivityHint(`HLS playback failed (${reason}); switching to DASH…`);
      this._pendingMusicSyncState = fallbackSyncState;
      this._musicAuthoritativeSyncState = fallbackSyncState;
      this._suppressMusicBroadcasts?.(3000);
      this._destroyBilibiliPlayer();
      if (!this._initBilibiliDashPlayer(activeContainer, media, volume)) {
        this._showToast('Bilibili HLS and DASH playback are both unavailable.', 'error');
      }
    };

    const requestHlsRefresh = reason => {
      if (destroyed || fallbackStarted || !this.voice?.currentChannel || !trackId) {
        fallbackToDash(reason);
        return;
      }
      const previousRefresh = this._musicBiliRefreshGuard;
      const now = Date.now();
      if (previousRefresh?.trackId === trackId && now - previousRefresh.requestedAt < 30000) {
        fallbackToDash(`${reason}; HLS refresh already attempted`);
        return;
      }
      this._musicBiliRefreshGuard = { trackId, requestedAt: now };
      this._setMusicActivityHint(`Refreshing Bilibili HLS (${reason})…`);
      this.socket.emit('music-refresh-media', {
        code: this.voice.currentChannel,
        trackId
      });
      clearTimeout(refreshFallbackTimer);
      refreshFallbackTimer = setTimeout(() => {
        if (!destroyed && this._musicTrackId === trackId) {
          fallbackToDash('HLS refresh timed out');
        }
      }, 20000);
    };

    const onReady = () => {
      if (destroyed || ready) return;
      ready = true;
      buffering = false;
      if (this._musicBiliRefreshGuard?.trackId === trackId) delete this._musicBiliRefreshGuard;
      this._startMusicTimeTracking();
      this._flushPendingMusicSyncState();
    };

    video.addEventListener('loadedmetadata', onReady);
    video.addEventListener('canplay', () => {
      buffering = false;
      networkRecoveryAttempts = 0;
      tryApplyPendingSeek();
    });
    video.addEventListener('seeked', tryApplyPendingSeek);
    video.addEventListener('timeupdate', tryApplyPendingSeek);
    video.addEventListener('playing', () => {
      buffering = false;
      networkRecoveryAttempts = 0;
      this._setMusicPlayingUi(true);
      if (!Number.isFinite(pendingSeekTarget)) this._setMusicActivityHint('');
    });
    video.addEventListener('waiting', () => {
      if (video.paused || video.ended) return;
      buffering = true;
      if (getBufferedAhead() >= 3) return;
      this._setMusicActivityHint('Buffering Bilibili HLS…');
    });
    video.addEventListener('stalled', () => {
      if (video.paused || video.ended) return;
      buffering = true;
      if (getBufferedAhead() >= 3) return;
      this._setMusicActivityHint('Reconnecting Bilibili HLS…');
    });
    video.addEventListener('progress', tryApplyPendingSeek);
    video.addEventListener('durationchange', tryApplyPendingSeek);
    video.addEventListener('pause', () => {
      // Waiting for a not-yet-generated EVENT-HLS position pauses only the
      // media element; the shared room playback state must remain unchanged.
      if (Number.isFinite(pendingSeekTarget)) return;
      if (!video.ended) this._setMusicPlayingUi(false);
    });
    video.addEventListener('ended', () => {
      if (destroyed || endedSent) return;
      endedSent = true;
      this._setMusicPlayingUi(false);
      this._emitMusicFinished();
    });
    unlock.addEventListener('click', () => { void play().catch(() => {}); });

    if (useNativeHls) {
      video.addEventListener('error', () => requestHlsRefresh('native HLS error'));
      video.src = media.hlsUrl;
    } else {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        liveDurationInfinity: false,
        backBufferLength: 30,
        maxBufferLength: 90,
        maxMaxBufferLength: 180,
        manifestLoadingMaxRetry: 4,
        fragLoadingMaxRetry: 6
      });
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        if (!destroyed) hls.loadSource(media.hlsUrl);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!destroyed) this._setMusicActivityHint('Preparing Bilibili HLS playback…');
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        buffering = false;
        networkRecoveryAttempts = 0;
        tryApplyPendingSeek();
      });
      hls.on(Hls.Events.LEVEL_LOADED, (_eventName, eventData) => {
        updateGeneratedTimelineEndFromDetails(eventData?.details);
        tryApplyPendingSeek();
      });
      hls.on(Hls.Events.LEVEL_UPDATED, (_eventName, eventData) => {
        updateGeneratedTimelineEndFromDetails(eventData?.details);
        tryApplyPendingSeek();
      });
      hls.on(Hls.Events.ERROR, (_eventName, errorData) => {
        if (destroyed || !errorData?.fatal) return;
        console.warn('[BilibiliHLS] Fatal player error', {
          type: errorData.type,
          details: errorData.details,
          responseCode: errorData.response?.code || null
        });
        if (errorData.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveryAttempts < 4) {
          networkRecoveryAttempts += 1;
          const playbackIsActuallyAtRisk = video.readyState < 3 || getBufferedAhead() < 3;
          if (playbackIsActuallyAtRisk) {
            this._setMusicActivityHint(`Reconnecting Bilibili HLS… (${networkRecoveryAttempts}/4)`);
          }
          clearTimeout(networkRecoveryTimer);
          networkRecoveryTimer = setTimeout(() => {
            if (!destroyed) hls?.startLoad(Number(video.currentTime) || -1);
          }, Math.min(8000, 500 * (2 ** (networkRecoveryAttempts - 1))));
          return;
        }
        if (errorData.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveryAttempts < 3) {
          mediaRecoveryAttempts += 1;
          hls.recoverMediaError();
          return;
        }
        requestHlsRefresh(errorData.details || errorData.type || 'fatal error');
      });
      hls.attachMedia(video);
    }

    this._musicBiliPlayer = {
      mode: 'hls',
      get audio() { return video; },
      get video() { return video; },
      getCurrentTime: () => Number.isFinite(pendingSeekTarget)
        ? pendingSeekTarget
        : video.currentTime || 0,
      getDuration: () => getFiniteMediaDuration(video, media.duration),
      isReady: () => ready,
      getBufferedAhead,
      isBuffering: () => Number.isFinite(pendingSeekTarget)
        || (!video.paused && !video.ended
          && (buffering || (video.readyState < 3 && getBufferedAhead() < 0.5))),
      canSeekTo,
      play,
      pause,
      seekTo,
      setVolume: value => {
        video.volume = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
      },
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        clearTimeout(networkRecoveryTimer);
        clearTimeout(refreshFallbackTimer);
        clearInterval(pendingSeekRetryTimer);
        hls?.stopLoad();
        hls?.detachMedia();
        hls?.destroy();
        hls = null;
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
    };
    return true;
  },

  _initBilibiliDashPlayer(container, media, volume) {
    this._destroyBilibiliPlayer();
    if (!container
      || !isSafeMediaUrl(media?.videoUrl, 'video')
      || !isSafeMediaUrl(media?.audioUrl, 'audio')) return false;

    container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'music-embed-wrapper bilibili-native-wrapper';

    const unlock = document.createElement('button');
    unlock.type = 'button';
    unlock.className = 'bilibili-sync-unlock';
    unlock.style.display = 'none';

    let audio = document.createElement('audio');
    let video = document.createElement('video');
    video.className = 'music-bilibili-video';
    video.playsInline = true;
    video.preload = 'auto';
    video.muted = true;
    audio.preload = 'auto';
    let destroyed = false;
    let endedSent = false;
    let ready = false;
    let refreshRequested = false;
    let refreshTimer = null;
    let refreshResetTimer = null;
    let audioWatchdogTimer = null;
    let videoWatchdogTimer = null;
    let audioRecoveryCooldownTimer = null;
    let videoRecoveryCooldownTimer = null;
    let videoFrameCallbackId = null;
    let audioRecoveryAttempts = 0;
    let videoRecoveryAttempts = 0;
    let audioRecoveryInProgress = false;
    let videoRecoveryInProgress = false;
    let audioBuffering = true;
    let lastAudioProgressAt = Date.now();
    let lastAudioMediaTime = 0;
    let lastAudioRecoveryAt = 0;
    let lastVideoProgressAt = Date.now();
    let lastVideoMediaTime = 0;
    let lastVideoRecoveryAt = 0;
    let videoSourceAssigned = false;
    const shownProxyFailureKinds = new Set();
    const trackId = this._musicTrackId;

    const showUnlock = () => {
      if (destroyed) return;
      unlock.disabled = false;
      unlock.textContent = 'Playback was blocked. Click to retry.';
      unlock.style.display = '';
      this._setMusicActivityHint('Playback was blocked. Click the player to retry.');
    };

    const showProxyFailure = async failedUrl => {
      const failedMediaKind = (() => {
        try {
          return new URL(failedUrl, window.location.origin).pathname.endsWith('/audio') ? 'audio' : 'video';
        } catch {
          return 'video';
        }
      })();
      if (destroyed || shownProxyFailureKinds.has(failedMediaKind)) return;
      shownProxyFailureKinds.add(failedMediaKind);
      if (failedMediaKind === 'audio') pauseBoth();
      else video?.pause();
      let message = failedMediaKind === 'audio'
        ? 'This Bilibili audio stream could not be decoded by this browser.'
        : 'The Bilibili video stream is unavailable; audio playback can continue.';
      try {
        const diagnosticResponse = await fetch(failedUrl, { method: 'HEAD', cache: 'no-store' });
        if (diagnosticResponse.status === 410) {
          message = 'The Bilibili stream address expired before playback could recover.';
        } else if (diagnosticResponse.status === 404) {
          message = 'This Bilibili stream is no longer active on the Haven server.';
        } else if (diagnosticResponse.status === 502) {
          message = 'Bilibili rejected the Haven media proxy request.';
        } else if (diagnosticResponse.status === 503) {
          message = 'The Haven Bilibili media proxy is temporarily unavailable.';
        }
      } catch {
        message = 'The Haven Bilibili media proxy could not be reached.';
      }
      if (destroyed) return;
      unlock.disabled = true;
      unlock.textContent = message;
      unlock.style.display = '';
      this._setMusicActivityHint(message);
      this._showToast(message, 'error');
    };

    const syncVideo = (force = false) => {
      if (destroyed || !ready || !audio || !video || !Number.isFinite(audio.currentTime)) return;
      const drift = video.currentTime - audio.currentTime;
      if (force || Math.abs(drift) > 0.4) {
        try { video.currentTime = audio.currentTime; } catch {}
        video.playbackRate = 1;
      } else if (Math.abs(drift) > 0.08) {
        video.playbackRate = drift > 0 ? 0.97 : 1.03;
      } else {
        video.playbackRate = 1;
      }
    };

    const pauseBoth = () => {
      audio?.pause();
      video?.pause();
      if (video) video.playbackRate = 1;
    };

    const playBoth = async () => {
      if (destroyed || !audio) {
        showUnlock();
        throw new Error('media-not-ready');
      }
      syncVideo(true);
      if (video) video.muted = true;
      try {
        await safePlay(audio);
        if (video?.src) safePlay(video).catch(() => recoverVideoTrack());
        unlock.style.display = 'none';
        this._setMusicActivityHint('');
      } catch {
        pauseBoth();
        showUnlock();
        throw new Error('autoplay-blocked');
      }
    };
    unlock.addEventListener('click', () => { void playBoth().catch(() => {}); });

    const seekTo = (seconds) => {
      if (!audio) return;
      const duration = Number.isFinite(audio.duration) ? audio.duration : Number(media.duration);
      const target = clampTime(seconds, duration);
      try { audio.currentTime = target; } catch {}
      if (video) {
        try { video.currentTime = target; } catch {}
      }
      syncVideo(true);
    };

    const requestRefresh = failedUrl => {
      if (destroyed || refreshRequested || !this.voice?.currentChannel || !trackId) return;
      const previous = this._musicBiliRefreshGuard;
      const now = Date.now();
      if (previous?.trackId === trackId && now - previous.requestedAt < 30000) {
        void showProxyFailure(failedUrl);
        return;
      }
      this._musicBiliRefreshGuard = { trackId, requestedAt: now };
      refreshRequested = true;
      this._setMusicActivityHint('Refreshing the Bilibili media address…');
      this.socket.emit('music-refresh-media', {
        code: this.voice.currentChannel,
        trackId
      });
      clearTimeout(refreshResetTimer);
      refreshResetTimer = setTimeout(() => { refreshRequested = false; }, 30000);
    };

    const markVideoProgress = (mediaEventConfirmed = false) => {
      if (!video) return;
      const currentVideoTime = Number(video.currentTime) || 0;
      if (mediaEventConfirmed || currentVideoTime > lastVideoMediaTime + 0.03) {
        lastVideoMediaTime = currentVideoTime;
        lastVideoProgressAt = Date.now();
        videoRecoveryInProgress = false;
        if (videoRecoveryAttempts > 0 && Date.now() - lastVideoRecoveryAt > 30000) {
          videoRecoveryAttempts = 0;
        }
      }
    };

    const getBufferedAhead = mediaElement => {
      if (!mediaElement || !Number.isFinite(mediaElement.currentTime)) return 0;
      for (let rangeIndex = 0; rangeIndex < mediaElement.buffered.length; rangeIndex += 1) {
        const rangeStart = mediaElement.buffered.start(rangeIndex);
        const rangeEnd = mediaElement.buffered.end(rangeIndex);
        if (mediaElement.currentTime >= rangeStart - 0.1 && mediaElement.currentTime <= rangeEnd + 0.1) {
          return Math.max(0, rangeEnd - mediaElement.currentTime);
        }
      }
      return 0;
    };

    const hasBufferedTime = (mediaElement, seconds) => {
      if (!mediaElement || !Number.isFinite(seconds)) return false;
      for (let rangeIndex = 0; rangeIndex < mediaElement.buffered.length; rangeIndex += 1) {
        if (seconds >= mediaElement.buffered.start(rangeIndex) - 0.25
          && seconds <= mediaElement.buffered.end(rangeIndex) + 0.25) return true;
      }
      return false;
    };

    const markAudioProgress = (mediaEventConfirmed = false) => {
      if (!audio) return;
      const currentAudioTime = Number(audio.currentTime) || 0;
      if (mediaEventConfirmed || currentAudioTime > lastAudioMediaTime + 0.03) {
        lastAudioMediaTime = currentAudioTime;
        lastAudioProgressAt = Date.now();
        audioBuffering = false;
        audioRecoveryInProgress = false;
        if (audioRecoveryAttempts > 0 && Date.now() - lastAudioRecoveryAt > 30000) {
          audioRecoveryAttempts = 0;
        }
      }
    };

    const createAudioRetryUrl = () => {
      const retryUrl = new URL(media.audioUrl, window.location.origin);
      retryUrl.searchParams.set('retry', String(audioRecoveryAttempts));
      return `${retryUrl.pathname}${retryUrl.search}`;
    };

    const recoverAudioTrack = () => {
      if (destroyed || audioRecoveryInProgress || !audio) return;
      if (audioRecoveryAttempts >= 2) {
        requestRefresh(media.audioUrl);
        return;
      }

      audioRecoveryAttempts += 1;
      audioRecoveryInProgress = true;
      audioBuffering = true;
      lastAudioRecoveryAt = Date.now();
      lastAudioProgressAt = Date.now();
      clearTimeout(audioRecoveryCooldownTimer);
      const recoveryPosition = Number(audio.currentTime) || 0;
      const shouldResumeAudio = !!this._musicPlaying || (!audio.paused && !audio.ended);
      this._setMusicActivityHint(`Reconnecting Bilibili audio… (${audioRecoveryAttempts}/2)`);

      audio.pause();
      audio.src = createAudioRetryUrl();
      audio.load();
      const resumeRecoveredAudio = () => {
        if (destroyed || !audio) return;
        try { audio.currentTime = recoveryPosition; } catch {}
        if (shouldResumeAudio) safePlay(audio).catch(showUnlock);
      };
      audio.addEventListener('loadedmetadata', resumeRecoveredAudio, { once: true });
      audioRecoveryCooldownTimer = setTimeout(() => {
        if (destroyed) return;
        audioRecoveryInProgress = false;
        if (shouldResumeAudio && Date.now() - lastAudioProgressAt >= 8000) recoverAudioTrack();
      }, 9000);
    };

    const startAudioWatchdog = () => {
      clearInterval(audioWatchdogTimer);
      audioWatchdogTimer = setInterval(() => {
        if (destroyed || !audio || audio.paused || audio.ended) return;
        markAudioProgress();
        const bufferedAhead = getBufferedAhead(audio);
        const hasStoppedAdvancing = Date.now() - lastAudioProgressAt > 8000;
        const hasNoUsableData = audio.readyState < 3 || bufferedAhead < 0.25;
        if (hasStoppedAdvancing && hasNoUsableData) recoverAudioTrack();
      }, 2000);
    };

    const startVideoFrameTracking = () => {
      if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
      const trackPresentedFrame = (_timestamp, frameMetadata) => {
        if (destroyed || !video) return;
        lastVideoMediaTime = Number(frameMetadata?.mediaTime) || Number(video.currentTime) || 0;
        lastVideoProgressAt = Date.now();
        videoRecoveryInProgress = false;
        videoFrameCallbackId = video.requestVideoFrameCallback(trackPresentedFrame);
      };
      videoFrameCallbackId = video.requestVideoFrameCallback(trackPresentedFrame);
    };

    const createVideoRetryUrl = () => {
      const retryUrl = new URL(media.videoUrl, window.location.origin);
      retryUrl.searchParams.set('retry', String(videoRecoveryAttempts));
      return `${retryUrl.pathname}${retryUrl.search}`;
    };

    const recoverVideoTrack = () => {
      if (destroyed || videoRecoveryInProgress || !video) return;
      if (videoRecoveryAttempts >= 2) {
        requestRefresh(media.videoUrl);
        return;
      }

      videoRecoveryAttempts += 1;
      videoRecoveryInProgress = true;
      lastVideoRecoveryAt = Date.now();
      lastVideoProgressAt = Date.now();
      clearTimeout(videoRecoveryCooldownTimer);
      const recoveryPosition = Number(audio?.currentTime) || 0;
      const shouldResumeVideo = !!audio && !audio.paused && !audio.ended;
      this._setMusicActivityHint(`Reconnecting Bilibili video… (${videoRecoveryAttempts}/2)`);

      video.pause();
      video.src = createVideoRetryUrl();
      video.load();
      const resumeRecoveredVideo = () => {
        if (destroyed || !video) return;
        try { video.currentTime = Number(audio?.currentTime) || recoveryPosition; } catch {}
        if (shouldResumeVideo || (!!audio && !audio.paused)) safePlay(video).catch(() => {});
      };
      video.addEventListener('loadedmetadata', resumeRecoveredVideo, { once: true });
      videoRecoveryCooldownTimer = setTimeout(() => {
        if (destroyed) return;
        videoRecoveryInProgress = false;
        if (Date.now() - lastVideoProgressAt >= 9000) recoverVideoTrack();
      }, 10000);
    };

    const startVideoWatchdog = () => {
      clearInterval(videoWatchdogTimer);
      videoWatchdogTimer = setInterval(() => {
        if (destroyed || !video || !audio) return;
        markVideoProgress();
        const audioIsAdvancing = !audio.paused && !audio.ended && audio.currentTime > 0;
        const videoHasNoUsableData = video.readyState < 2 && Date.now() - lastVideoProgressAt > 12000;
        const videoHasStoppedAdvancing = audioIsAdvancing && Date.now() - lastVideoProgressAt > 10000;
        if (videoHasNoUsableData || videoHasStoppedAdvancing) recoverVideoTrack();
      }, 3000);
    };

    const expiresAt = Number(media.expiresAt);
    if (Number.isFinite(expiresAt)) {
      refreshTimer = setTimeout(
        () => requestRefresh(media.videoUrl),
        Math.max(1000, expiresAt - Date.now() - 45000)
      );
    }

    const onReady = () => {
      if (destroyed || ready || !audio || audio.readyState < 1) return;
      ready = true;
      if (this._musicBiliRefreshGuard?.trackId === trackId) delete this._musicBiliRefreshGuard;
      this._startMusicTimeTracking();
      this._flushPendingMusicSyncState();
    };

    const initializeMediaElements = () => {
      if (destroyed) return;
      video.muted = true;
      audio.volume = Math.max(0, Math.min(100, Number(volume) || 0)) / 100;
      const assignVideoSource = () => {
        if (destroyed || videoSourceAssigned || !video) return;
        videoSourceAssigned = true;
        lastVideoProgressAt = Date.now();
        video.src = media.videoUrl;
        startVideoFrameTracking();
        startVideoWatchdog();
      };
      audio.addEventListener('loadedmetadata', () => {
        markAudioProgress(true);
        onReady();
        assignVideoSource();
      });
      audio.addEventListener('loadeddata', () => markAudioProgress(true));
      audio.addEventListener('canplay', () => markAudioProgress(true));
      audio.addEventListener('playing', () => {
        markAudioProgress(true);
        this._setMusicActivityHint('');
      });
      video.addEventListener('loadedmetadata', () => {
        markVideoProgress(true);
        syncVideo(true);
        if (audio && !audio.paused) safePlay(video).catch(() => recoverVideoTrack());
      });
      video.addEventListener('loadeddata', () => markVideoProgress(true));
      video.addEventListener('canplay', () => markVideoProgress(true));
      video.addEventListener('playing', () => markVideoProgress(true));
      video.addEventListener('timeupdate', () => markVideoProgress(false));
      video.addEventListener('stalled', () => {
        if (audio && !audio.paused && Date.now() - lastVideoProgressAt > 6000) recoverVideoTrack();
      });
      audio.addEventListener('play', () => {
        endedSent = false;
        audioBuffering = false;
        lastAudioProgressAt = Date.now();
        this._setMusicPlayingUi(true);
        syncVideo(true);
        if (video?.src) safePlay(video).catch(() => recoverVideoTrack());
      });
      audio.addEventListener('pause', () => {
        if (audio.ended) return;
        video.pause();
        this._setMusicPlayingUi(false);
      });
      audio.addEventListener('seeking', () => syncVideo(true));
      audio.addEventListener('timeupdate', () => {
        markAudioProgress(false);
        syncVideo(false);
      });
      audio.addEventListener('waiting', () => {
        if (audio.paused || audio.ended) return;
        audioBuffering = true;
        this._setMusicActivityHint('Buffering Bilibili audio…');
      });
      audio.addEventListener('stalled', () => {
        if (audio.paused || audio.ended) return;
        audioBuffering = true;
        this._setMusicActivityHint('Reconnecting Bilibili audio…');
      });
      audio.addEventListener('ended', () => {
        if (endedSent || destroyed) return;
        endedSent = true;
        video.pause();
        this._setMusicPlayingUi(false);
        this._emitMusicFinished();
      });
      audio.addEventListener('error', recoverAudioTrack);
      video.addEventListener('error', recoverVideoTrack);
      audio.src = media.audioUrl;
      startAudioWatchdog();
    };

    wrapper.append(video, audio, unlock);
    container.appendChild(wrapper);
    initializeMediaElements();

    this._musicBiliPlayer = {
      get audio() { return audio; },
      get video() { return video; },
      getCurrentTime: () => audio?.currentTime || 0,
      getDuration: () => audio?.duration || Number(media.duration) || 0,
      isReady: () => ready,
      getBufferedAhead: () => getBufferedAhead(audio),
      isBuffering: () => !!audio && !audio.paused && !audio.ended
        && (audioBuffering || (audio.readyState < 3 && getBufferedAhead(audio) < 0.5)),
      canSeekTo: seconds => hasBufferedTime(audio, Number(seconds)),
      play: () => playBoth(),
      pause: pauseBoth,
      seekTo,
      setVolume: value => {
        if (audio) audio.volume = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
      },
      destroy: () => {
        destroyed = true;
        clearTimeout(refreshTimer);
        clearTimeout(refreshResetTimer);
        clearTimeout(audioRecoveryCooldownTimer);
        clearTimeout(videoRecoveryCooldownTimer);
        clearInterval(audioWatchdogTimer);
        clearInterval(videoWatchdogTimer);
        if (video && videoFrameCallbackId !== null && typeof video.cancelVideoFrameCallback === 'function') {
          video.cancelVideoFrameCallback(videoFrameCallbackId);
        }
        pauseBoth();
        if (audio) {
          audio.removeAttribute('src');
          audio.load();
        }
        if (video) {
          video.removeAttribute('src');
          video.load();
        }
      }
    };

    return true;
  }
};
