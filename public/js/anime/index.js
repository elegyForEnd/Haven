import { icon, escape as esc } from './icons.js';
import '../manga/index.js?v=20261115-1';
import { api, write, storage, token } from './api.js';
import { AnimePlayer, playerMarkup } from './player.js?v=20261115-play-controls';
import { artworkMarkup, bindEpisodeSummaries, detailEpisodeList, detailMarkup, episodeCards, setupBackdrops } from './detail.js?v=20261114-backdrop-fade';

const ASSETS = '/img/anime/';
const REFERENCE_ASSETS = ASSETS + 'reference/';
const mascotImage = ASSETS + 'mascot-cat.webp';
const heroImage = REFERENCE_ASSETS + 'hero.webp';
const featuredId = 400602;
const footer = () => `<footer class="ac-footer">${icon('flower')}<span>ciacord · 今天也要开心追番</span>${icon('flower')}<a href="https://github.com/open-ani/animeko" target="_blank" rel="noopener noreferrer">Animeko 数据源</a><a href="https://bgm.tv" target="_blank" rel="noopener noreferrer">Bangumi</a></footer>`;
const heading = (title, symbol = 'flower', extra = '') => `<div class="ac-section-head">${icon(symbol)}<h2>${esc(title)}</h2><svg class="ac-flourish" viewBox="0 0 72 21" aria-hidden="true"><path d="M2 15c13-13 25 2 38 0 15-2 13-12 5-10-5 1-5 6 0 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="m62 2 2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#efbb79"/></svg>${extra}</div>`;
const more = (route, label = '全部') => `<button class="ac-more" data-route="${route}">${label}${icon('next')}</button>`;
const pagination = (route, label, { page = 1, pages = 1 }) => pages > 1 ? `<nav aria-label="${label}" style="display:flex;justify-content:center;align-items:center;gap:12px;margin:24px 0"><button class="ac-btn" data-route="${route}/${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button><span class="ac-summary">第 ${page} / ${pages} 页</span><button class="ac-btn" data-route="${route}/${page + 1}" ${page >= pages ? 'disabled' : ''}>下一页</button></nav>` : '';
const dayToday = () => { const en = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(new Date()); return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(en) + 1; };

class AnimeSpace {
  constructor() {
    this.active = false; this.standalone = document.body.hasAttribute('data-anime-standalone');
    this.catalog = new Map(); this.library = {}; this.writeQueues = new Map(); this.calendarDay = dayToday(); this.tab = 'recommend'; this.genre = '全部';
    this.viewVersion = 0; this.heroIndex = 0; this.commentSort = 'hot'; this.commentSpoilers = storage.get('ciacord_anime_spoilers', true);
    this.heroBackdrops = new Map();
    this.root = document.createElement('section'); this.root.id = 'anime-space'; this.root.hidden = true; this.root.setAttribute('aria-label', 'ciacord 看番空间');
    document.body.append(this.root); this.renderShell(); this.bind(); this.bindAccountAvatar();
    this.hideEpisodeSummary = bindEpisodeSummaries(this.root);
    // Chat updates the tab title on socket events; retain that title for return,
    // while the visible anime route owns the title in anime mode.
    this.titleObserver = new MutationObserver(() => {
      if (this.active && this.animeTitle && document.title !== this.animeTitle) {
        this.chatTitle = document.title; document.title = this.animeTitle;
      }
    });
    this.titleObserver.observe(document.querySelector('title'), { childList: true, subtree: true, characterData: true });
    document.addEventListener('click', e => {
      if (e.target.closest('#home-server')) { e.preventDefault(); e.stopImmediatePropagation(); this.open(); }
    }, true);
    const home = document.getElementById('home-server');
    const switcher = this.root.querySelector('.ac-logo');
    if (home) {
      home.setAttribute('role', 'button'); home.tabIndex = 0; home.title = '切换到看番空间'; home.setAttribute('aria-label', '切换到看番空间');
      home.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.open(); } });
      const syncAvatar = () => {
        switcher.className = home.className + ' ac-logo';
        switcher.replaceChildren(...Array.from(home.childNodes, node => node.cloneNode(true)));
      };
      syncAvatar();
      new MutationObserver(syncAvatar).observe(home, { attributes: true, childList: true, subtree: true });
    } else if (this.standalone) {
      fetch('/api/health').then(response => response.ok ? response.json() : null).then(branding => {
        if (!branding?.icon) return;
        const avatar = new Image();
        avatar.alt = '';
        avatar.src = branding.icon;
        return avatar.decode().then(() => switcher.querySelector('.server-icon-text').replaceWith(avatar));
      }).catch(() => { /* The server can still be reached through the default icon. */ });
    }
    switcher.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switcher.click(); }
    });
    window.addEventListener('hashchange', () => {
      if (location.hash.startsWith('#manga')) {
        this.player?.save(); this.lastHash = this.currentRoute ? '#anime/' + this.currentRoute : this.lastHash;
        this.active = false; this.root.hidden = true; document.body.classList.remove('anime-mode'); return;
      }
      if (location.hash.startsWith('#anime')) { if (!this.active) this.open(false); else this.renderRoute(); }
      else if (this.active && !this.standalone) this.close(false);
      else if (this.standalone) this.navigate('discover', true);
    });
    window.addEventListener('online', () => {
      if (token() && this.home) this.loadLibrary().then(()=>this.updateWatchFollow());
    });
    if ((this.standalone && !location.hash.startsWith('#manga')) || location.hash.startsWith('#anime')) this.open(false);
  }
  get userKey() {
    // Token payload is only a cache namespace; the server verifies authentication.
    try { return JSON.parse(atob(token().split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).id || 'guest'; } catch { return 'guest'; }
  }
  renderShell() {
    const nav = (route, name, symbol) => `<button data-route="${route}" data-nav="${route}">${icon(symbol)}<span>${name}</span></button>`;
    this.root.innerHTML = `<nav class="ac-rail" aria-label="快捷导航">
      <div class="server-icon home active ac-logo" data-action="chat" role="button" tabindex="0" title="切换到聊天" aria-label="切换到聊天"><span class="server-icon-text">⬡</span><span class="server-status-dot online"></span></div>
      <button class="ac-rail-btn ac-module active" data-route="discover" title="番剧" aria-label="番剧">${icon('play')}<span>番剧</span></button>
      <button class="ac-rail-btn ac-module" data-action="manga" title="漫画" aria-label="漫画">${icon('book')}<span>漫画</span></button>
      <button class="ac-rail-btn ac-rail-bottom" data-action="settings" title="看番设置" aria-label="看番设置">${icon('gear')}</button>
    </nav>
    <aside class="ac-sidebar" aria-label="看番导航">
      <div class="ac-brand"><strong>ciacord</strong>${icon('flower')}<small>看番空间</small></div>
      <nav class="ac-nav">${nav('discover', '发现', 'home')}${nav('calendar', '新番时间表', 'calendar')}${nav('library/doing', '我的追番', 'bookmark')}${nav('history', '观看历史', 'clock')}</nav>
      <div class="ac-nav-divider"></div><p class="ac-nav-caption">我的片单</p>
      <nav class="ac-nav">${nav('library/wish', '想看', 'heart')}${nav('library/doing', '在看', 'play')}${nav('library/done', '已看', 'check')}</nav>
      <div class="ac-mascot"><p aria-live="polite">今天也要<br>开心追番！♡</p>
        <button type="button" class="ac-mascot-hello" aria-label="和看番小伙伴打招呼"><span class="ac-mascot-art">
          <img src="${mascotImage}" alt="" loading="lazy">
        </span></button>
      </div>
      <button class="ac-sync" data-action="sync">${icon('cloud')}<span data-sync-label>本机追番记录</span><span class="ac-sync-dot">${icon('check')}</span></button>
    </aside>
    <main class="ac-main"><header class="ac-toolbar"><div class="ac-toolbar-title">发现${icon('star')}</div>
      <form class="ac-search" role="search">${icon('search')}<input name="q" type="search" maxlength="100" autocomplete="off" placeholder="搜索番剧、角色、标签" aria-label="搜索番剧"></form>
      <div class="ac-user-actions"><button class="ac-notice" data-action="notifications" aria-label="追番动态" title="追番动态">${icon('bell')}</button><button data-action="account" aria-label="账号"><img class="ac-avatar" src="${mascotImage}" alt=""></button></div>
    </header><div class="ac-page" aria-live="polite"></div></main>`;
    this.page = this.root.querySelector('.ac-page'); this.main = this.root.querySelector('.ac-main');
    this.bindMascot();
  }
  bindAccountAvatar() {
    const avatar = this.root.querySelector('[data-action=account] img');
    const fallback = mascotImage;
    const face = document.getElementById('user-bar-face');
    const refresh = () => {
      const cached = token() ? storage.get('haven_user', null)?.avatar : null;
      const source = face?.hasChildNodes() ? face.querySelector('img')?.getAttribute('src') : cached;
      avatar.src = typeof source === 'string' && source ? source : fallback;
    };
    avatar.addEventListener('error', () => {
      if (avatar.getAttribute('src') !== fallback) avatar.src = fallback;
    });
    if (face) new MutationObserver(refresh).observe(face, { attributes: true, childList: true, subtree: true, attributeFilter: ['src'] });
    refresh();
  }
  bindMascot() {
    const mascot = this.root.querySelector('.ac-mascot');
    const button = mascot.querySelector('button');
    const bubble = mascot.querySelector('p');
    const art = mascot.querySelector('.ac-mascot-art');
    const motion = matchMedia('(prefers-reduced-motion: no-preference) and (min-width: 761px)');
    const messages = ['嗨，欢迎回来！♡', '今天想看哪一部？✧', '一起开心追番吧！♡'];
    let greeting = 0;
    let bubbleTimer;
    let bounce;
    let actor;
    let loading = false;
    let visible = false;
    const observer = new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      mount();
    });
    const mount = async () => {
      if (actor || loading || !visible || !motion.matches) return;
      loading = true;
      try {
        const { createMascot } = await import('./mascot.js');
        actor = await createMascot(art);
        observer.disconnect();
      } catch {
        // Keep the character and its bubble usable if WebGL or an asset fails.
      } finally {
        loading = false;
      }
    };
    observer.observe(art);
    motion.addEventListener('change', () => {
      bounce?.cancel();
      mount();
    });
    button.addEventListener('click', () => {
      clearTimeout(bubbleTimer);
      bubble.textContent = messages[greeting++ % messages.length];
      mascot.classList.add('is-greeting');
      bounce?.cancel();
      if (motion.matches) {
        actor?.wave();
        bounce = art.animate([
          { scale: '1', translate: '0 0' },
          { scale: '1.04 .96', translate: '0 2px', offset: .16 },
          { scale: '.98 1.02', translate: '0 -9px', offset: .42 },
          { scale: '1.02 .98', translate: '0 1px', offset: .72 },
          { scale: '1', translate: '0 0' }
        ], { duration: 560, easing: 'cubic-bezier(.2,.65,.35,1)' });
      }
      bubbleTimer = setTimeout(() => {
        mascot.classList.remove('is-greeting');
        bubble.replaceChildren('今天也要', document.createElement('br'), '开心追番！♡');
      }, 3000);
    });
  }
  bind() {
    const motion = matchMedia('(prefers-reduced-motion: no-preference)');
    this.root.addEventListener('pointerup', e => {
      const button = e.target.closest('.ac-btn, .ac-rail-btn, .ac-tabs button, .ac-episode-grid button, .ac-logo');
      if (!button || button.disabled || !motion.matches) return;
      button.getAnimations().filter(a => a.id === 'ac-bounce').forEach(a => a.cancel());
      const bounce = button.animate([
        { scale: '.94', offset: 0 },
        { scale: '1.065', offset: .48 },
        { scale: '.986', offset: .76 },
        { scale: '1', offset: 1 },
      ], { duration: 320, easing: 'ease-out' });
      bounce.id = 'ac-bounce';
    });
    this.root.addEventListener('click', async e => {
      const button = e.target.closest('button,a,.ac-logo'); if (!button || button.disabled) return;
      if (button.dataset.route) { e.preventDefault(); this.navigate(button.dataset.route); }
      if (button.dataset.action) this.action(button.dataset.action, button);
      if (button.dataset.day) { this.calendarDay = Number(button.dataset.day); if (this.currentRoute === 'calendar') this.renderCalendar(); else this.updateSchedule(); }
      if (button.dataset.tab) { this.tab = button.dataset.tab; this.updateDiscover(); }
      if (button.dataset.genre) { this.genre = button.dataset.genre; this.updateSeason(); }
      if (button.dataset.hero !== undefined) { this.heroIndex = Number(button.dataset.hero); this.updateHero(); }
      if (button.dataset.follow) this.follow(Number(button.dataset.follow));
      if (button.dataset.commentSort) { this.commentSort = button.dataset.commentSort; this.loadComments(); }
      if (button.dataset.like) {
        if (!token()) return this.toast('登录后即可点赞');
        try { await write(`/comments/${button.dataset.like}/like`, {}); this.loadComments(); } catch (err) { this.toast(err.message); }
      }
      if (button.dataset.replyComment) {
        const comment = this.comments?.find(item => item.id === Number(button.dataset.replyComment));
        const input = this.page.querySelector('[data-form=comment] textarea');
        if (comment && input) {
          const mention = `@${comment.author} `;
          if (!input.value.startsWith(mention)) input.value = mention + input.value;
          input.scrollIntoView({ behavior: 'smooth', block: 'center' });
          input.focus({ preventScroll: true });
        }
      }
      if (button.dataset.reveal) {
        const comment = this.comments?.find(c => c.id === Number(button.dataset.reveal));
        if (comment) { const p = document.createElement('p'); p.textContent = comment.content; button.replaceWith(p); }
      }
    });
    this.root.querySelector('.ac-search').addEventListener('submit', e => {
      e.preventDefault(); const q = e.target.elements.q.value.trim(); if (q) this.navigate(`search/${encodeURIComponent(q)}`);
    });
    this.root.addEventListener('change', e => {
      if (e.target.dataset.status) this.saveLibrary(Number(e.target.dataset.status), { status: e.target.value });
      if (e.target.dataset.setting === 'autonext') {
        storage.set('ciacord_anime_autonext', e.target.checked);
        this.root.querySelectorAll('[data-setting=autonext]').forEach(x => { x.checked = e.target.checked; });
      }
      if (e.target.dataset.setting === 'spoilers') { this.commentSpoilers = e.target.checked; storage.set('ciacord_anime_spoilers', e.target.checked); this.renderComments(); }
    });
    this.root.addEventListener('submit', async e => {
      if (e.target.dataset.form !== 'comment') return;
      e.preventDefault();
      if (!token()) return this.toast('登录聊天账号后即可参与讨论');
      const content = e.target.elements.content.value.trim(); if (!content) return;
      const button = e.target.querySelector('button[type=submit]'); button.disabled = true;
      try {
        await write(`/subjects/${this.watchId}/comments/${this.watchEpisode}`, { content, spoiler: e.target.elements.spoiler.checked });
        e.target.reset(); this.loadComments(); this.toast('评论已发布');
      } catch (err) { this.toast(err.message); } finally { button.disabled = false; }
    });
  }
  async open(update = true) {
    if (!this.active) this.chatTitle = document.title;
    this.chatHash = !/^#(?:anime|manga)/.test(location.hash) ? location.hash : this.chatHash || '';
    this.active = true; this.root.hidden = false; document.body.classList.add('anime-mode');
    delete document.documentElement.dataset.initialView;
    if (this.animeTitle) document.title = this.animeTitle;
    // Returning from chat restores the same DOM/video instance without reload.
    if (update && this.lastHash && this.page.childElementCount && this.home) {
      history.pushState(null, '', this.lastHash); return;
    }
    if (update && !location.hash.startsWith('#anime')) { location.hash = this.lastHash || '#anime/discover'; return; }
    await this.renderRoute();
  }
  close(update = true) {
    this.hideEpisodeSummary();
    this.player?.save(); this.active = false; this.root.hidden = true; document.body.classList.remove('anime-mode');
    this.lastHash = location.hash;
    document.title = this.chatTitle || 'ciacord';
    if (this.standalone) { location.href = '/app'; return; }
    if (update) history.pushState(null, '', location.pathname + location.search + (this.chatHash || ''));
    document.getElementById('home-server')?.focus();
  }
  navigate(route, replace = false) {
    const hash = '#anime/' + route;
    if (replace) { history.replaceState(null, '', hash); this.renderRoute(); }
    else if (location.hash === hash) this.renderRoute(); else location.hash = hash;
  }
  async initData() {
    if (!this.dataPromise) this.dataPromise = (async () => {
      const [home] = await Promise.all([api('/home'), this.loadLibrary()]);
      this.home = home; home.featured.forEach(s => this.catalog.set(s.id, s));
      home.calendar.flatMap(d => d.items).forEach(s => { if (!this.catalog.has(s.id)) this.catalog.set(s.id, s); });
      return home;
    })().catch(e => { this.dataPromise = null; throw e; });
    return this.dataPromise;
  }
  async loadLibrary() {
    const local = storage.get(`ciacord_anime_library_${this.userKey}`, {});
    this.library = local && typeof local === 'object' && !Array.isArray(local) ? local : {};
    if (token()) {
      try {
        const data = await api('/library');
        const pending = Object.fromEntries(Object.entries(this.library).filter(([,row])=>row.pending));
        const remote = Object.fromEntries(data.items.map(row => [row.subject_id, row]));
        this.library = { ...remote };
        for (const [id, row] of Object.entries(pending)) {
          this.library[id] = row.pending === true ? row : { ...row, ...remote[id], ...row.pending, pending: row.pending };
        }
        this.synced = true;
        for (const [id, row] of Object.entries(this.library)) if (row.pending) {
          const saved = await write(`/library/${id}`, row.pending === true ? this.libraryFields(row) : row.pending, 'PUT');
          row.status = saved.status;
          delete row.pending;
        }
        this.persistLibrary();
      } catch { this.synced = false; }
    }
    this.updateSyncLabel();
  }
  libraryFields(v) { return Object.fromEntries(['status', 'episode', 'position', 'duration', 'watched'].filter(k => v[k] !== undefined).map(k => [k, v[k]])); }
  persistLibrary() { storage.set(`ciacord_anime_library_${this.userKey}`, this.library); }
  updateSyncLabel() {
    const el = this.root.querySelector('[data-sync-label]');
    if (el) el.textContent = token() ? this.synced ? '追番记录已同步' : '记录保存在本机' : '本机追番记录';
  }
  async saveLibrary(id, changes, quiet = false, keepalive = false) {
    const previousRow = this.library[id];
    const unsynced = previousRow?.pending === true ? this.libraryFields(previousRow) : previousRow?.pending;
    const pending = token() ? { ...unsynced, ...changes } : false;
    this.library[id] = { ...(previousRow || { subject_id: id, status: 'history', watched: [], episode: 0, position: 0, duration: 0 }), ...changes, pending, updated_at: Date.now() };
    const row = this.library[id];
    this.persistLibrary();
    if (token()) {
      const payload = JSON.stringify(pending);
      // Serialise progress and collection edits for the same show; a slow older
      // request must never overwrite a newer favourite/episode selection.
      const previous = this.writeQueues.get(id) || Promise.resolve();
      const request = previous.catch(()=>{}).then(()=>api(`/library/${id}`, { method:'PUT', body:payload, keepalive }));
      this.writeQueues.set(id,request);
      try {
        const saved = await request;
        if (this.library[id] === row) {
          row.status = saved.status;
          row.pending = false;
        }
        this.synced = !Object.values(this.library).some(r=>r.pending); this.persistLibrary();
      } catch (err) { this.synced = false; if (!quiet) this.toast('已保存到本机，联网后会重试同步'); }
      finally { if (this.writeQueues.get(id) === request) this.writeQueues.delete(id); }
    }
    this.updateSyncLabel();
    if (!quiet) { this.toast(token() && this.synced ? '追番记录已保存并同步' : '追番记录已保存到本机'); if (this.currentRoute.startsWith('library')) this.renderLibrary(this.currentRoute.split('/')[1]); }
    this.updateWatchFollow();
  }
  async follow(id) {
    const old = this.library[id];
    if (['doing', 'wish', 'done'].includes(old?.status)) {
      await this.saveLibrary(id, { status: 'history' });
      this.toast('已移出追番，观看历史仍保留');
    } else await this.saveLibrary(id, { status: 'doing' });
    this.updateHero();
    const button = this.page.querySelector('[data-detail-follow]');
    if (Number(button?.dataset.follow) === id) {
      const followed = ['doing', 'wish', 'done'].includes(this.library[id]?.status);
      button.innerHTML = icon(followed ? 'check' : 'heart') + (followed ? '追番中' : '加入追番');
    }
  }
  async getSubject(id) {
    if (this.catalog.has(id) && this.catalog.get(id).tags?.length) return this.catalog.get(id);
    const subject = await api(`/subjects/${id}`); this.catalog.set(id, subject); return subject;
  }
  async renderRoute() {
    this.stopBackdrops?.();
    this.stopBackdrops = null;
    this.hideEpisodeSummary();
    const version = ++this.viewVersion;
    const route = location.hash.replace(/^#anime\/?/, '') || 'discover';
    this.currentRoute = route; this.root.classList.toggle('ac-watching', route.startsWith('watch/'));
    this.root.classList.remove('ac-theatre');
    this.player?.destroy(); this.player = null;
    this.root.querySelector('.ac-notification')?.remove();
    this.main.scrollTop = 0;
    const section = route.split('/')[0];
    const label = { detail: '番剧详情', watch: 'ciacord', library: '我的追番', history: '观看历史', calendar: '新番时间表', search: '搜索', rankings: '动画热度榜' }[section] || '发现';
    this.root.querySelector('.ac-toolbar-title').innerHTML = `${esc(label)}${icon('star')}`;
    this.setTitle(`${label === 'ciacord' ? '追番播放' : label} · ciacord`);
    const activeRail = section === 'watch' ? 'library' : section === 'rankings' ? 'discover' : section;
    this.root.querySelectorAll('[data-nav]').forEach(el => { const active = el.dataset.nav === route || (route.startsWith('watch') && el.dataset.nav === 'library/doing'); el.classList.toggle('active', active); if (active) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current'); });
    this.root.querySelectorAll('[data-rail]').forEach(el => el.classList.toggle('active', el.dataset.rail === activeRail));
    this.page.innerHTML = '<div class="ac-loading" role="status"><span class="ac-spinner" aria-hidden="true"></span>正在加载…</div>';
    try {
      if (section === 'detail') {
        const id = Number(route.split('/')[1]);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('番剧不存在');
        const artwork = api(`/subjects/${id}/artwork`).catch(() => null);
        const [show, episodes] = await Promise.all([api(`/subjects/${id}/details`), api(`/subjects/${id}/episodes`), this.home ? null : this.loadLibrary()]);
        if (version !== this.viewVersion) return;
        this.catalog.set(id, show);
        this.detail = { id, episodes: episodes.items, special: false, expanded: false };
        this.page.innerHTML = detailMarkup(show, episodes.items, this.library[id], heading) + footer();
        this.setTitle(`${show.name} · ciacord`);
        const images = await artwork;
        if (!images || version !== this.viewVersion) return;
        this.page.querySelector('[data-detail-artwork]').innerHTML = artworkMarkup(images, heading);
        this.stopBackdrops = setupBackdrops(this.page.querySelector('.ac-detail-hero'), images.backdrops || []);
        return;
      }
      if (section === 'rankings') {
        const page = route.split('/')[1] || '1';
        const result = await api(`/rankings?${new URLSearchParams({ page })}`);
        if (version === this.viewVersion) this.renderRankings(result);
        return;
      }
      if (section === 'calendar') {
        const [days] = await Promise.all([api('/calendar'), this.loadLibrary()]);
        if (version !== this.viewVersion) return;
        this.home ||= { featured: [], calendar: [] };
        this.home.calendar = days;
        days.flatMap(day => day.items).forEach(show => this.catalog.set(show.id, show));
        this.renderCalendar();
        return;
      }
      await this.initData(); if (version !== this.viewVersion) return;
      if (route === 'discover') this.renderHome();
      else if (route.startsWith('watch/')) {
        const [, rawId, rawEp] = route.split('/'); const id = Number(rawId); const ep = Number(rawEp || 1);
        if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(ep) || ep <= 0) throw new Error('番剧或集数不存在');
        const [show, episodes] = await Promise.all([this.getSubject(id), api(`/subjects/${id}/episodes`)]);
        if (version !== this.viewVersion) return;
        this.renderWatch(show, ep, episodes.items);
      } else if (route === 'calendar') this.renderCalendar();
      else if (route.startsWith('search/')) {
        const [, encodedQuery, page = '1'] = route.split('/');
        const query = decodeURIComponent(encodedQuery);
        const result = await api(`/search?${new URLSearchParams({ q: query, page })}`); if (version !== this.viewVersion) return;
        result.items.forEach(s => this.catalog.set(s.id, s));
        this.renderSearch(query, result);
      } else if (route.startsWith('library/') || route === 'history') {
        await Promise.allSettled(Object.keys(this.library).filter(id => !this.catalog.has(Number(id))).map(id => this.getSubject(Number(id))));
        if (version !== this.viewVersion) return;
        this.renderLibrary(route === 'history' ? 'history' : route.split('/')[1]);
      } else { this.navigate('discover', true); }
    } catch (err) {
      if (version !== this.viewVersion) return;
      this.page.innerHTML = `<div class="ac-error">${icon('flower')}<p>${esc(err.message)}</p><button class="ac-btn ac-btn-primary" data-action="retry">重新加载</button></div>`;
    }
  }
  thumb(s) {
    const thumbnails = { 400602: 'thumb-frieren', 395378: 'thumb-dungeon', 328609: 'thumb-guitar' };
    return thumbnails[s.id] ? `${REFERENCE_ASSETS}${thumbnails[s.id]}.webp` : s.image;
  }
  poster(s, seasonal = false, library = false, resume = false) {
    const record = this.library[s.id]; const ep = record?.episode || 1;
    return `<div class="ac-poster"><button data-route="${resume ? `watch/${s.id}/${ep}` : `detail/${s.id}`}" style="display:block;width:100%;padding:0;text-align:left" aria-label="${resume ? '继续观看' : '查看详情'} ${esc(s.name)}">
      <div class="ac-poster-art"><img src="${esc(s.image)}" alt="${esc(s.name)}" loading="lazy" referrerpolicy="no-referrer"><span class="ac-rating"><b>★</b>${s.score ? s.score.toFixed(1) : '暂无'}</span>${seasonal ? `<span class="ac-episode-tag">${s.episodes ? `共 ${s.episodes} 话` : '连载中'}</span>` : ''}</div>
      <span class="ac-card-title">${esc(s.name)}</span>${seasonal ? `<span class="ac-card-sub">${esc((s.tags || []).slice(0, 2).join(' / ') || s.date || '查看番剧')}</span>` : ''}</button>
      ${library ? `<div class="ac-library-status"><small class="ac-card-sub">${record?.episode ? `看到第 ${record.episode} 话` : '还未开始'}</small><select data-status="${s.id}" aria-label="${esc(s.name)} 收藏状态">${[['wish','想看'],['doing','在看'],['done','已看'],['history','仅历史']].map(([v,l]) => `<option value="${v}" ${record?.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''}
    </div>`;
  }
  landscape(s) {
    const row = this.library[s.id];
    const percent = row?.duration ? Math.min(100, row.position / row.duration * 100) : 0;
    const caption = row?.episode ? `第 ${String(row.episode).padStart(2, '0')} 话${row.duration > row.position ? ` · 剩余 ${Math.ceil((row.duration - row.position) / 60)} 分钟` : ' · 已看完'}` : '开始观看 · 开启新的故事';
    return `<button class="ac-landscape" data-route="watch/${s.id}/${row?.episode || 1}"><div class="ac-thumb"><img src="${esc(this.thumb(s))}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="ac-play-dot">${icon('play')}</span><span class="ac-card-progress"><i style="width:${percent}%"></i></span></div><span class="ac-card-title">${esc(s.name)}</span><span class="ac-card-sub">${caption}</span></button>`;
  }
  heroMarkup() {
    const list = this.home.featured.slice(0, 4); const s = list[this.heroIndex] || list[0];
    if (!s) return '';
    const followed = ['wish','doing'].includes(this.library[s.id]?.status);
    const backdrop = this.heroBackdrops.get(s.id);
    const fallback = s.id === featuredId ? heroImage : (s.largeImage || s.image);
    return `<img class="ac-hero-bg" src="${esc(typeof backdrop === 'string' ? backdrop : fallback)}" alt="${esc(s.name)}" fetchpriority="high" ${typeof backdrop === 'string' || s.id === featuredId ? '' : 'style="object-position:75% 30%"'}>
      <div class="ac-hero-copy"><span class="ac-eyebrow">${icon('flower')} 本日推荐 ✦</span><h1>${esc(s.name)}</h1>
      <div class="ac-hero-meta"><span class="ac-score-star">★</span><b>${s.score.toFixed(1)}</b><span>·</span><span>${esc((s.tags || []).filter(t => ['奇幻','冒险','治愈','日常','音乐','搞笑','科幻'].includes(t)).slice(0,2).join(' / ') || '精选番剧')}</span><span>·</span><span>${s.episodes ? `全 ${s.episodes} 话` : '连载中'}</span></div>
      <p class="ac-hero-desc">${s.id === featuredId ? '旅途结束之后，新的故事才刚刚开始。' : esc(s.summary.slice(0,90))}</p>
      <div class="ac-hero-buttons"><button class="ac-btn ac-btn-primary" data-route="detail/${s.id}">${icon('play')} 查看详情</button><button class="ac-btn" data-follow="${s.id}">${icon(followed ? 'check' : 'heart')}${followed ? '已加入追番' : '加入追番'}</button></div></div>
      <div class="ac-hero-dots" aria-label="推荐番剧">${list.map((x,i) => `<button class="${i === this.heroIndex ? 'active' : ''}" data-hero="${i}" aria-label="推荐：${esc(x.name)}" aria-pressed="${i === this.heroIndex}"></button>`).join('')}</div>`;
  }
  updateHero() { const el = this.page.querySelector('.ac-hero'); if (el) el.innerHTML = this.heroMarkup(); }
  loadHeroBackdrops() {
    const featured = this.home.featured.slice(0, 4);
    for (const show of featured) {
      if (this.heroBackdrops.has(show.id)) continue;
      this.heroBackdrops.set(show.id, null);
      void api(`/subjects/${show.id}/artwork`).then(async ({ backdrops }) => {
        if (!backdrops?.length) return;
        const image = new Image();
        image.src = backdrops[0];
        await image.decode();
        this.heroBackdrops.set(show.id, backdrops[0]);
        if ((featured[this.heroIndex] || featured[0])?.id !== show.id) return;
        const current = this.page.querySelector('.ac-hero .ac-hero-bg');
        if (!current) return;
        current.src = image.src;
        current.style.removeProperty('object-position');
      }).catch(() => this.heroBackdrops.delete(show.id));
    }
  }
  renderHome() {
    this.loadHeroBackdrops();
    const records = Object.values(this.library);
    const completedCount = records.reduce((total, item) => total + (item.watched?.length || 0), 0);
    const watchingCount = records.filter(item => item.status === 'doing').length;
    const viewing = Object.values(this.library).filter(s => s.episode > 0).sort((a,b) => b.updated_at - a.updated_at).map(s => this.catalog.get(s.subject_id)).filter(Boolean).slice(0,3);
    const continued = [...viewing, ...this.home.featured.filter(s=>!viewing.some(v=>v.id===s.id))].slice(0,3);
    this.page.innerHTML = `<section class="ac-hero" aria-label="推荐番剧">${this.heroMarkup()}</section>
      <div class="ac-home-grid"><div>
        <section class="ac-section">${heading(viewing.length ? '继续观看' : '从这里开始追番', 'star', more('history'))}<div class="ac-landscapes">${continued.map(s => this.landscape(s)).join('')}</div></section>
        <section class="ac-section ac-discover-section"></section>
        <section class="ac-section ac-season"></section>
        <section class="ac-feature"><img src="${REFERENCE_ASSETS}weekend.webp" alt="在樱花与书本旁休息的紫发少女" loading="lazy"><div class="ac-feature-copy"><h2>${icon('calendar')} 周末补番计划</h2><p>那些值得慢慢看的故事</p><button class="ac-btn" data-route="search/${encodeURIComponent('治愈')}">${icon('calendar')} 查看片单</button></div></section>
      </div><aside class="ac-home-aside"><section class="ac-panel ac-schedule-panel"></section><section class="ac-panel ac-home-progress">${this.progressSummary()}</section>
        <section class="ac-panel ac-home-ranks">${heading('人气精选', 'flame')}${this.home.featured.slice(0,5).map((s,i) => this.smallShow(s,i+1)).join('')}</section>
        <section class="ac-panel ac-note-panel">${heading('追番小记', 'star')}<div class="ac-note"><p>✓ 已看完 ${completedCount} 话，继续加油！♡</p><p>✓ 在看 ${watchingCount} 部番剧，慢慢看好故事。</p></div></section>
      </aside></div>
      <section class="ac-section">${heading('为你精选','star')}<div class="ac-collections">${[['日常治愈','治愈','在平凡的日子里，遇见温柔', 'cozy'],['奇幻冒险','奇幻','踏上未知的旅途，遇见更大的世界', 'fantasy'],['青春物语','青春','关于成长、友谊与怦然心动的瞬间', 'youth']].map(([title,tag,sub,art]) => `<button class="ac-collection" data-route="search/${encodeURIComponent(tag)}"><img src="${REFERENCE_ASSETS}collection-${art}.webp" alt="" loading="lazy"><span>${title} ♡<small>${sub}</small></span>${icon('next','ac-collection-arrow')}</button>`).join('')}</div></section>${footer()}`;
    this.updateDiscover(); this.updateSeason(); this.updateSchedule();
  }
  updateDiscover() {
    const el = this.page.querySelector('.ac-discover-section'); if (!el) return;
    const items = this.tab === 'recommend' && this.home.featured.length >= 9
      ? this.home.featured.slice(4) : [...this.home.featured];
    if (this.tab === 'score') items.sort((a,b) => b.score-a.score);
    const tabs = `<div class="ac-tabs">${[['recommend','推荐','star'],['hot','热门','flame'],['score','高分','bookmark']].map(([v,l,s]) => `<button data-tab="${v}" class="${this.tab === v ? 'active' : ''}">${icon(s)}${l}</button>`).join('')}</div>`;
    el.innerHTML = heading('发现好番','flower',tabs + more('rankings')) + `<div class="ac-posters">${items.slice(0,5).map(s => this.poster(s)).join('')}</div>`;
  }
  async updateSeason() {
    const el = this.page.querySelector('.ac-season'); if (!el) return;
    const selected = this.genre;
    let items = [...new Map(this.home.calendar.flatMap(d => d.items).map(s => [s.id,s])).values()].sort((a,b)=>b.popularity-a.popularity);
    const tags = ['全部','日常','奇幻','恋爱','科幻'];
    const tabs = `<div class="ac-tabs">${tags.map(t => `<button data-genre="${t}" class="${this.genre === t ? 'active' : ''}">${icon(t === '全部' ? 'grid' : t === '恋爱' ? 'heart' : 'star')}${t}</button>`).join('')}</div>`;
    const title = heading(this.genre === '全部' ? '本季放送' : `${this.genre}精选`,'calendar',tabs);
    if (selected !== '全部') {
      el.innerHTML = title + '<div class="ac-status">正在寻找这个分类的好故事…</div>';
      try {
        const data = await api(`/search?q=${encodeURIComponent(selected)}`);
        if (this.genre !== selected || !el.isConnected) return;
        items = data.items; items.forEach(s=>this.catalog.set(s.id,s));
      } catch {
        if (el.isConnected && this.genre === selected) el.innerHTML = title + '<p class="ac-status">分类暂时加载失败，请重新选择标签。</p>';
        return;
      }
    }
    el.innerHTML = title + (items.length ? `<div class="ac-posters">${items.slice(0,5).map(s => this.poster(s,true)).join('')}</div>` : '<p class="ac-status">这个分类暂时没有番剧，换个标签看看吧。</p>');
  }
  weekdayMarkup() { return `<div class="ac-weekdays">${['一','二','三','四','五','六','日'].map((n,i) => `<button data-day="${i+1}" class="${this.calendarDay === i+1 ? 'active' : ''}" aria-pressed="${this.calendarDay === i+1}">${n}</button>`).join('')}</div>`; }
  smallShow(s, rank) { return `<button class="ac-schedule-item" data-route="detail/${s.id}">${rank ? `<b class="ac-rank">${rank}</b>` : ''}<img src="${esc(s.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span><strong>${esc(s.name)}</strong><small>${rank ? `★ ${s.score ? s.score.toFixed(1) : '暂无评分'}` : `${s.date || '放送信息待定'}`}${s.episodes ? ` · 共 ${s.episodes} 话` : ''}</small></span></button>`; }
  updateSchedule() {
    const el = this.page.querySelector('.ac-schedule-panel'); if (!el) return;
    const items = this.home.calendar.find(d => d.weekday.id === this.calendarDay)?.items || [];
    el.innerHTML = heading(this.calendarDay === dayToday() ? '今日放送' : '每日放送','calendar') + this.weekdayMarkup() + (items.length ? items.slice(0,3).map(s => this.smallShow(s)).join('') + more('calendar','查看完整时间表') : '<p class="ac-status">这一天暂无放送信息</p>');
  }
  progressSummary() {
    const shows = Object.values(this.library).filter(s => s.status === 'doing');
    const ids = new Set(this.home.calendar.flatMap(day => day.items.map(s => s.id)));
    const airing = shows.filter(s => ids.has(s.subject_id)).length;
    return heading('我的追番','bookmark',more('library/doing',`在看 ${shows.length} 部`)) + `<div class="ac-summary">${icon('calendar')}${airing ? `本周放送表有 ${airing} 部在追番剧` : '喜欢的故事，都在这里等你继续。'}</div>`;
  }
  renderCalendar() {
    const items = this.home.calendar.find(d => d.weekday.id === this.calendarDay)?.items || [];
    this.page.innerHTML = `<section class="ac-calendar-page"><div class="ac-page-heading"><div><h1>新番时间表</h1><p>来自 Bangumi 的每日放送 · 每周都值得期待</p></div></div>${this.weekdayMarkup()}${items.length ? `<div class="ac-posters ac-library-grid">${items.map(s => this.poster(s,true)).join('')}</div>` : this.empty('今天暂时没有放送信息','去发现页找找喜欢的故事吧。')}</section>${footer()}`;
  }
  renderSearch(query, result) {
    this.root.querySelector('.ac-search input').value = query;
    const route = `search/${esc(encodeURIComponent(query))}`;
    this.page.innerHTML = `<section class="ac-search-results"><div class="ac-page-heading"><div><h1>“${esc(query)}” 的搜索结果</h1><p>${result.matchedBy === 'character' ? '按角色查找关联番剧 · ' : ''}找到 ${result.total} 部番剧</p></div></div>${result.items.length ? `<div class="ac-posters">${result.items.map(s => this.poster(s,true)).join('')}</div>` : this.empty('还没找到这个故事','试试番剧的中文名、原名或其他关键词。')}${pagination(route, '搜索结果分页', result)}</section>${footer()}`;
  }
  renderRankings(result) {
    this.page.innerHTML = `<section><div class="ac-page-heading"><div><h1>动画热度榜</h1><p>Bangumi · 榜单共 ${result.total} 部</p></div>${more('discover', '返回发现')}</div>
      <div class="ac-panel">${result.items.length ? result.items.map(s => this.smallShow(s,s.position)).join('') : '<p class="ac-status">本页暂无可显示的番剧</p>'}</div>
      ${pagination('rankings', '热度榜分页', result)}</section>${footer()}`;
  }
  empty(title, caption) { return `<div class="ac-empty"><img src="${mascotImage}" alt=""><h2>${esc(title)}</h2><p>${esc(caption)}</p><button class="ac-btn ac-btn-primary" data-route="discover">去发现好番</button></div>`; }
  renderLibrary(status = 'doing') {
    const names = { doing:'我的追番',wish:'想看的番剧',done:'看过的故事',history:'观看历史' };
    if (!names[status]) status = 'doing';
    const rows = Object.values(this.library).filter(v => status === 'history' ? v.episode > 0 : v.status === status).sort((a,b) => b.updated_at-a.updated_at);
    const items = rows.map(r => this.catalog.get(Number(r.subject_id))).filter(Boolean);
    this.page.innerHTML = `<section><div class="ac-page-heading"><div><h1>${names[status]}</h1><p>共 ${items.length} 部${token() ? ' · 与当前聊天账号同步' : ' · 已保存在此浏览器，登录后可同步'}</p></div></div><div class="ac-tabs" style="margin-bottom:24px">${[['doing','在看'],['wish','想看'],['done','已看'],['history','历史']].map(([v,l])=>`<button data-route="${v === 'history' ? 'history' : 'library/'+v}" class="${status === v ? 'active' : ''}">${l}</button>`).join('')}</div>${items.length ? `<div class="ac-posters ac-library-grid">${items.map(s => this.poster(s,true,true,status === 'history')).join('')}</div>` : this.empty('这里还没有故事','在发现页点击“加入追番”，喜欢的番剧就会出现在这里。')}</section>${footer()}`;
  }
  renderWatch(show, ep, episodes) {
    if (!episodes.some(e => e.sort === ep)) {
      if (episodes.length) { this.navigate(`watch/${show.id}/${episodes[0].sort}`, true); return; }
      throw new Error('这个番剧暂时没有公布正片集数');
    }
    this.watchId = show.id; this.watchEpisode = ep; this.watchShow = show; this.watchEpisodes = episodes;
    const episode = episodes.find(e => e.sort === ep); const next = episodes.find(e => e.sort > ep);
    const auto = storage.get('ciacord_anime_autonext',true);
    const toggle = () => `<label class="ac-toggle">自动连播<input type="checkbox" data-setting="autonext" ${auto ? 'checked' : ''}></label>`;
    this.page.innerHTML = `<div class="ac-watch-kicker">追番播放${icon('star')}</div><div class="ac-breadcrumb"><button data-route="discover">${icon('back')} 返回发现</button><span>/</span><span>${esc(show.name)}</span><span>/</span><span>第 ${String(ep).padStart(2,'0')} 话</span></div>
      <div class="ac-watch-layout"><div class="ac-watch-primary"><div class="ac-watch-heading"><div><h1>${icon('flower')}${esc(show.name)}</h1><p>第 ${String(ep).padStart(2,'0')} 话 · ${esc(episode.name)}</p></div><div><button class="ac-btn" data-follow="${show.id}" data-watch-follow></button>${token() ? '<button class="ac-btn" data-action="sync" title="同步追番记录" aria-label="同步追番记录">' + icon('cloud') + '</button>' : ''}<button class="ac-btn" data-action="share">${icon('share')} 分享</button></div></div>
      ${playerMarkup(show, ep, this.thumb(show))}
      <div class="ac-player-actions"><button class="ac-btn" ${episodes[0].sort === ep ? 'disabled' : ''} data-route="watch/${show.id}/${episodes.filter(e => e.sort < ep).at(-1)?.sort || ep}">${icon('back')} 上一话</button><button class="ac-btn" ${!next ? 'disabled' : ''} data-route="watch/${show.id}/${next?.sort || ep}">下一话 ${icon('skip')}</button>${toggle()}<span data-progress-caption>${icon('cloud')} ${token() ? '登录进度自动同步' : '进度自动保存在本机'}</span></div>
      <details class="ac-panel ac-source-panel">
        <summary class="ac-source-toggle">${icon('calendar')}<strong>播放线路</strong><span class="ac-summary" data-source-caption>自动选择</span>${icon('next')}</summary>
        <div class="ac-source-actions"><button class="ac-more" data-action="reload-sources">重新查找 ›</button></div>
        <div class="ac-source-options"><span class="ac-summary">正在查找可播放的线路…</span></div>
        <div class="ac-source-details"><label>${icon('cc')} 字幕<select data-track="subtitles" aria-label="字幕轨道" disabled><option>随片源</option></select></label><label>${icon('volume')} 音轨<select data-track="audio" aria-label="音轨选择" disabled><option>随片源</option></select></label></div>
      </details>
      <section class="ac-panel ac-synopsis"><img src="${esc(show.image)}" alt="${esc(show.name)}" referrerpolicy="no-referrer"><div><h2>${esc(show.name)}</h2><div class="ac-synopsis-meta"><b>★ ${show.score.toFixed(1)}</b>${show.tags.slice(0,3).map(t => `<span class="ac-tag">${esc(t)}</span>`).join('')}</div><div class="ac-summary">${icon('calendar')} ${esc(show.date?.slice(0,4))} · ${show.episodes ? `全 ${show.episodes} 话` : '连载中'}</div><p class="ac-synopsis-text">${esc(show.summary || '暂无简介')}</p><button class="ac-more" data-action="synopsis">展开简介⌄</button><div><a class="ac-more" href="https://bgm.tv/subject/${show.id}" target="_blank" rel="noopener noreferrer" style="margin-top:9px">${icon('link')} Bangumi（番组计划） ›</a></div></div></section>
      </div><aside class="ac-watch-aside"><section class="ac-panel ac-episodes">${heading('选集','flower')}<div class="ac-episode-head"><span>共 ${episodes.length} 话</span>${toggle()}</div><div class="ac-episode-tabs"><button class="active" data-action="main-episodes">正片</button><button data-action="special-episodes">特典</button></div><div class="ac-episode-grid">${episodeCards(show.id, episodes, false, ep)}</div><div class="ac-episode-caption"><strong>第 ${String(ep).padStart(2,'0')} 话 · ${esc(episode.name)}</strong><p>${esc(episode.airdate || '这一话的故事，等你开启。')}</p></div>${next ? `<button class="ac-next-preview" data-route="watch/${show.id}/${next.sort}"><img src="${esc(this.thumb(show))}" alt=""><span class="ac-play-dot">${icon('play')}</span><strong>下一话 · 第 ${String(next.sort).padStart(2,'0')} 话</strong><span class="ac-card-sub">${esc(next.name)}</span></button>` : ''}</section>
      <section class="ac-panel ac-watch-progress">${this.watchProgressMarkup(show)}</section><section class="ac-panel ac-recommend-panel">${heading('推荐番剧','star')}${this.home.featured.filter(s => s.id !== show.id).slice(1,4).map(s => this.smallShow(s)).join('')}</section></aside></div>
      <section class="ac-panel ac-comments">${heading('讨论','comment','<span class="ac-summary" data-comment-count></span>')}<div class="ac-comment-filters"><div class="ac-tabs"><button data-comment-sort="hot" class="active">${icon('flame')}热门</button><button data-comment-sort="latest">${icon('clock')}最新</button></div><label class="ac-toggle">${icon('eye')} 隐藏剧透<input type="checkbox" data-setting="spoilers" ${this.commentSpoilers ? 'checked' : ''}></label></div>
      <div class="ac-composer"><img class="ac-avatar" src="${mascotImage}" alt=""><form data-form="comment"><textarea name="content" maxlength="2000" required placeholder="分享这一话的感想吧…" aria-label="评论内容"></textarea><div class="ac-composer-footer"><span>请友善交流</span><label class="ac-toggle"><input type="checkbox" name="spoiler">包含剧透</label><button type="submit" class="ac-btn ac-btn-primary">发布</button></div></form></div><div class="ac-comment-list"><div class="ac-status">正在加载讨论…</div></div></section>
      <section class="ac-section ac-related">${heading('你可能还喜欢','star')}<div class="ac-posters">${this.home.featured.filter(s => s.id !== show.id).slice(0,5).map(s => this.poster(s,true)).join('')}</div></section>${footer()}`;
    this.updateWatchFollow(); this.loadComments();
    this.player = new AnimePlayer(this,show,ep,episodes);
    this.setTitle(`${show.name} · 第${ep}话 · ciacord`);
  }
  updateWatchFollow() {
    const el = this.page.querySelector('[data-watch-follow]');
    if (el) { const followed = ['doing','wish','done'].includes(this.library[this.watchId]?.status); el.innerHTML = icon(followed ? 'check' : 'heart') + (followed ? '追番中' : '加入追番'); }
    const panel = this.page.querySelector('.ac-watch-progress'); if (panel && this.watchShow) panel.innerHTML = this.watchProgressMarkup(this.watchShow);
    const caption = this.page.querySelector('[data-progress-caption]'); if (caption) caption.innerHTML = icon('cloud') + (token() && this.synced ? '观看进度已同步' : '进度保存在本机');
  }
  watchProgressMarkup(show) {
    const row = this.library[show.id]; const eps = row?.watched?.length || 0; const total = this.watchEpisodes?.length || show.episodes || 1;
    const percent = Math.min(100, Math.round(eps / total * 100));
    return heading('观看进度','bookmark')+`<div class="ac-summary">${row?.episode ? `已看到第 ${String(row.episode).padStart(2,'0')} 话` : '即将开启新的旅程'} / ${total} 话</div><div class="ac-progress-line"><div class="ac-progress-track" role="progressbar" aria-label="已看完的集数比例" aria-valuenow="${percent}"><i style="width:${percent}%"></i></div><span>${percent}%</span></div><div class="ac-progress-caption">${icon('check')}已看完 ${eps} 话${row?.status === 'doing' ? ' · 已加入在看' : ''}</div>`;
  }
  async loadComments() {
    const id = this.watchId; const ep = this.watchEpisode; const order = this.commentSort;
    try {
      const data = await api(`/subjects/${id}/comments/${ep}?sort=${order}`);
      if (this.watchId !== id || this.watchEpisode !== ep || this.commentSort !== order || !this.currentRoute.startsWith('watch/')) return;
      this.comments = data.items; this.renderComments();
    } catch {
      const list = this.page.querySelector('.ac-comment-list'); if (list) list.innerHTML = '<p class="ac-status">讨论暂时加载失败，请稍后重试。</p>';
    }
  }
  renderComments() {
    const list = this.page.querySelector('.ac-comment-list'); if (!list) return;
    this.root.querySelector('[data-comment-count]').textContent = `(${this.comments?.length || 0})`;
    this.root.querySelectorAll('[data-comment-sort]').forEach(el => el.classList.toggle('active',el.dataset.commentSort === this.commentSort));
    list.innerHTML = this.comments?.length ? this.comments.map(c => `<article class="ac-comment"><img class="ac-avatar" src="${mascotImage}" alt=""><div><div class="ac-comment-meta"><strong>${esc(c.author)}</strong><time datetime="${new Date(c.created_at).toISOString()}">${new Date(c.created_at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time>${c.spoiler ? '<small class="ac-tag">含剧透</small>' : ''}</div>${c.spoiler && this.commentSpoilers ? `<button class="ac-spoiler" data-reveal="${c.id}">${icon('eye')} 剧透内容，点击查看</button>` : `<p>${esc(c.content)}</p>`}<div class="ac-comment-actions"><button class="ac-comment-like ${c.liked ? 'liked' : ''}" data-like="${c.id}" aria-label="点赞 ${esc(c.author)} 的评论">${icon('thumb')} ${c.likes}</button><button class="ac-comment-reply" data-reply-comment="${c.id}">${icon('comment')} 回复</button></div></div></article>`).join('') : '<p class="ac-status">还没有人留下感想，来聊聊这一话吧 ♡</p>';
  }
  managePikPak({ connected, folder, folderId }) {
    this.dialog('PikPak 离线 BT', `
      <p>${connected ? `已连接${folder ? `，保存目录为 ${esc(folder)}` : ''}。` : '登录后，BT 线路会优先使用 PikPak 离线下载。'} 此账号供服务器上的已登录用户共用。</p>
      <form data-pikpak-form>
        <p><label>PikPak 账号 <input name="pikpakUser" autocomplete="username" maxlength="254" required></label></p>
        <p><label>PikPak 密码 <input name="pikpakPassword" type="password" autocomplete="current-password" maxlength="1024" required></label></p>
        <p><label>保存目录 ID <input name="pikpakFolder" value="${esc(folderId || '')}" maxlength="128" required></label></p>
        <p>在 PikPak 网页版打开保存目录，从「网络」里的文件列表请求复制 <code>parent_id</code>。</p>
        <button class="ac-btn ac-btn-primary" type="submit">${connected ? '重新连接' : '登录 PikPak'}</button>
        ${folder ? '<button class="ac-btn" type="button" data-pikpak-test>测试连接</button>' : ''}
        ${connected ? '<button class="ac-btn" type="button" data-pikpak-disconnect>断开连接</button>' : ''}
        <p role="status"></p>
      </form>`, []);
    const form = this.root.querySelector('[data-pikpak-form]');
    const status = form.querySelector('[role="status"]');
    const submit = async (method, button, body) => {
      const buttons = form.querySelectorAll('button');
      buttons.forEach(el => { el.disabled = true; });
      status.textContent = '正在连接 PikPak…';
      try {
        const result = await write(method === 'POST' ? '/pikpak/test' : '/pikpak', body, method);
        if (!form.isConnected) return;
        if (method === 'POST') status.textContent = 'PikPak 连接正常。';
        else {
          this.managePikPak(result);
          this.toast(method === 'PUT' ? 'PikPak 已连接' : 'PikPak 已断开');
        }
      } catch (error) {
        status.textContent = error.message;
      } finally {
        buttons.forEach(el => { el.disabled = false; });
        if (form.isConnected) button?.focus();
      }
    };
    form.onsubmit = event => {
      event.preventDefault();
      const { pikpakUser, pikpakPassword, pikpakFolder } = form.elements;
      const body = { username: pikpakUser.value.trim(), password: pikpakPassword.value, folderId: pikpakFolder.value.trim() };
      pikpakPassword.value = '';
      void submit('PUT', event.submitter, body);
    };
    const test = form.querySelector('[data-pikpak-test]');
    const disconnect = form.querySelector('[data-pikpak-disconnect]');
    if (test) test.onclick = () => submit('POST', test);
    if (disconnect) disconnect.onclick = () => submit('DELETE', disconnect);
  }
  async manageRssSources() {
    try {
      const { items } = await api('/sources');
      this.dialog('自定义 RSS 源', `<p>每行填写一个订阅地址，搜索词用 {keyword} 表示。最多 5 条。</p><textarea data-rss-sources aria-label="RSS 订阅地址" rows="6">${esc(items.map(source => source.arguments.searchConfig.searchUrl).join('\n'))}</textarea>`, [
        { label: '保存 RSS 源', action: async () => {
          const urls = this.root.querySelector('[data-rss-sources]').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
          try {
            const items = urls.map(searchUrl => ({
              factoryId: 'rss', arguments: { name: new URL(searchUrl).hostname, searchConfig: { searchUrl } }
            }));
            await write('/sources', { items }, 'PUT');
            this.toast('RSS 源已保存');
            this.player?.load();
          } catch (error) { this.toast(error.message); }
        } }
      ]);
    } catch (error) { this.toast(error.message); }
  }
  async action(action, button) {
    if (action === 'manga') { location.hash = '#manga/library'; return; }
    if (action === 'detail-posters') {
      const expanded = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(expanded));
      button.textContent = expanded ? '收起海报 ↑' : '查看全部 ›';
      this.page.querySelectorAll('[data-extra-poster]').forEach(poster => { poster.hidden = !expanded; });
      return;
    }
    if (action === 'detail-expand') {
      const detail = this.detail;
      detail.expanded = !detail.expanded;
      this.hideEpisodeSummary();
      button.closest('[data-detail-episodes]').innerHTML = detailEpisodeList(detail.id,
        detail.special ? detail.specials : detail.episodes, detail.special, detail.expanded, this.library[detail.id]?.episode);
      this.page.querySelector('[data-action=detail-expand]')?.focus({ preventScroll: true });
      return;
    }
    if (action === 'chat') this.close();
    if (action === 'detail-main' || action === 'detail-special') {
      const grid = this.page.querySelector('[data-detail-episodes]');
      if (!grid || !this.detail) return;
      this.hideEpisodeSummary();
      const detail = this.detail;
      const { id, episodes } = detail;
      const special = action === 'detail-special';
      detail.special = special;
      detail.expanded = false;
      for (const tab of grid.previousElementSibling.querySelectorAll('button')) {
        const selected = tab.dataset.action === action;
        tab.classList.toggle('active', selected);
        tab.setAttribute('aria-pressed', String(selected));
      }
      if (!special) {
        grid.innerHTML = detailEpisodeList(id, episodes, false, false, this.library[id]?.episode);
        return;
      }
      grid.textContent = '正在加载特别篇…';
      try {
        const result = await api(`/subjects/${id}/specials`);
        if (grid.isConnected && button.getAttribute('aria-pressed') === 'true') {
          detail.specials = result.items;
          grid.innerHTML = detailEpisodeList(id, result.items, true, false);
        }
      } catch {
        if (grid.isConnected && button.getAttribute('aria-pressed') === 'true') grid.textContent = '特别篇暂时无法加载，请重试。';
      }
      return;
    }
    if (action === 'retry') { this.dataPromise = null; this.renderRoute(); }
    if (action === 'reload-sources') this.player?.load();
    if (action === 'synopsis') { const text = this.page.querySelector('.ac-synopsis-text'); text.classList.toggle('expanded'); button.textContent = text.classList.contains('expanded') ? '收起简介⌃' : '展开简介⌄'; }
    if (action === 'share') {
      try { await navigator.clipboard.writeText(`${location.origin}/anime${location.hash}`); this.toast('播放页链接已复制'); }
      catch { this.toast('可复制地址栏链接分享这一话'); }
    }
    if (action === 'sync') {
      if (!token()) this.toast('目前记录保存在此浏览器；登录聊天账号后可同步');
      else {
        const subjectId = this.player?.show.id;
        const sync = async direction => {
          const accessToken = this.root.querySelector('[data-bangumi-token]').value.trim();
          if (!accessToken) return this.toast('请输入 Bangumi 访问令牌');
          try {
            await Promise.allSettled(this.writeQueues.values());
            const result = await write('/bangumi', { accessToken, direction, subjectId });
            await this.loadLibrary();
            this.updateWatchFollow();
            if (this.currentRoute?.startsWith('library')) this.renderLibrary(this.currentRoute.split('/')[1]);
            this.toast(direction === 'collections' ? `已导入 ${result.count} 部 Bangumi 收藏` : `已同步 ${result.count} 集`);
          } catch (error) { this.toast(error.message); }
        };
        this.dialog('同步追番记录', `<label>Bangumi 访问令牌 <input type="password" autocomplete="off" data-bangumi-token></label><p>令牌仅用于本次同步。可在 Bangumi 个人令牌页面创建。</p><a href="https://next.bgm.tv/demo/access-token" target="_blank" rel="noopener noreferrer">打开 Bangumi 令牌页面</a>`, [
          { label: '同步 Ciacord', action: async () => {
            await this.loadLibrary();
            this.toast(this.synced ? '追番记录已同步' : '暂时无法同步');
          } },
          { label: '导入 Bangumi 收藏', action: () => sync('collections') },
          ...(subjectId ? [
            { label: '导入本番已看集数', action: () => sync('pull') },
            { label: '上传本番收藏与进度', action: () => sync('push') }
          ] : [])
        ]);
      }
    }
    if (action === 'account') this.dialog('你的看番空间', `<p>${token() ? '你正在使用 ciacord 聊天账号。追番、历史、评论和弹幕与当前账号关联。' : '当前为访客浏览，追番进度保存在此浏览器。登录 ciacord 后即可同步记录、发送弹幕和参与讨论。'}</p>`, [{label:token() ? '返回聊天' : '前往登录',action:()=>this.close()}]);
    if (action === 'settings') {
      this.dialog('看番设置', `<p>属于你的舒适追番时光 ♡</p><label class="ac-toggle"><input type="checkbox" data-preference="autonext" ${storage.get('ciacord_anime_autonext',true) ? 'checked' : ''}>自动播放下一话</label><label class="ac-toggle"><input type="checkbox" data-preference="danmaku" ${storage.get('ciacord_anime_danmaku',true) ? 'checked' : ''}>显示弹幕</label><label class="ac-toggle"><input type="checkbox" data-preference="spoilers" ${storage.get('ciacord_anime_spoilers',true) ? 'checked' : ''}>默认折叠剧透评论</label><p style="margin-top:17px">番剧资料来自 Bangumi，网页播放源读取 Animeko 的公开订阅。播放线路的可用性由上游提供。</p><p><a href="https://github.com/open-ani/animeko" target="_blank" rel="noopener noreferrer">Animeko</a> · <a href="https://github.com/creamycake-anime/animeko-subs" target="_blank" rel="noopener noreferrer">数据源订阅</a></p>`, [{label:'保存设置',action:()=>{
        this.root.querySelectorAll('[data-preference]').forEach(el => storage.set('ciacord_anime_'+el.dataset.preference,el.checked));
        this.commentSpoilers = storage.get('ciacord_anime_spoilers',true); if (this.player) {
          this.player.layer.hidden = !storage.get('ciacord_anime_danmaku',true);
          this.root.querySelectorAll('[data-setting=autonext]').forEach(el=>{el.checked=storage.get('ciacord_anime_autonext',true)});
          const preferences = { danmaku: storage.get('ciacord_anime_danmaku', true), spoilers: this.commentSpoilers };
          for (const [name, checked] of Object.entries(preferences)) {
            this.root.querySelectorAll(`[data-setting=${name}]`).forEach(input => { input.checked = checked; });
          }
          this.renderComments();
        }
        this.toast('设置已保存');
      }}, { label: '离线缓存', action: () => { location.href = '/anime-offline/'; } },
      ...(token() ? [{ label: '管理 RSS 源', action: () => this.manageRssSources() }] : [])]);
      const dialog = this.root.querySelector('.ac-dialog');
      if (token()) {
        void api('/pikpak').then(state => {
          if (!state.canManage || !dialog.isConnected) return;
          const pikpak = document.createElement('button');
          pikpak.type = 'button';
          pikpak.className = 'ac-btn';
          pikpak.textContent = 'PikPak 离线 BT';
          pikpak.onclick = () => this.managePikPak(state);
          dialog.querySelector('.ac-dialog-actions').append(pikpak);
        }).catch(() => {});
      }
    }
    if (action === 'notifications') {
      const existing = this.root.querySelector('.ac-notification'); if (existing) return existing.remove();
      const panel = document.createElement('aside'); panel.className = 'ac-notification';
      const n = Object.values(this.library).filter(s => s.status === 'doing').length;
      panel.innerHTML = `<h3>追番动态 ✧</h3><p>${n ? `你正在追 ${n} 部番剧。打开时间表，看看今天有哪些故事更新。` : '还没有在追的番剧，先去发现页点亮一颗心吧。'}</p><button class="ac-btn" data-route="calendar">查看放送表</button>`;
      this.root.append(panel);
    }
    if (action === 'special-episodes') {
      const grid = this.page.querySelector('.ac-episode-grid'); if (!grid) return;
      const id = this.watchId;
      grid.innerHTML = '<p class="ac-summary">正在加载…</p>';
      this.root.querySelectorAll('.ac-episode-tabs button').forEach(el=>el.classList.toggle('active',el.dataset.action === action));
      try {
        const res = await api(`/subjects/${id}/specials`);
        if (this.watchId !== id || !grid.isConnected) return;
        grid.innerHTML = episodeCards(id, res.items, true);
      } catch { if (grid.isConnected) grid.innerHTML = '<p class="ac-summary">特典信息暂不可用，请切回正片重试。</p>'; }
    }
    if (action === 'main-episodes') {
      const grid = this.page.querySelector('.ac-episode-grid'); if (!grid) return;
      this.root.querySelectorAll('.ac-episode-tabs button').forEach(el=>el.classList.toggle('active',el.dataset.action === action));
      this.hideEpisodeSummary();
      grid.innerHTML = episodeCards(this.watchId, this.watchEpisodes, false, this.watchEpisode);
    }
  }
  dialog(title, html, actions) {
    this.root.querySelector('.ac-dialog')?.remove();
    const el = document.createElement('div'); el.className = 'ac-dialog'; el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true'); el.setAttribute('aria-label',title);
    el.innerHTML = `<div class="ac-dialog-box"><h2>${esc(title)}</h2>${html}<div class="ac-dialog-actions"><button class="ac-btn" data-close-dialog>关闭</button>${actions.map((a,i) => `<button class="ac-btn ac-btn-primary" data-dialog-action="${i}">${esc(a.label)}</button>`).join('')}</div></div>`;
    const previous = document.activeElement;
    const close = () => { el.remove(); previous?.focus(); };
    el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close-dialog]')) close(); const action = e.target.closest('[data-dialog-action]'); if (action) { actions[Number(action.dataset.dialogAction)].action(); close(); } });
    el.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Tab') {
        const focus = [...el.querySelectorAll('button,input,a')]; const first = focus[0], last = focus.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    this.root.append(el); el.querySelector('input,button')?.focus();
  }
  toast(message) {
    this.root.querySelector('.ac-toast')?.remove(); clearTimeout(this.toastTimer);
    const el = document.createElement('div'); el.className = 'ac-toast'; el.setAttribute('role','status'); el.textContent = message;
    this.root.append(el); this.toastTimer = setTimeout(()=>el.remove(),3500);
  }
  setTitle(title) { this.animeTitle = title; if (this.active) document.title = title; }
}

window.ciacordAnime = new AnimeSpace();
