import { icon, escape as esc } from './icons.js';
import { api, write, storage, token } from './api.js';

const time = s => { const n = Number.isFinite(s) ? Math.max(0, s) : 0; return `${Math.floor(n / 60).toString().padStart(2, '0')}:${Math.floor(n % 60).toString().padStart(2, '0')}`; };
let hlsReady;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsReady) hlsReady = new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = '/vendor/anime-hls/hls.min.js';
    s.onload = () => resolve(window.Hls); s.onerror = () => { hlsReady = null; s.remove(); reject(new Error('播放器组件加载失败')); };
    document.head.append(s);
  });
  return hlsReady;
}
export function playerMarkup(show, ep, poster) {
  return `<div class="ac-player ac-no-src" tabindex="0" role="group" aria-label="视频播放器">
    <img class="ac-video-poster" src="${esc(poster)}" alt="">
    <video playsinline preload="metadata" aria-label="${esc(show.name)} 第${ep}话"></video>
    <div class="ac-danmaku-layer" aria-hidden="true"></div>
    <div class="ac-video-message"><span class="ac-spinner"></span><p>正在寻找这一话的播放线路…</p></div>
    <div class="ac-controls"><input class="ac-seek" type="range" aria-label="播放进度" min="0" max="1000" value="0" step="1">
      <div class="ac-control-row">
        <button data-player="play" title="播放 / 暂停（空格）" aria-label="播放 / 暂停">${icon('play')}</button>
        <button data-player="next" title="下一话" aria-label="下一话">${icon('skip')}</button>
        <span class="ac-time">00:00 / 00:00</span>
        <button data-player="mute" title="静音（M）" aria-label="静音">${icon('volume')}</button>
        <input class="ac-volume" aria-label="音量" type="range" min="0" max="1" step="0.05" value="0.8">
        <select class="ac-quality" aria-label="清晰度"><option value="-1">原画</option></select>
        <select class="ac-mpv-quality" hidden title="mpv 滤镜" aria-label="mpv 滤镜">
          <option value="anime">滤镜 · 动画</option>
          <option value="liveaction">滤镜 · 真人</option>
          <option value="aggressive">滤镜 · Anime4K</option>
          <option value="original">滤镜 · 原画</option>
        </select>
        <select class="ac-speed" aria-label="播放速度">${[.5,.75,1,1.25,1.5,1.75,2].map(n => `<option value="${n}" ${n === 1 ? 'selected' : ''}>${n === 1 ? '1.0' : n}×</option>`).join('')}</select>
        <button data-player="theatre" title="剧场模式（T）" aria-label="剧场模式">${icon('screen')}</button>
        <button data-player="pip" title="画中画" aria-label="画中画">${icon('pip')}</button>
        <button data-player="mpv" hidden title="用 Tigerest mpv 播放" aria-label="用 Tigerest mpv 播放">mpv</button>
        <button data-player="full" title="全屏（F）" aria-label="全屏">${icon('full')}</button>
      </div>
    </div>
  </div>
  <div class="ac-danmaku-bar"><label class="ac-toggle">弹幕<input type="checkbox" data-setting="danmaku" checked></label><label class="ac-toggle">外部弹幕<input type="checkbox" data-setting="external-danmaku" checked></label><span class="ac-danmaku-count">正在加载弹幕</span>
    <form data-form="danmaku"><input name="text" autocomplete="off" maxlength="100" placeholder="发一条友善的弹幕吧…" aria-label="弹幕内容"><button class="ac-btn ac-btn-primary" type="submit">发送</button></form>
  </div>`;
}

export class AnimePlayer {
  constructor(space, show, episode, epItems) {
    this.space = space; this.show = show; this.episode = episode; this.episodes = epItems;
    this.root = space.root.querySelector('.ac-player'); this.video = this.root.querySelector('video');
    this.layer = this.root.querySelector('.ac-danmaku-layer'); this.message = this.root.querySelector('.ac-video-message');
    this.stopped = false; this.loaded = false; this.streams = []; this.selected = -1; this.danmaku = []; this.shown = new Set();
    this.lastSave = 0; this.lastTime = 0; this.bound = new AbortController();
    this.video.volume = Math.min(1, Math.max(0, Number(storage.get('ciacord_anime_volume', .8)) || 0));
    this.video.playbackRate = [.5,.75,1,1.25,1.5,1.75,2].includes(storage.get('ciacord_anime_speed', 1)) ? storage.get('ciacord_anime_speed', 1) : 1;
    this.root.querySelector('.ac-volume').value = this.video.volume;
    this.root.querySelector('.ac-speed').value = this.video.playbackRate;
    const mpv = window.ciacordDesktop?.animeMpv;
    this.mpv = mpv?.customControls ? mpv : null;
    this.controls = this.root.querySelector('.ac-controls');
    this.mpvQuality = this.root.querySelector('.ac-mpv-quality');
    this.mpvQuality.value = storage.get('ciacord_anime_mpv_quality', 'anime');
    this.mpvButton = this.root.querySelector('[data-player=mpv]');
    this.mpvReady = this.mpv?.available().then(available => {
      if (!this.stopped && available) {
        this.mpvButton.hidden = false;
        this.updateMpvButton();
      }
      return available;
    }).catch(() => false);
    this.removeMpvStatus = this.mpv?.onStatus(status => this.updateMpvStatus(status));
    this.overlayMarkup = this.controls.innerHTML;
    this.removeOverlayInput = this.mpv?.onOverlayInput?.((id, action, value) => {
      if (id !== this.mpvId) return;
      if (['ac-seek', 'ac-volume', 'ac-speed', 'ac-mpv-quality'].includes(action)) {
        const control = this.controls.querySelector('.' + action);
        control.value = value;
        control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input'));
      } else if (['play', 'mute', 'next', 'theatre', 'full'].includes(action)) {
        this.action(action);
      }
    });
    this.removeOverlayReady = this.mpv?.onOverlayReady?.(id => {
      if (id !== this.mpvId) return;
      this.root.classList.add('ac-mpv-overlay');
      this.syncMpvLayout();
      this.syncMpvOverlay();
    });
    this.bind(); this.load(); this.loadDanmaku();
  }
  listen(el, event, fn) { el?.addEventListener(event, fn, { signal: this.bound.signal, capture: event === 'scroll' }); }
  bind() {
    const v = this.video;
    this.listen(this.root, 'click', e => {
      const action = e.target.closest('[data-player]')?.dataset.player;
      if (action) this.action(action);
      else if (e.target === v) this.action('play');
    });
    this.listen(this.controls, 'pointerenter', () => this.showMpvControls(true));
    this.listen(this.controls, 'pointerleave', () => this.showMpvControls(false));
    this.listen(this.controls, 'focusin', () => this.showMpvControls(true));
    this.listen(this.controls, 'focusout', event => {
      if (!this.controls.contains(event.relatedTarget) && !this.controls.matches(':hover')) this.showMpvControls(false);
    });
    this.listen(this.root, 'dblclick', e => { if (e.target === v) this.action('full'); });
    this.listen(this.root, 'mousemove', () => {
      this.root.classList.remove('ac-idle'); clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { if (!v.paused) this.root.classList.add('ac-idle'); }, 2500);
    });
    this.listen(this.root.querySelector('.ac-seek'), 'input', e => {
      if (this.mpvId) {
        if (this.mpvStatus?.duration) this.mpvCommand('seek', Number(e.target.value) / 1000 * this.mpvStatus.duration);
        return;
      }
      if (Number.isFinite(v.duration)) { v.currentTime = Number(e.target.value) / 1000 * v.duration; this.shown.clear(); this.layer.replaceChildren(); }
    });
    this.listen(this.root.querySelector('.ac-volume'), 'input', e => { v.volume = Number(e.target.value); v.muted = false; storage.set('ciacord_anime_volume', v.volume); this.mpvCommand('volume', v.volume * 100); });
    this.listen(this.root.querySelector('.ac-speed'), 'change', e => { v.playbackRate = Number(e.target.value); storage.set('ciacord_anime_speed', v.playbackRate); this.mpvCommand('speed', v.playbackRate); });
    this.listen(this.mpvQuality, 'change', () => this.setMpvQuality(this.mpvQuality.value));
    this.listen(this.root.querySelector('.ac-quality'), 'change', e => { if (this.hls) this.hls.currentLevel = Number(e.target.value); });
    this.listen(this.space.root.querySelector('[data-track=subtitles]'), 'change', event => {
      if (this.mpvId) return this.mpvCommand('subtitle', event.target.value === 'off' ? 'no' : Number(event.target.value));
      this.subtitleTracks().forEach((track, index) => {
        track.mode = String(index) === event.target.value ? 'showing' : 'disabled';
      });
    });
    this.listen(this.space.root.querySelector('[data-track=audio]'), 'change', event => {
      if (this.mpvId) return this.mpvCommand('audio', Number(event.target.value));
      Array.from(v.audioTracks || []).forEach((track, index) => {
        track.enabled = String(index) === event.target.value;
      });
    });
    this.listen(v.textTracks, 'addtrack', () => this.updateTracks());
    this.listen(v.audioTracks, 'addtrack', () => this.updateTracks());
    this.listen(v, 'timeupdate', () => this.tick());
    this.listen(v, 'play', () => { this.root.querySelector('[data-player=play]').innerHTML = icon('pause'); this.message.hidden = true; });
    this.listen(v, 'pause', () => { this.root.classList.remove('ac-idle'); this.root.querySelector('[data-player=play]').innerHTML = icon('play'); this.save(); });
    this.listen(v, 'volumechange', () => { this.root.querySelector('[data-player=mute]').innerHTML = icon(v.muted ? 'mute' : 'volume'); });
    this.listen(v, 'loadedmetadata', () => {
      if (this.stopped) return;
      this.loaded = true; this.message.hidden = true;
      const saved = this.space.library[this.show.id];
      const position = this.resumePosition ?? (Number(saved?.episode) === this.episode ? saved.position : 0);
      if (position > 0 && position < v.duration - 10) v.currentTime = position;
      this.resumePosition = null;
      v.playbackRate = Number(this.root.querySelector('.ac-speed').value) || 1;
      this.tick();
      this.updateTracks();
      if (this.wantPlay) v.play().catch(() => this.showStart());
      else this.showStart();
    });
    this.listen(v, 'waiting', () => { if (!v.paused) this.setMessage('<span class="ac-spinner"></span><p>正在缓冲…</p>'); });
    this.listen(v, 'playing', () => { this.message.hidden = true; });
    this.listen(v, 'error', () => {
      if (!this.stopped && v.getAttribute('src')) this.sourceFailed();
    });
    this.listen(v, 'ended', async () => {
      this.save(true);
      if (storage.get('ciacord_anime_autonext', true)) this.next();
    });
    this.listen(window, 'keydown', e => {
      if (!this.space.active || this.stopped || /INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName) || e.target.isContentEditable || this.space.root.querySelector('.ac-dialog')) return;
      const action = ({ ' ': 'play', k: 'play', m: 'mute', f: 'full', t: 'theatre' })[e.key.toLowerCase()];
      if (action) { e.preventDefault(); this.action(action); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); if (this.mpvId && Number.isFinite(this.mpvStatus?.duration)) {
        this.mpvCommand('seek', Math.min(this.mpvStatus.duration, Math.max(0, this.mpvStatus.position + (e.key === 'ArrowRight' ? 5 : -5))));
      } else if (Number.isFinite(v.duration)) v.currentTime = Math.min(v.duration, Math.max(0, v.currentTime + (e.key === 'ArrowRight' ? 5 : -5))); }
    });
    this.listen(window, 'scroll', () => this.syncMpvLayout());
    this.listen(window, 'resize', () => this.syncMpvLayout());
    this.listen(document, 'fullscreenchange', () => this.syncMpvLayout());
    this.listen(window, 'pagehide', () => this.save(false, true));
    this.listen(document, 'visibilitychange', () => { if (document.hidden) this.save(false, true); });
    const toggle = this.space.root.querySelector('[data-setting=danmaku]');
    toggle.checked = storage.get('ciacord_anime_danmaku', true);
    this.listen(toggle, 'change', () => { storage.set('ciacord_anime_danmaku', toggle.checked); this.layer.hidden = !toggle.checked; });
    this.layer.hidden = !toggle.checked;
    const external = this.space.root.querySelector('[data-setting=external-danmaku]');
    external.checked = storage.get('ciacord_anime_external_danmaku', true);
    this.listen(external, 'change', () => {
      storage.set('ciacord_anime_external_danmaku', external.checked);
      this.layer.replaceChildren();
      this.loadDanmaku();
    });
    this.listen(this.space.root.querySelector('[data-form=danmaku]'), 'submit', async e => {
      e.preventDefault(); if (!token()) return this.space.toast('登录聊天账号后即可发送弹幕');
      const input = e.target.elements.text; const text = input.value.trim(); if (!text) return;
      const button = e.target.querySelector('button'); button.disabled = true;
      try {
        await write(`/subjects/${this.show.id}/danmaku/${this.episode}`, { text, time: v.currentTime });
        input.value = ''; this.fly(text); this.space.toast('弹幕已发送');
        this.danmaku.push({ id: `local-${Date.now()}`, time: v.currentTime, text });
      } catch (err) { this.space.toast(err.message); } finally { button.disabled = false; }
    });
  }
  setMessage(html) { this.message.innerHTML = html; this.message.hidden = false; }
  showStart() {
    const saved = this.space.library[this.show.id];
    const position = this.resumePosition ?? (Number(saved?.episode) === this.episode ? saved.position : 0);
    const resume = Number.isFinite(position) && position >= 5 &&
      (!Number.isFinite(saved?.duration) || position < saved.duration - 10);
    this.setMessage(`<button class="ac-start-play" type="button" data-player="play">
      <span class="ac-start-play-icon" aria-hidden="true">${icon('play')}</span>
      <span class="ac-start-play-label">${resume ? '继续播放' : '开始播放'}</span>
    </button>${resume ? `<p class="ac-start-position">上次看到 ${time(position)}</p>` : ''}`);
  }
  async load() {
    const serial = this.resolveSerial = (this.resolveSerial || 0) + 1;
    const path = `/subjects/${this.show.id}/play/${this.episode}`;
    const torrent = api(path + '?type=torrent').catch(() => null);
    this.streams = [];
    this.selected = -1;
    this.searchingWeb = false;
    this.webSearched = false;
    this.webFailures = [];
    this.torrentFailures = [];
    this.pikpakAvailable = false;
    this.searchingTorrent = true;
    this.torrentSearchFailed = false;
    this.setMessage('<span class="ac-spinner"></span><p>正在寻找这一话的播放线路…</p>');
    this.webSearchFailed = false;
    const direct = await api(path).catch(() => null);
    if (this.stopped || serial !== this.resolveSerial) return;
    const directStreams = direct?.streams || [];
    const selected = this.streams[this.selected];
    this.streams = [...directStreams, ...this.streams];
    this.selected = this.streams.indexOf(selected);
    if (!directStreams.some(stream => (stream.category || 'api') === 'api') && !this.webSearched) {
      void this.searchWeb();
    }
    this.updateSourceSelection();
    const result = await torrent;
    if (this.stopped || serial !== this.resolveSerial) return;
    this.searchingTorrent = false;
    this.torrentFailures = result?.errors || [];
    this.torrentSearchFailed = !result;
    this.pikpakAvailable = result?.pikpakAvailable === true;
    this.streams.push(...(result?.streams || []));
    this.updateSourceSelection();
  }
  async searchWeb() {
    if (this.searchingWeb || this.stopped) return;
    const serial = this.resolveSerial;
    this.searchingWeb = true;
    this.webSearchFailed = false;
    if (this.selected < 0) this.setMessage('<span class="ac-spinner"></span><p>正在搜索网页源…</p>');
    this.renderSources();
    const result = await api(`/subjects/${this.show.id}/play/${this.episode}?type=web`).catch(() => null);
    if (this.stopped || serial !== this.resolveSerial) return;
    this.searchingWeb = false;
    this.webSearched = true;
    this.webSearchFailed = !result;
    this.webFailures = result?.errors || [];
    const selected = this.streams[this.selected];
    const streams = this.streams.filter(stream => stream.category !== 'web' || stream === selected);
    const btIndex = streams.findIndex(stream => stream.type === 'torrent');
    streams.splice(btIndex < 0 ? streams.length : btIndex, 0,
      ...(result?.streams || []).map(stream => ({ ...stream, category: 'web' })));
    this.streams = streams;
    this.selected = streams.indexOf(selected);
    this.updateSourceSelection();
  }
  updateSourceSelection() {
    if (this.selected < 0) {
      this.selectFirst(false);
      if (this.selected < 0 && !this.searchingWeb && !this.searchingTorrent && !this.directPlayback()) {
        if (this.streams.some(stream => stream.type === 'torrent')) {
          this.setMessage('<p>已找到 BT 资源，请在下方选择线路。</p>');
        } else {
          this.setMessage('<p>暂未找到这一话的可播放线路。</p><button class="ac-btn ac-btn-primary" data-player="retry">重新查找</button>');
        }
      }
    }
    this.renderSources();
  }
  directPlayback() { return storage.get('ciacord_anime_transport', 'relay') === 'direct'; }
  btEngine() {
    const preferred = storage.get('ciacord_anime_bt_engine', 'pikpak');
    return this.pikpakAvailable && preferred === 'pikpak' ? 'pikpak' : 'webtorrent';
  }
  streamUrl(stream) {
    if (this.directPlayback()) return stream?.directUrl;
    if (stream?.type === 'torrent') return `${stream.url}?engine=${this.btEngine()}`;
    return stream?.url;
  }
  selectFirst(play) {
    const direct = this.directPlayback();
    const index = this.streams.findIndex(stream => stream.type !== 'torrent' && (!direct || stream.directUrl));
    if (index >= 0) this.select(index, play);
    else if (direct && !this.searchingWeb) this.setMessage('<p>暂无可直连的线路，可以切换到服务器中转。</p>');
  }
  renderSources() {
    const el = this.space.root.querySelector('.ac-source-options');
    if (!el) return;
    const current = this.streams[this.selected];
    const groupFor = stream => stream.category || (stream.type === 'torrent' ? 'torrent' : 'api');
    const groups = [
      ['api', 'API 线路'], ['library', '媒体库与自定义直连'], ['web', '网页源'],
      ['mikan', 'Mikan · 蜜柑计划'], ['torrent', 'BT 源']
    ];
    const auto = this.streams.some(stream => stream.type !== 'torrent') ? `<button type="button" data-stream="auto" aria-pressed="${!this.manualSource}" class="${!this.manualSource ? 'active' : ''}">自动选择 ${icon('check')}</button>` : '';
    el.innerHTML = `<div class="ac-source-toolbar">${auto}</div>` + groups.map(([key, title]) => {
      const subgroups = new Map();
      const buttons = this.streams.map((stream, index) => {
        if (groupFor(stream) !== key) return '';
        const label = stream.name === stream.provider ? stream.name : `${stream.provider} / ${stream.name}`;
        const active = index === this.selected;
        const unavailable = this.directPlayback() && !stream.directUrl;
        const button = `<button type="button" data-stream="${index}" aria-pressed="${active}" class="${active ? 'active' : ''}" ${unavailable ? 'disabled title="需要服务器中转"' : ''}>${esc(key === 'mikan' ? stream.name : label)}</button>`;
        if (key !== 'mikan') return button;
        const subgroup = stream.subgroup || '未标注字幕组';
        if (!subgroups.has(subgroup)) subgroups.set(subgroup, []);
        subgroups.get(subgroup).push(button);
        return '';
      }).join('');
      const grouped = [...subgroups].map(([name, variants]) =>
        `<div class="ac-source-subgroup"><h4>${esc(name)}</h4><div class="ac-source-row">${variants.join('')}</div></div>`
      ).join('');
      if (!buttons && key === 'library') return '';
      const status = key === 'web'
        ? (this.searchingWeb ? '正在搜索…' : this.webSearchFailed ? '搜索失败，可重试' : this.webSearched && !buttons ? '没有匹配线路' : '')
        : key === 'torrent' || key === 'mikan'
          ? (this.searchingTorrent ? '正在搜索…' : this.torrentSearchFailed || (key === 'mikan' && this.torrentFailures?.includes('Mikan')) ? '搜索失败' : !buttons && !grouped ? '没有匹配线路' : '')
        : !buttons ? (this.searchingTorrent ? '正在加载…' : '暂无线路') : '';
      const search = key === 'web' ? `<button type="button" data-search-web ${this.searchingWeb ? 'disabled' : ''}>${this.webSearched ? '重新搜索网页源' : '搜索网页源'}</button>` : '';
      return `<section class="ac-source-group" aria-label="${title}"><h3>${title}</h3>${grouped || `<div class="ac-source-row">${search}${buttons}${status ? `<span class="ac-summary" role="status">${status}</span>` : ''}</div>`}</section>`;
    }).join('');
    el.querySelector('[data-search-web]').onclick = () => this.searchWeb();
    const toolbar = el.querySelector('.ac-source-toolbar');
    const transport = document.createElement('label');
    transport.className = 'ac-summary';
    transport.textContent = '播放方式 ';
    const mode = document.createElement('select');
    mode.setAttribute('aria-label', '播放方式');
    mode.innerHTML = '<option value="relay">服务器中转</option><option value="direct">客户端直连</option>';
    mode.value = this.directPlayback() ? 'direct' : 'relay';
    mode.onchange = () => {
      const play = !this.video.paused || this.wantPlay;
      storage.set('ciacord_anime_transport', mode.value);
      if (current && (!this.directPlayback() || current.directUrl)) this.select(this.selected, play);
      else {
        this.streamVersion = (this.streamVersion || 0) + 1;
        this.hls?.destroy();
        this.hls = null;
        this.video.pause();
        this.video.removeAttribute('src');
        this.video.load();
        this.loaded = false;
        this.selected = -1;
        this.manualSource = false;
        this.selectFirst(play);
        if (this.selected < 0 && !this.directPlayback()) {
          this.setMessage(this.streams.length ? '<p>请选择一条 BT 线路。</p>' : '<p>暂未找到可播放线路。</p>');
        }
        this.renderSources();
      }
      el.querySelector('select')?.focus();
    };
    transport.append(mode);
    toolbar.prepend(transport);
    const bt = document.createElement('label');
    bt.className = 'ac-summary';
    bt.textContent = 'BT 播放 ';
    const engine = document.createElement('select');
    engine.dataset.btEngine = '';
    engine.setAttribute('aria-label', 'BT 播放方式');
    engine.add(new Option('服务器下载 BT', 'webtorrent'));
    const pikpak = new Option(this.pikpakAvailable ? 'PikPak 云端离线' : 'PikPak 云端离线（未启用）', 'pikpak');
    pikpak.disabled = !this.pikpakAvailable;
    engine.add(pikpak);
    engine.value = this.btEngine();
    engine.onchange = () => {
      storage.set('ciacord_anime_bt_engine', engine.value);
      if (current?.type === 'torrent') this.select(this.selected, !this.video.paused || this.wantPlay);
      el.querySelector('[data-bt-engine]')?.focus();
    };
    bt.append(engine);
    transport.after(bt);
    if (current?.type === 'video' && !this.directPlayback()) {
      const cache = document.createElement('button');
      cache.type = 'button';
      cache.textContent = this.cacheDownload ? '取消缓存' : '缓存本集';
      cache.onclick = () => this.cacheCurrent();
      toolbar.append(cache);
    }
    const failures = [...(this.webFailures || []), ...(this.torrentFailures || [])];
    if (failures.length) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      details.className = 'ac-summary';
      summary.textContent = `${failures.length} 个来源暂不可用`;
      details.append(summary, document.createTextNode(failures.join('、')));
      el.append(details);
    }
    el.querySelectorAll('[data-stream]').forEach(button => button.addEventListener('click', () => {
      const manual = button.dataset.stream !== 'auto';
      const index = Number(button.dataset.stream);
      if (manual && this.directPlayback() && !this.streams[index]?.directUrl) {
        return this.space.toast('此线路需要服务器中转');
      }
      this.manualSource = manual;
      if (manual) this.select(index, !this.video.paused);
      else this.selectFirst(!this.video.paused);
    }));
    const elSource = this.space.root.querySelector('[data-source-caption]');
    if (elSource) elSource.textContent = this.streams[this.selected]?.provider || '正在选择';
  }
  subtitleTracks() {
    return Array.from(this.video.textTracks || []).filter(track =>
      track.kind === 'subtitles' || track.kind === 'captions'
    );
  }
  async cacheCurrent() {
    if (this.cacheDownload) { this.cacheDownload.abort(); return; }
    const stream = this.streams[this.selected];
    if (stream?.type !== 'video' || !navigator.serviceWorker) return this.space.toast('此线路或浏览器无法离线缓存');
    const controller = this.cacheDownload = new AbortController();
    this.renderSources();
    try {
      const { cacheEpisode } = await import('./offline.js');
      await cacheEpisode({
        id: this.show.id + '/' + this.episode, title: this.show.name,
        episode: this.episode, url: stream.url
      }, controller.signal);
      this.space.toast('本集已缓存，可在看番设置中打开离线缓存');
    } catch (error) {
      this.space.toast(controller.signal.aborted ? '已取消缓存' : error.message || '缓存失败');
    } finally {
      this.cacheDownload = null;
      if (!this.stopped) this.renderSources();
    }
  }
  updateTracks() {
    if (this.mpvId) return;
    if (this.stopped) return;
    const subtitles = this.space.root.querySelector('[data-track=subtitles]');
    const audio = this.space.root.querySelector('[data-track=audio]');
    const textTracks = this.subtitleTracks();
    const audioTracks = Array.from(this.video.audioTracks || []);
    if (subtitles) {
      subtitles.disabled = textTracks.length === 0;
      subtitles.innerHTML = textTracks.length
        ? '<option value="off">关闭</option>' + textTracks.map((track, index) =>
          `<option value="${index}" ${track.mode === 'showing' ? 'selected' : ''}>${esc(track.label || track.language || `字幕 ${index + 1}`)}</option>`
        ).join('')
        : '<option>随片源</option>';
    }
    if (audio) {
      audio.disabled = audioTracks.length < 2;
      audio.innerHTML = audioTracks.length
        ? audioTracks.map((track, index) =>
          `<option value="${index}" ${track.enabled ? 'selected' : ''}>${esc(track.label || track.language || '默认音轨')}</option>`
        ).join('')
        : '<option>随片源</option>';
    }
  }
  sourceFailed(message = '这条线路暂时无法播放，可尝试下方的其他线路。') {
    if (this.stopped) return;
    const direct = this.directPlayback();
    const next = this.streams.findIndex((stream, index) => index > this.selected && stream.type !== 'torrent' && (!direct || stream.directUrl));
    if (!this.manualSource && next >= 0) {
      this.select(next, this.wantPlay);
      return;
    }
    if (direct) message = '客户端直连失败，可尝试其他线路或切换到服务器中转。';
    else if (this.streams[this.selected]?.type === 'torrent' && this.btEngine() === 'pikpak') {
      message = 'PikPak 暂时无法播放，可在「BT 播放」中切换到服务器下载 BT。';
    }
    this.setMessage(`<p>${esc(message)}</p><button class="ac-btn ac-btn-primary" data-player="retry">重试加载</button>`);
  }
  async select(index, play) {
    const stream = this.streams[index]; if (!stream || this.stopped) return;
    const url = this.streamUrl(stream);
    if (!url) return this.space.toast('此线路需要服务器中转');
    const native = !!this.mpvId;
    const position = this.mpvStatus?.position ?? (this.video.currentTime || this.resumePosition);
    this.stopMpv();
    const version = this.streamVersion = (this.streamVersion || 0) + 1;
    this.resumePosition = position ?? null; this.wantPlay = play; this.loaded = false;
    this.selected = index; this.hls?.destroy(); this.hls = null;
    this.video.pause(); this.video.removeAttribute('src'); this.video.load();
    this.root.classList.remove('ac-no-src'); this.renderSources(); this.updateMpvButton();
    this.setMessage(stream.type === 'torrent'
      ? `<span class="ac-spinner"></span><p>${this.btEngine() === 'pikpak' ? '正在等待 PikPak 云端视频…' : '正在连接 BT 做种节点…'}</p>`
      : '<span class="ac-spinner"></span><p>正在连接播放源…</p>');
    const q = this.root.querySelector('.ac-quality'); q.innerHTML = `<option value="-1">${esc(stream.resolution)}</option>`;
    try {
      if (this.mpv) {
        const available = await this.mpvReady;
        if (this.stopped || version !== this.streamVersion) return;
        if (!available) {
          this.setMessage('<p>桌面端 mpv 不可用，请检查 Ciacord 安装。</p>');
          return;
        }
        if (play || native) {
          if (!await this.openMpv() && !this.stopped && version === this.streamVersion) this.showStart();
        } else {
          this.showStart();
        }
        return;
      }
      if (this.stopped || version !== this.streamVersion) return;
      if (stream.type === 'hls' && !this.video.canPlayType('application/vnd.apple.mpegurl')) {
        const Hls = await loadHls();
        if (this.stopped || version !== this.streamVersion) return;
        if (!Hls.isSupported()) throw new Error('当前浏览器不支持此格式，请尝试其他线路');
        const hls = this.hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60 });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (this.stopped) return;
          q.innerHTML = '<option value="-1">自动</option>' + hls.levels.map((l, i) => `<option value="${i}">${l.height || '原画'}${l.height ? 'P' : ''}</option>`).join('');
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal && version === this.streamVersion) this.sourceFailed();
        });
        hls.loadSource(url); hls.attachMedia(this.video);
      } else { this.video.src = url; this.video.load(); }
    } catch (e) { if (version === this.streamVersion) this.sourceFailed(e.message); }
  }
  next() {
    const next = this.episodes.find(e => e.sort > this.episode);
    if (next) this.space.navigate(`watch/${this.show.id}/${next.sort}`);
    else this.space.toast('已经是最后一话啦');
  }
  updateMpvButton() {
    this.mpvButton.disabled = !this.streams[this.selected] || !!this.mpvOpening || !!this.mpvId;
  }
  async openMpv() {
    const stream = this.streams[this.selected];
    const url = this.streamUrl(stream);
    if (!url || this.mpvOpening || this.mpvId || !this.mpv) return;
    const saved = this.space.library[this.show.id];
    const position = this.video.currentTime || this.resumePosition ||
      (Number(saved?.episode) === this.episode ? saved.position : 0);
    this.root.classList.remove('ac-idle');
    const rect = this.mpvRect();
    if (!rect) return;
    const version = this.streamVersion;
    this.mpvOpening = true;
    this.updateMpvButton();
    try {
      const id = await this.mpv.open({
        url: new URL(url, location.href).href,
        title: `${this.show.name} · 第${this.episode}话`,
        position, rect, overlay: !!this.mpv.transparentControls, quality: this.mpvQuality.value, volume: this.video.volume * 100, speed: this.video.playbackRate, muted: this.video.muted,
      });
      if (this.stopped || version !== this.streamVersion) {
        await this.mpv.stop(id);
        return;
      }
      this.mpvId = id;
      this.wantPlay = false;
      this.hls?.destroy();
      this.hls = null;
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.loaded = false;
      this.message.hidden = true;
      this.root.classList.add('ac-mpv-active');
      if (this.controls.matches(':hover, :focus-within')) this.showMpvControls(true);
      this.mpvQuality.hidden = !this.mpv.qualityProfiles;
      this.root.querySelector('[data-player=play]').innerHTML = icon('pause');
      this.lastMpvRect = '';
      this.mpvLayoutTimer = setInterval(() => this.syncMpvLayout(), 33);
      this.syncMpvLayout();
      return true;
    } catch {
      if (!this.stopped) this.space.toast('内嵌 mpv 启动失败');
    } finally {
      this.mpvOpening = false;
      this.updateMpvButton();
    }
  }
  showMpvControls(visible) {
    if (!this.mpvId) return;
    this.root.classList.toggle('ac-mpv-controls-visible', visible);
    this.syncMpvLayout();
  }
  mpvRect() {
    if (document.hidden || !this.space.active || this.space.root.querySelector('.ac-dialog')) return null;
    const rect = this.root.getBoundingClientRect();
    const controlsTop = this.root.classList.contains('ac-mpv-overlay') ? rect.bottom : this.root.classList.contains('ac-mpv-controls-visible')
      ? this.controls.getBoundingClientRect().top : rect.bottom - 10;
    if (rect.width < 1 || rect.height < 1) return null;
    const main = this.root.closest('.ac-main');
    const clip = main?.getBoundingClientRect();
    const toolbar = main?.querySelector('.ac-toolbar')?.getBoundingClientRect();
    const fullscreen = document.fullscreenElement === this.root;
    const left = Math.max(0, clip?.left ?? 0, rect.left);
    const top = Math.max(0, fullscreen ? 0 : toolbar?.bottom ?? clip?.top ?? 0, rect.top);
    const right = Math.min(innerWidth, clip?.right ?? innerWidth, rect.right);
    const bottom = Math.min(innerHeight, clip?.bottom ?? innerHeight, rect.bottom, controlsTop);
    if (right <= left || bottom <= top) return null;
    return [rect.x, rect.y, rect.width, rect.height,
      left - rect.x, top - rect.y, right - rect.x, bottom - rect.y];
  }
  syncMpvOverlay() {
    if (!this.mpvId || !this.root.classList.contains('ac-mpv-overlay')) return;
    const values = {};
    for (const selector of ['.ac-seek', '.ac-volume', '.ac-speed', '.ac-mpv-quality']) {
      values[selector] = this.controls.querySelector(selector).value;
    }
    const markup = this.overlayMarkup.replace('class="ac-mpv-quality" hidden', 'class="ac-mpv-quality"');
    this.mpv.overlayState(this.mpvId, {
      html: markup, height: this.controls.offsetHeight, values,
      played: this.controls.querySelector('.ac-seek').style.getPropertyValue('--played'),
      time: this.controls.querySelector('.ac-time').textContent,
      icons: { play: this.controls.querySelector('[data-player=play]').innerHTML,
        mute: this.controls.querySelector('[data-player=mute]').innerHTML },
    });
  }
  syncMpvLayout() {
    if (!this.mpvId) return;
    const rect = this.mpvRect();
    const key = JSON.stringify(rect);
    if (key === this.lastMpvRect) return;
    this.lastMpvRect = key;
    this.mpv.layout(this.mpvId, rect);
  }
  clearMpvSurface() {
    this.mpvId = null;
    clearInterval(this.mpvLayoutTimer);
    this.root.classList.remove('ac-mpv-active', 'ac-mpv-overlay');
    this.mpvQuality.hidden = true;
    this.root.classList.remove('ac-mpv-controls-visible');
    this.mpvStatus = null;
    this.pendingMpvPause = null;
    this.mpvTracks = '';
    this.updateTracks();
    this.root.querySelector('[data-player=play]').innerHTML = icon('play');
    this.updateMpvButton();
  }
  setMpvQuality(quality) {
    this.mpvQuality.value = quality;
    storage.set('ciacord_anime_mpv_quality', quality);
    this.mpvCommand('quality', quality);
  }
  mpvCommand(action, value) {
    if (this.mpvId) this.mpv.command(this.mpvId, action, value);
  }
  updateMpvTracks(tracks) {
    const key = JSON.stringify(tracks);
    if (this.mpvTracks === key) return;
    this.mpvTracks = key;
    for (const [type, selector] of [['audio', 'audio'], ['sub', 'subtitles']]) {
      const select = this.space.root.querySelector(`[data-track=${selector}]`);
      if (!select) continue;
      const options = tracks.filter(track => track.type === type);
      select.disabled = !options.length || (type === 'audio' && options.length < 2);
      select.replaceChildren(...(type === 'sub' ? [new Option('关闭', 'off')] : []),
        ...options.map(track => new Option(track.title || track.lang || String(track.id), track.id, false, track.selected)));
      if (!select.options.length) select.add(new Option('随片源'));
      if (type === 'sub' && !options.some(track => track.selected)) select.value = 'off';
    }
  }
  updateMpvStatus(status) {
    if (!this.mpvId || status.id !== this.mpvId || this.stopped) return;
    this.mpvStatus = status;
    const pending = this.pendingMpvPause;
    if (pending && (status.paused === pending.paused || Date.now() >= pending.expires)) {
      this.pendingMpvPause = null;
    }
    this.root.querySelector('[data-player=play]').innerHTML =
      icon((this.pendingMpvPause?.paused ?? status.paused) ? 'play' : 'pause');
    if (Number.isFinite(status.duration) && Number.isFinite(status.position)) {
      const seek = this.root.querySelector('.ac-seek');
      const fraction = status.duration > 0 ? status.position / status.duration : 0;
      if (!seek.matches(':active')) seek.value = fraction * 1000;
      seek.style.setProperty('--played', `${fraction * 100}%`);
      this.root.querySelector('.ac-time').textContent = `${time(status.position)} / ${time(status.duration)}`;
      this.root.querySelector('[data-player=mute]').innerHTML = icon(status.muted ? 'mute' : 'volume');
      this.updateMpvTracks(status.tracks || []);
    }
    if (status.ended || status.closed || Date.now() - this.lastSave > 10000) {
      this.savePosition(status.position, status.duration, status.ended);
    }
    this.syncMpvOverlay();
    if (!status.closed) return;
    this.clearMpvSurface();
    this.resumePosition = !status.ended && Number.isFinite(status.position) ? status.position : null;
    if (this.video.paused) this.showStart();
    if (status.ended && !status.failed && storage.get('ciacord_anime_autonext', true) &&
        this.episodes.some(episode => episode.sort > this.episode)) this.next();
    if (status.failed) this.space.toast('mpv 播放失败，可尝试换一条线路');
  }
  stopMpv() {
    if (!this.mpvId) return;
    this.mpv.stop(this.mpvId).catch(() => {});
    this.clearMpvSurface();
  }
  async action(action) {
    const v = this.video;
    try {
      if (action === 'mpv') return this.openMpv();
      if (action === 'play') {
        if (this.mpvId) {
          const paused = !(this.pendingMpvPause?.paused ?? this.mpvStatus?.paused ?? false);
          this.pendingMpvPause = { paused, expires: Date.now() + 1000 };
          this.root.querySelector('[data-player=play]').innerHTML = icon(paused ? 'play' : 'pause');
          this.syncMpvOverlay();
          this.mpvCommand('pause', paused);
          return;
        }
        if (!this.streams.length) return this.load();
        if (this.mpv) {
          if (!await this.mpvReady) return this.space.toast('桌面端 mpv 不可用，请检查 Ciacord 安装');
          if (this.selected < 0) return this.selectFirst(true);
          return this.openMpv();
        }
        if (!v.getAttribute('src') && !this.hls) {
          if (this.selected >= 0) return this.select(this.selected, true);
          return this.selectFirst(true);
        }
        if (v.paused) { this.wantPlay = true; await v.play(); } else v.pause();
      }
      if (action === 'next') this.next();
      if (action === 'mute') {
        if (this.mpvId) { this.mpvCommand('mute'); v.muted = !this.mpvStatus?.muted; }
        else v.muted = !v.muted;
      }
      if (action === 'theatre') { this.space.root.classList.toggle('ac-theatre'); this.root.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
      if (action === 'full') { if (document.fullscreenElement) await document.exitFullscreen(); else await this.root.requestFullscreen(); }
      if (action === 'pip') {
        if (!document.pictureInPictureEnabled) return this.space.toast('当前浏览器不支持画中画');
        if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await v.requestPictureInPicture();
      }
      if (action === 'retry') { this.resumePosition = v.currentTime; await this.load(); }
    } catch { this.space.toast('暂时无法执行此操作，请先开始播放'); }
  }
  tick() {
    const v = this.video; if (this.stopped || this.mpvId) return;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const input = this.root.querySelector('.ac-seek');
    input.value = dur ? (v.currentTime / dur * 1000) : 0;
    input.style.setProperty('--played', `${dur ? v.currentTime / dur * 100 : 0}%`);
    this.root.querySelector('.ac-time').textContent = `${time(v.currentTime)} / ${time(dur)}`;
    if (v.currentTime < this.lastTime - 2) { this.shown.clear(); this.layer.replaceChildren(); }
    if (v.currentTime > this.lastTime + 3) this.layer.replaceChildren();
    if (storage.get('ciacord_anime_danmaku', true)) for (const d of this.danmaku) {
      if (Math.abs(d.time - v.currentTime) < .6 && !this.shown.has(d.id)) { this.shown.add(d.id); this.fly(d.text); }
    }
    this.lastTime = v.currentTime;
    if (Date.now() - this.lastSave > 10000) this.save();
  }
  save(ended = false, keepalive = false) {
    const v = this.video;
    if (!this.loaded || this.mpvId) return;
    this.savePosition(v.currentTime, v.duration, ended, keepalive);
  }
  savePosition(position, duration, ended = false, keepalive = false) {
    if (!Number.isFinite(duration) || !Number.isFinite(position) || position < 1) return;
    this.lastSave = Date.now();
    const old = this.space.library[this.show.id] || {};
    const watched = [...new Set([...(old.watched || []), ...(ended || position > duration * .9 ? [this.episode] : [])])];
    this.space.saveLibrary(this.show.id, { episode: this.episode, position, duration, watched }, true, keepalive);
  }
  async loadDanmaku() {
    const serial = this.danmakuSerial = (this.danmakuSerial || 0) + 1;
    const path = `/subjects/${this.show.id}/danmaku/${this.episode}`;
    const external = storage.get('ciacord_anime_external_danmaku', true);
    const [local, cloud] = await Promise.all([
      api(path).catch(() => null),
      external ? api(path + '/external').catch(() => null) : null
    ]);
    if (this.stopped || serial !== this.danmakuSerial) return;
    this.danmaku = [...(local?.items || []), ...(cloud?.items || [])];
    const el = this.space.root.querySelector('.ac-danmaku-count');
    if (el) el.textContent = `${this.danmaku.length} 条弹幕${cloud?.errors?.length ? ' · 部分外部来源不可用' : ''}`;
  }
  fly(text) {
    if (this.layer.hidden || this.layer.childElementCount > 18) return;
    const el = document.createElement('span'); el.className = 'ac-danmaku-text'; el.textContent = text;
    el.style.top = `${8 + ((this.lane = ((this.lane || 0) + 1) % 5)) * 29}px`;
    el.style.setProperty('--ac-travel', `${this.root.clientWidth}px`);
    this.layer.append(el); el.addEventListener('animationend', () => el.remove(), { once: true });
  }
  destroy() {
    this.cacheDownload?.abort();
    this.save(); this.stopMpv(); this.removeMpvStatus?.(); this.removeOverlayInput?.(); this.removeOverlayReady?.(); this.stopped = true; this.bound.abort(); clearTimeout(this.idleTimer);
    this.hls?.destroy(); this.video.pause(); this.video.removeAttribute('src'); this.video.load();
  }
}
