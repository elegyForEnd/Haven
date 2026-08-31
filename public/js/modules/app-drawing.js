const DRAWING_POINT_FLUSH_INTERVAL_MS = 30;
const DRAWING_MAX_LOCAL_POINTS = 780;
const DRAWING_MIN_POINT_DISTANCE_PX = 1.5;

function getDrawingText(translationKey, fallbackText) {
  try {
    const translatedText = t(translationKey);
    return translatedText && translatedText !== translationKey ? translatedText : fallbackText;
  } catch {
    return fallbackText;
  }
}

function createDrawingStrokeId(userId) {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const randomPart = Math.random().toString(36).slice(2, 14);
  return `stroke:${userId || 0}:${Date.now()}:${randomPart}`;
}

export default {
  _setupDrawing() {
    const overlay = document.getElementById('drawing-overlay');
    const canvas = document.getElementById('drawing-canvas');
    if (!overlay || !canvas) return;

    const storedWidthValue = localStorage.getItem('haven_drawing_width');
    const storedWidth = storedWidthValue === null ? NaN : Number(storedWidthValue);
    const storedColor = localStorage.getItem('haven_drawing_color');
    this._drawing = {
      active: false,
      controlsVisible: false,
      interactive: true,
      tool: 'pen',
      color: /^#[0-9a-f]{6}$/i.test(storedColor || '') ? storedColor : '#ff4d8d',
      width: Number.isFinite(storedWidth) ? Math.max(1, Math.min(48, storedWidth)) : 5,
      channelId: null,
      channelCode: null,
      revision: 1,
      sequence: 0,
      strokes: [],
      activeStrokes: new Map(),
      localStroke: null,
      queuedPoints: [],
      pointFlushTimer: null,
      syncRetryTimer: null,
      syncing: false,
      incomingStateStrokes: [],
      incomingActiveStrokes: new Map(),
      participantCount: 0,
      canvas,
      context: canvas.getContext('2d', { alpha: true, desynchronized: true }),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: 1,
    };

    document.getElementById('drawing-toggle-btn')?.addEventListener('click', () => this._toggleDrawingBoard());
    document.getElementById('drawing-toggle-mobile-btn')?.addEventListener('click', () => {
      this._closeMobilePanels?.();
      this._toggleDrawingBoard();
    });
    document.getElementById('drawing-close-btn')?.addEventListener('click', () => this._closeDrawingBoard());
    document.getElementById('drawing-pen-btn')?.addEventListener('click', () => this._setDrawingTool('pen'));
    document.getElementById('drawing-eraser-btn')?.addEventListener('click', () => this._setDrawingTool('eraser'));
    document.getElementById('drawing-interaction-btn')?.addEventListener('click', () => {
      this._setDrawingInteractionMode(!this._drawing.interactive);
    });
    document.getElementById('drawing-undo-btn')?.addEventListener('click', () => {
      if (this._drawing.channelId && this.socket?.connected) this.socket.emit('drawing-undo');
    });
    document.getElementById('drawing-clear-btn')?.addEventListener('click', () => this._confirmClearDrawingBoard());

    const colorInput = document.getElementById('drawing-color-input');
    if (colorInput) {
      colorInput.value = this._drawing.color;
      colorInput.addEventListener('input', () => {
        if (!/^#[0-9a-f]{6}$/i.test(colorInput.value)) return;
        this._drawing.color = colorInput.value.toLowerCase();
        localStorage.setItem('haven_drawing_color', this._drawing.color);
        this._updateDrawingWidthPreview();
      });
    }

    const widthInput = document.getElementById('drawing-width-input');
    if (widthInput) {
      widthInput.value = String(this._drawing.width);
      widthInput.addEventListener('input', () => {
        const nextWidth = Number(widthInput.value);
        if (!Number.isFinite(nextWidth)) return;
        this._drawing.width = Math.max(1, Math.min(48, nextWidth));
        localStorage.setItem('haven_drawing_width', String(this._drawing.width));
        this._updateDrawingWidthPreview();
      });
    }

    canvas.addEventListener('pointerdown', (event) => this._beginDrawingStroke(event));
    canvas.addEventListener('pointermove', (event) => this._continueDrawingStroke(event));
    canvas.addEventListener('pointerup', (event) => this._finishDrawingStroke(event));
    canvas.addEventListener('pointercancel', (event) => this._finishDrawingStroke(event));
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    // The mobile UI uses document-level touch listeners for edge-swiping its
    // sidebars. Keep those gestures from firing while the canvas is drawing.
    const stopDrawingTouchGesture = (event) => {
      if (!this._drawing.active || !this._drawing.interactive) return;
      event.preventDefault();
      event.stopPropagation();
    };
    canvas.addEventListener('touchstart', stopDrawingTouchGesture, { passive: false });
    canvas.addEventListener('touchmove', stopDrawingTouchGesture, { passive: false });
    canvas.addEventListener('touchend', stopDrawingTouchGesture, { passive: false });

    const toolbar = document.getElementById('drawing-toolbar');
    const stopToolbarTouchPropagation = (event) => event.stopPropagation();
    toolbar?.addEventListener('touchstart', stopToolbarTouchPropagation, { passive: true });
    toolbar?.addEventListener('touchmove', stopToolbarTouchPropagation, { passive: true });
    toolbar?.addEventListener('touchend', stopToolbarTouchPropagation, { passive: true });

    window.addEventListener('resize', () => this._resizeDrawingCanvas());
    window.visualViewport?.addEventListener('resize', () => this._resizeDrawingCanvas());
    document.addEventListener('keydown', (event) => {
      if (!this._drawing.active) return;
      const targetTagName = event.target?.tagName;
      if (targetTagName === 'INPUT' || targetTagName === 'TEXTAREA' || event.target?.isContentEditable) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this._closeDrawingBoard();
      }
    });

    this.socket.on('drawing-state-start', (payload) => this._handleDrawingStateStart(payload));
    this.socket.on('drawing-state-stroke', (payload) => this._handleDrawingStateStroke(payload));
    this.socket.on('drawing-state-end', (payload) => this._handleDrawingStateEnd(payload));
    this.socket.on('drawing-operation', (payload) => this._handleDrawingOperation(payload));
    this.socket.on('drawing-users-update', (payload) => this._handleDrawingUsersUpdate(payload));
    this.socket.on('drawing-error', (payload) => this._handleDrawingError(payload));
    this.socket.on('drawing-access-revoked', (payload) => {
      if (!this._drawing.active || Number(payload?.channelId) !== this._drawing.channelId) return;
      this._showToast?.(getDrawingText('drawing.access_revoked', 'You no longer have access to this drawing board.'), 'error');
      this._closeDrawingBoard();
    });
    this.socket.on('connect', () => {
      if (!this._drawing.active || !this.currentChannel) return;
      this._setDrawingStatus('connecting');
      this._joinDrawingChannel(this.currentChannel);
    });
    this.socket.on('disconnect', () => {
      if (!this._drawing.active) return;
      this._cancelLocalDrawingStroke();
      this._setDrawingStatus('offline');
    });
    this.socket.on('channel-deleted', (payload) => {
      if (payload?.code && payload.code === this._drawing.channelCode) this._closeDrawingBoard();
    });

    this._setDrawingTool('pen');
    this._setDrawingInteractionMode(true);
    this._updateDrawingWidthPreview();
    this._resizeDrawingCanvas();

    // Cover the rare case where the initial channel snapshot arrived before
    // drawing setup finished attaching its listeners.
    if (this.currentChannel) this._openDrawingBoard({ interactive: false, controlsVisible: false });
  },

  _toggleDrawingBoard() {
    if (!this._drawing) return;
    if (!this._drawing.active) {
      this._openDrawingBoard();
      return;
    }
    if (!this._drawing.controlsVisible) {
      this._setDrawingControlsVisible(true);
      this._setDrawingInteractionMode(true);
      return;
    }
    this._closeDrawingBoard();
  },

  _openDrawingBoard({ interactive = true, controlsVisible = true } = {}) {
    if (!this._drawing) return;
    if (!this.currentChannel) {
      this._showToast?.(getDrawingText('drawing.select_channel_first', 'Select a channel before opening the drawing board.'), 'info');
      return;
    }

    this._drawing.active = true;
    document.getElementById('drawing-clear-btn').style.display = this.user?.isAdmin ? '' : 'none';

    this._setDrawingControlsVisible(controlsVisible);
    this._setDrawingInteractionMode(interactive);
    this._resizeDrawingCanvas();
    this._resetDrawingBoardState();
    this._updateDrawingChannelLabel();
    this._setDrawingStatus(this.socket?.connected ? 'connecting' : 'offline');
    this._joinDrawingChannel(this.currentChannel);
  },

  _closeDrawingBoard() {
    if (!this._drawing?.active) return;

    if (this._drawing.localStroke) this._finishDrawingStroke(null);
    if (this.socket?.connected && this._drawing.channelId) this.socket.emit('drawing-leave');

    this._drawing.active = false;
    this._drawing.controlsVisible = false;
    this._drawing.channelId = null;
    this._drawing.channelCode = null;
    this._drawing.syncing = false;
    this._drawing.participantCount = 0;
    if (this._drawing.syncRetryTimer) clearTimeout(this._drawing.syncRetryTimer);
    this._drawing.syncRetryTimer = null;
    this._cancelLocalDrawingStroke();
    this._resetDrawingBoardState();
  },

  _handleDrawingChannelChanged(previousChannelCode, nextChannelCode) {
    const mobileDrawingButton = document.getElementById('drawing-toggle-mobile-btn');
    if (mobileDrawingButton) mobileDrawingButton.style.display = nextChannelCode ? 'inline-flex' : 'none';
    if (!this._drawing || previousChannelCode === nextChannelCode) return;

    if (!nextChannelCode) {
      if (this._drawing.active) this._closeDrawingBoard();
      return;
    }

    // Subscribe silently on channel entry. Empty boards remain hidden; boards
    // with content appear as a passthrough canvas without opening the toolbar
    // or intercepting normal chat and navigation interactions.
    if (!this._drawing.active) {
      this._openDrawingBoard({ interactive: false, controlsVisible: false });
      return;
    }

    if (this._drawing.localStroke) this._finishDrawingStroke(null);
    if (this._drawing.syncRetryTimer) clearTimeout(this._drawing.syncRetryTimer);
    this._drawing.syncRetryTimer = null;
    if (this.socket?.connected && this._drawing.channelId) this.socket.emit('drawing-leave');

    this._drawing.channelId = null;
    this._drawing.channelCode = null;
    this._resetDrawingBoardState();
    this._setDrawingInteractionMode(false);
    this._setDrawingControlsVisible(false);
    this._updateDrawingChannelLabel();
    this._setDrawingStatus(this.socket?.connected ? 'connecting' : 'offline');
    this._joinDrawingChannel(nextChannelCode);
  },

  _joinDrawingChannel(channelCode) {
    if (!this._drawing?.active || !channelCode || !this.socket?.connected) return;
    this._drawing.channelCode = channelCode;
    this._drawing.syncing = true;
    this._setDrawingStatus('connecting');
    this.socket.emit('drawing-join', { code: channelCode });
  },

  _resetDrawingBoardState() {
    if (!this._drawing) return;
    this._drawing.revision = 1;
    this._drawing.sequence = 0;
    this._drawing.strokes = [];
    this._drawing.activeStrokes.clear();
    this._drawing.incomingStateStrokes = [];
    this._drawing.incomingActiveStrokes = new Map();
    this._clearDrawingCanvas();
    this._refreshDrawingOverlayVisibility();
  },

  _setDrawingControlsVisible(visible) {
    if (!this._drawing) return;
    this._drawing.controlsVisible = visible === true;
    this._refreshDrawingOverlayVisibility();
  },

  _refreshDrawingOverlayVisibility() {
    if (!this._drawing) return;
    const overlay = document.getElementById('drawing-overlay');
    const toolbar = document.getElementById('drawing-toolbar');
    if (!overlay) return;

    const hasContent = this._drawing.strokes.length > 0 ||
      this._drawing.activeStrokes.size > 0 ||
      Boolean(this._drawing.localStroke);
    const controlsVisible = this._drawing.active && this._drawing.controlsVisible;
    const overlayVisible = this._drawing.active && (controlsVisible || hasContent);

    overlay.hidden = !overlayVisible;
    overlay.setAttribute('aria-hidden', overlayVisible ? 'false' : 'true');
    if (toolbar) toolbar.hidden = !controlsVisible;
    document.getElementById('drawing-toggle-btn')?.classList.toggle('active', controlsVisible);
    document.getElementById('drawing-toggle-mobile-btn')?.classList.toggle('active', controlsVisible);
  },

  _setDrawingInteractionMode(interactive) {
    if (!this._drawing) return;
    if (!interactive && this._drawing.localStroke) this._finishDrawingStroke(null);
    this._drawing.interactive = interactive;

    const overlay = document.getElementById('drawing-overlay');
    overlay.classList.toggle('is-interactive', interactive);
    overlay.classList.toggle('is-passthrough', !interactive);

    const modeButton = document.getElementById('drawing-interaction-btn');
    const modeIcon = modeButton?.querySelector('.drawing-mode-icon');
    const modeLabel = modeButton?.querySelector('.drawing-mode-label');
    if (modeButton) {
      modeButton.dataset.mode = interactive ? 'draw' : 'passthrough';
      modeButton.title = interactive
        ? getDrawingText('drawing.switch_to_passthrough', 'Switch to interface mode')
        : getDrawingText('drawing.switch_to_draw', 'Switch to drawing mode');
    }
    if (modeIcon) modeIcon.textContent = interactive ? '✏️' : '🖱️';
    if (modeLabel) {
      modeLabel.textContent = interactive
        ? getDrawingText('drawing.draw_mode', 'Draw')
        : getDrawingText('drawing.interface_mode', 'Interface');
    }
  },

  _setDrawingTool(tool) {
    if (!this._drawing || (tool !== 'pen' && tool !== 'eraser')) return;
    this._drawing.tool = tool;
    document.getElementById('drawing-pen-btn')?.classList.toggle('active', tool === 'pen');
    document.getElementById('drawing-eraser-btn')?.classList.toggle('active', tool === 'eraser');
    this._updateDrawingWidthPreview();
  },

  _updateDrawingWidthPreview() {
    if (!this._drawing) return;
    const widthOutput = document.getElementById('drawing-width-output');
    const widthPreview = document.querySelector('.drawing-width-preview');
    if (widthOutput) widthOutput.value = String(Math.round(this._drawing.width));
    if (widthPreview) {
      const previewSize = Math.max(4, Math.min(18, this._drawing.width / 2));
      widthPreview.style.width = `${previewSize}px`;
      widthPreview.style.height = `${previewSize}px`;
      widthPreview.style.color = this._drawing.tool === 'eraser' ? 'var(--text-primary)' : this._drawing.color;
      widthPreview.style.background = this._drawing.tool === 'eraser'
        ? 'repeating-linear-gradient(45deg, currentColor 0 2px, transparent 2px 4px)'
        : 'currentColor';
    }
  },

  _updateDrawingChannelLabel(channelName = null) {
    const channel = this.channels?.find((candidate) => candidate.code === this.currentChannel);
    const directMessageName = channel?.is_dm && channel.dm_target
      ? this._getNickname?.(channel.dm_target.id, channel.dm_target.username) || channel.dm_target.username
      : null;
    const displayName = directMessageName || channelName || channel?.name || this.currentChannel || getDrawingText('drawing.title', 'Channel Drawing');
    const label = document.getElementById('drawing-channel-name');
    if (label) label.textContent = channel?.is_dm ? `@ ${displayName}` : `# ${displayName}`;
  },

  _setDrawingStatus(status) {
    const statusElement = document.getElementById('drawing-status');
    if (!statusElement) return;
    statusElement.dataset.state = status === 'online' ? 'online' : status === 'offline' ? 'offline' : 'connecting';
    if (status === 'online') statusElement.textContent = getDrawingText('drawing.synced', 'Synced');
    else if (status === 'offline') statusElement.textContent = getDrawingText('drawing.offline', 'Offline');
    else statusElement.textContent = getDrawingText('drawing.connecting', 'Connecting...');
  },

  _resizeDrawingCanvas() {
    if (!this._drawing?.canvas || !this._drawing.context) return;
    const viewportWidth = Math.max(1, window.innerWidth);
    const viewportHeight = Math.max(1, window.innerHeight);
    const devicePixelRatio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const canvas = this._drawing.canvas;

    if (
      canvas.width === Math.round(viewportWidth * devicePixelRatio) &&
      canvas.height === Math.round(viewportHeight * devicePixelRatio)
    ) return;

    this._drawing.viewportWidth = viewportWidth;
    this._drawing.viewportHeight = viewportHeight;
    this._drawing.devicePixelRatio = devicePixelRatio;
    canvas.width = Math.round(viewportWidth * devicePixelRatio);
    canvas.height = Math.round(viewportHeight * devicePixelRatio);
    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = `${viewportHeight}px`;
    this._drawing.context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    this._renderDrawingBoard();
  },

  _normalizeDrawingPointer(event) {
    const canvasBounds = this._drawing.canvas.getBoundingClientRect();
    const normalizedX = (event.clientX - canvasBounds.left) / Math.max(1, canvasBounds.width);
    const normalizedY = (event.clientY - canvasBounds.top) / Math.max(1, canvasBounds.height);
    const eventPressure = Number(event.pressure);
    return {
      x: Math.max(0, Math.min(1, normalizedX)),
      y: Math.max(0, Math.min(1, normalizedY)),
      pressure: Number.isFinite(eventPressure) && eventPressure > 0 ? Math.min(1, eventPressure) : 0.5,
    };
  },

  _beginDrawingStroke(event) {
    if (!this._drawing?.active || !this._drawing.interactive || this._drawing.syncing) return;
    if (this._drawing.localStroke) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!this._drawing.channelId || !this.socket?.connected) {
      this._showToast?.(getDrawingText('drawing.not_ready', 'The drawing board is not ready yet.'), 'info');
      return;
    }
    if (event.button !== 0 && event.pointerType !== 'touch') return;

    event.preventDefault();
    event.stopPropagation();
    this._drawing.canvas.setPointerCapture?.(event.pointerId);

    const firstPoint = this._normalizeDrawingPointer(event);
    const stroke = {
      id: createDrawingStrokeId(this.user?.id),
      authorId: this.user?.id || 0,
      authorName: this.user?.displayName || this.user?.username || '',
      tool: this._drawing.tool,
      color: this._drawing.color,
      width: this._drawing.width,
      points: [firstPoint],
      sequence: 0,
      pointerId: event.pointerId,
    };
    this._drawing.localStroke = stroke;
    this._drawing.queuedPoints = [];
    this._drawDrawingStroke(stroke);

    this.socket.emit('drawing-stroke-begin', {
      revision: this._drawing.revision,
      strokeId: stroke.id,
      tool: stroke.tool,
      color: stroke.color,
      width: stroke.width,
      point: firstPoint,
    });
  },

  _continueDrawingStroke(event) {
    const localStroke = this._drawing?.localStroke;
    if (!localStroke || localStroke.pointerId !== event.pointerId) return;

    event.preventDefault();
    event.stopPropagation();
    const pointerEvents = typeof event.getCoalescedEvents === 'function'
      ? event.getCoalescedEvents()
      : [event];

    for (const pointerEvent of pointerEvents) {
      if (localStroke.points.length >= DRAWING_MAX_LOCAL_POINTS) break;
      const point = this._normalizeDrawingPointer(pointerEvent);
      const previousPoint = localStroke.points[localStroke.points.length - 1];
      const horizontalDistance = (point.x - previousPoint.x) * this._drawing.viewportWidth;
      const verticalDistance = (point.y - previousPoint.y) * this._drawing.viewportHeight;
      if (Math.hypot(horizontalDistance, verticalDistance) < DRAWING_MIN_POINT_DISTANCE_PX) continue;

      localStroke.points.push(point);
      this._drawing.queuedPoints.push(point);
      this._drawDrawingSegment(localStroke, previousPoint, point);
    }

    this._scheduleDrawingPointFlush();
  },

  _scheduleDrawingPointFlush() {
    if (!this._drawing || this._drawing.pointFlushTimer || !this._drawing.queuedPoints.length) return;
    this._drawing.pointFlushTimer = setTimeout(() => {
      this._drawing.pointFlushTimer = null;
      this._flushDrawingPointQueue();
    }, DRAWING_POINT_FLUSH_INTERVAL_MS);
  },

  _flushDrawingPointQueue(flushRemainingPoints = false) {
    const localStroke = this._drawing?.localStroke;
    if (!localStroke || !this._drawing.queuedPoints.length) return;
    if (!this.socket?.connected) {
      this._drawing.queuedPoints = [];
      return;
    }

    const points = this._drawing.queuedPoints.splice(0, 64);
    this.socket.emit('drawing-stroke-points', {
      revision: this._drawing.revision,
      strokeId: localStroke.id,
      points,
    });
    if (this._drawing.queuedPoints.length && !flushRemainingPoints) this._scheduleDrawingPointFlush();
  },

  _finishDrawingStroke(event) {
    const localStroke = this._drawing?.localStroke;
    if (!localStroke) return;
    if (event && localStroke.pointerId !== event.pointerId) return;

    event?.preventDefault();
    event?.stopPropagation();
    if (this._drawing.pointFlushTimer) {
      clearTimeout(this._drawing.pointFlushTimer);
      this._drawing.pointFlushTimer = null;
    }
    while (this._drawing.queuedPoints.length) this._flushDrawingPointQueue(true);
    if (this._drawing.pointFlushTimer) {
      clearTimeout(this._drawing.pointFlushTimer);
      this._drawing.pointFlushTimer = null;
    }

    const committedStroke = { ...localStroke };
    delete committedStroke.pointerId;
    this._drawing.strokes.push(committedStroke);
    this._drawing.localStroke = null;
    this._drawing.queuedPoints = [];

    if (this.socket?.connected) {
      this.socket.emit('drawing-stroke-end', {
        revision: this._drawing.revision,
        strokeId: committedStroke.id,
      });
    }
    if (event) this._drawing.canvas.releasePointerCapture?.(event.pointerId);
  },

  _cancelLocalDrawingStroke() {
    if (!this._drawing) return;
    if (this._drawing.pointFlushTimer) clearTimeout(this._drawing.pointFlushTimer);
    this._drawing.pointFlushTimer = null;
    this._drawing.localStroke = null;
    this._drawing.queuedPoints = [];
    this._renderDrawingBoard();
  },

  _clearDrawingCanvas() {
    if (!this._drawing?.context) return;
    this._drawing.context.clearRect(0, 0, this._drawing.viewportWidth, this._drawing.viewportHeight);
  },

  _renderDrawingBoard() {
    if (!this._drawing?.context) return;
    this._clearDrawingCanvas();
    const renderableStrokes = [
      ...this._drawing.strokes,
      ...this._drawing.activeStrokes.values(),
    ];
    if (
      this._drawing.localStroke &&
      !renderableStrokes.some((stroke) => stroke.id === this._drawing.localStroke.id)
    ) {
      renderableStrokes.push(this._drawing.localStroke);
    }
    renderableStrokes.sort((firstStroke, secondStroke) => {
      const firstSequence = Number(firstStroke.sequence) > 0
        ? Number(firstStroke.sequence)
        : Number.MAX_SAFE_INTEGER;
      const secondSequence = Number(secondStroke.sequence) > 0
        ? Number(secondStroke.sequence)
        : Number.MAX_SAFE_INTEGER;
      return firstSequence - secondSequence;
    });
    for (const stroke of renderableStrokes) this._drawDrawingStroke(stroke);
    this._refreshDrawingOverlayVisibility();
  },

  _drawDrawingStroke(stroke) {
    if (!stroke?.points?.length) return;
    if (stroke.points.length === 1) {
      this._drawDrawingSegment(stroke, stroke.points[0], stroke.points[0]);
      return;
    }
    for (let pointIndex = 1; pointIndex < stroke.points.length; pointIndex += 1) {
      this._drawDrawingSegment(stroke, stroke.points[pointIndex - 1], stroke.points[pointIndex]);
    }
  },

  _drawDrawingSegment(stroke, previousPoint, nextPoint) {
    const context = this._drawing?.context;
    if (!context || !previousPoint || !nextPoint) return;

    const previousX = previousPoint.x * this._drawing.viewportWidth;
    const previousY = previousPoint.y * this._drawing.viewportHeight;
    const nextX = nextPoint.x * this._drawing.viewportWidth;
    const nextY = nextPoint.y * this._drawing.viewportHeight;
    const averagePressure = Math.max(0.25, ((previousPoint.pressure || 0.5) + (nextPoint.pressure || 0.5)) / 2);

    context.save();
    context.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    context.strokeStyle = stroke.tool === 'eraser' ? 'rgba(0, 0, 0, 1)' : stroke.color;
    context.fillStyle = context.strokeStyle;
    context.lineWidth = Math.max(1, stroke.width * (0.55 + averagePressure * 0.45));
    context.lineCap = 'round';
    context.lineJoin = 'round';

    if (previousX === nextX && previousY === nextY) {
      context.beginPath();
      context.arc(nextX, nextY, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.beginPath();
      context.moveTo(previousX, previousY);
      context.lineTo(nextX, nextY);
      context.stroke();
    }
    context.restore();
  },

  _handleDrawingStateStart(payload) {
    if (!this._drawing?.active || !payload || typeof payload !== 'object') return;
    if (payload.channelCode && payload.channelCode !== this.currentChannel) return;

    this._cancelLocalDrawingStroke();
    if (this._drawing.syncRetryTimer) clearTimeout(this._drawing.syncRetryTimer);
    this._drawing.syncRetryTimer = null;
    this._drawing.syncing = true;
    this._drawing.channelId = Number(payload.channelId) || null;
    this._drawing.channelCode = payload.channelCode || this.currentChannel;
    this._drawing.revision = Number(payload.revision) || 1;
    this._drawing.sequence = Number(payload.sequence) || 0;
    this._drawing.incomingStateStrokes = [];
    this._drawing.incomingActiveStrokes = new Map();
    this._updateDrawingChannelLabel(payload.channelName);
    this._setDrawingStatus('connecting');
  },

  _handleDrawingStateStroke(payload) {
    if (!this._drawing?.active || !this._drawing.syncing || !payload?.stroke) return;
    if (Number(payload.channelId) !== this._drawing.channelId) return;
    const stroke = this._normalizeIncomingDrawingStroke(payload.stroke);
    if (!stroke) return;
    if (payload.active) this._drawing.incomingActiveStrokes.set(stroke.id, stroke);
    else this._drawing.incomingStateStrokes.push(stroke);
  },

  _handleDrawingStateEnd(payload) {
    if (!this._drawing?.active || !this._drawing.syncing || !payload) return;
    if (Number(payload.channelId) !== this._drawing.channelId) return;

    this._drawing.strokes = this._drawing.incomingStateStrokes;
    this._drawing.activeStrokes = this._drawing.incomingActiveStrokes;
    this._drawing.incomingStateStrokes = [];
    this._drawing.incomingActiveStrokes = new Map();
    this._drawing.revision = Number(payload.revision) || this._drawing.revision;
    this._drawing.sequence = Number(payload.sequence) || 0;
    this._drawing.syncing = false;
    this._renderDrawingBoard();
    this._setDrawingStatus('online');
  },

  _normalizeIncomingDrawingStroke(rawStroke) {
    if (!rawStroke || typeof rawStroke !== 'object' || !Array.isArray(rawStroke.points)) return null;
    if (typeof rawStroke.id !== 'string' || !rawStroke.id) return null;
    const points = rawStroke.points
      .map((point) => ({
        x: Number(point?.x),
        y: Number(point?.y),
        pressure: Number(point?.pressure) || 0.5,
      }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (!points.length) return null;

    return {
      id: rawStroke.id,
      authorId: Number(rawStroke.authorId) || 0,
      authorName: typeof rawStroke.authorName === 'string' ? rawStroke.authorName : '',
      tool: rawStroke.tool === 'eraser' ? 'eraser' : 'pen',
      color: /^#[0-9a-f]{6}$/i.test(rawStroke.color || '') ? rawStroke.color : '#ff4d8d',
      width: Math.max(1, Math.min(48, Number(rawStroke.width) || 5)),
      points,
      sequence: Number(rawStroke.sequence) || 0,
    };
  },

  _handleDrawingOperation(payload) {
    if (!this._drawing?.active || !payload || typeof payload !== 'object') return;
    if (Number(payload.channelId) !== this._drawing.channelId) return;

    const operationRevision = Number(payload.revision);
    if (payload.type !== 'board-clear' && operationRevision !== this._drawing.revision) {
      if (!this._drawing.syncing) {
        this._drawing.syncing = true;
        this._setDrawingStatus('connecting');
        this.socket.emit('drawing-sync-request');
      }
      return;
    }

    if (payload.type === 'stroke-begin') {
      const stroke = this._normalizeIncomingDrawingStroke(payload.stroke);
      if (!stroke) return;
      if (this._drawing.localStroke?.id === stroke.id) {
        this._drawing.localStroke.sequence = stroke.sequence;
        return;
      }
      this._drawing.activeStrokes.set(stroke.id, stroke);
      this._refreshDrawingOverlayVisibility();
      this._drawDrawingStroke(stroke);
      return;
    }

    if (payload.type === 'stroke-points') {
      const stroke = this._drawing.activeStrokes.get(payload.strokeId);
      if (!stroke || !Array.isArray(payload.points)) return;
      for (const rawPoint of payload.points) {
        const point = {
          x: Number(rawPoint?.x),
          y: Number(rawPoint?.y),
          pressure: Number(rawPoint?.pressure) || 0.5,
        };
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        const previousPoint = stroke.points[stroke.points.length - 1];
        stroke.points.push(point);
        this._drawDrawingSegment(stroke, previousPoint, point);
      }
      return;
    }

    if (payload.type === 'stroke-end') {
      const strokeId = payload.strokeId;
      const activeStroke = this._drawing.activeStrokes.get(strokeId);
      const existingStroke = this._drawing.strokes.find((stroke) => stroke.id === strokeId);
      if (existingStroke) {
        existingStroke.sequence = Number(payload.sequence) || existingStroke.sequence;
      } else if (activeStroke) {
        activeStroke.sequence = Number(payload.sequence) || 0;
        this._drawing.strokes.push(activeStroke);
      }
      this._drawing.activeStrokes.delete(strokeId);
      this._drawing.sequence = Math.max(this._drawing.sequence, Number(payload.sequence) || 0);
      this._sortCommittedDrawingStrokes();
      this._renderDrawingBoard();
      return;
    }

    if (payload.type === 'stroke-remove') {
      this._drawing.strokes = this._drawing.strokes.filter((stroke) => stroke.id !== payload.strokeId);
      this._drawing.activeStrokes.delete(payload.strokeId);
      this._drawing.sequence = Math.max(this._drawing.sequence, Number(payload.sequence) || 0);
      this._renderDrawingBoard();
      return;
    }

    if (payload.type === 'strokes-removed' && Array.isArray(payload.strokeIds)) {
      const removedStrokeIds = new Set(payload.strokeIds);
      this._drawing.strokes = this._drawing.strokes.filter((stroke) => !removedStrokeIds.has(stroke.id));
      for (const strokeId of removedStrokeIds) this._drawing.activeStrokes.delete(strokeId);
      this._renderDrawingBoard();
      return;
    }

    if (payload.type === 'strokes-canceled' && Array.isArray(payload.strokeIds)) {
      const canceledStrokeIds = new Set(payload.strokeIds);
      this._drawing.strokes = this._drawing.strokes.filter((stroke) => !canceledStrokeIds.has(stroke.id));
      for (const strokeId of canceledStrokeIds) this._drawing.activeStrokes.delete(strokeId);
      if (this._drawing.localStroke && canceledStrokeIds.has(this._drawing.localStroke.id)) {
        this._cancelLocalDrawingStroke();
      } else {
        this._renderDrawingBoard();
      }
      return;
    }

    if (payload.type === 'board-clear') {
      this._cancelLocalDrawingStroke();
      this._drawing.revision = operationRevision || this._drawing.revision + 1;
      this._drawing.sequence = 0;
      this._drawing.strokes = [];
      this._drawing.activeStrokes.clear();
      this._clearDrawingCanvas();
      this._refreshDrawingOverlayVisibility();
    }
  },

  _sortCommittedDrawingStrokes() {
    if (!this._drawing) return;
    this._drawing.strokes.sort((firstStroke, secondStroke) => {
      const firstSequence = Number(firstStroke.sequence) > 0
        ? Number(firstStroke.sequence)
        : Number.MAX_SAFE_INTEGER;
      const secondSequence = Number(secondStroke.sequence) > 0
        ? Number(secondStroke.sequence)
        : Number.MAX_SAFE_INTEGER;
      return firstSequence - secondSequence;
    });
  },

  _handleDrawingUsersUpdate(payload) {
    if (!this._drawing?.active || Number(payload?.channelId) !== this._drawing.channelId) return;
    const users = Array.isArray(payload.users) ? payload.users : [];
    this._drawing.participantCount = users.length;
    const countElement = document.getElementById('drawing-participant-count');
    if (countElement) {
      countElement.textContent = String(users.length);
      countElement.title = getDrawingText('drawing.participants', 'People viewing this board');
    }
  },

  _handleDrawingError(payload) {
    if (!this._drawing?.active) return;
    const message = typeof payload?.message === 'string'
      ? payload.message
      : getDrawingText('drawing.error', 'Drawing board error');
    this._showToast?.(message, 'error');
    if (payload?.code === 'access-revoked') {
      this._closeDrawingBoard();
      return;
    }
    if (payload?.code === 'board-unavailable') {
      this._drawing.syncing = false;
      this._setDrawingStatus('offline');
      return;
    }
    if (payload?.code === 'sync-rate-limited') {
      this._drawing.syncing = false;
      this._setDrawingStatus('connecting');
      if (this._drawing.syncRetryTimer) clearTimeout(this._drawing.syncRetryTimer);
      const retryDelayMs = Math.max(500, Math.min(15000, Number(payload.retryAfterMs) || 2000));
      this._drawing.syncRetryTimer = setTimeout(() => {
        this._drawing.syncRetryTimer = null;
        if (this._drawing.active && this.currentChannel && this.socket?.connected) {
          this._joinDrawingChannel(this.currentChannel);
        }
      }, retryDelayMs);
      return;
    }
    if (payload?.resync && this.socket?.connected && this._drawing.channelId && !this._drawing.syncing) {
      this._cancelLocalDrawingStroke();
      this._drawing.syncing = true;
      this._setDrawingStatus('connecting');
      this.socket.emit('drawing-sync-request');
    }
  },

  async _confirmClearDrawingBoard() {
    if (!this._drawing?.channelId || !this.user?.isAdmin) return;
    const title = getDrawingText('drawing.clear_confirm_title', 'Clear channel drawing?');
    const message = getDrawingText('drawing.clear_confirm_message', 'This removes every stroke for everyone currently viewing this board.');
    let confirmed = false;
    if (typeof this._showConfirmModal === 'function') {
      confirmed = await this._showConfirmModal(title, message, { danger: true });
    } else {
      confirmed = window.confirm(`${title}\n\n${message}`);
    }
    if (confirmed && this.socket?.connected) this.socket.emit('drawing-clear');
  },
};
