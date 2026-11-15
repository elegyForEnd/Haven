import { api, storage } from './api.js';
import { icon, esc } from './icons.js';

export class MangaReader {
  constructor(space, mangaId, chapterId) {
    this.space = space; this.root = space.page; this.mangaId = mangaId; this.chapterId = chapterId;
    this.alive = true; this.page = 0; this.panel = ''; this.loaded = new Set();
    this.prefsKey = `ciacord_manga_reader_${space.userKey}`;
    this.prefs = { mode: innerWidth > 1100 ? 'double' : 'single', direction: 'rtl', fit: 'height', background: 'white', gap: 8, auto: false, ...storage.get(this.prefsKey, {}) };
    this.onKey = event => {
      if (!this.alive || !this.space.active || event.altKey || event.ctrlKey || event.metaKey || /INPUT|TEXTAREA|SELECT|BUTTON/.test(event.target.tagName)) return;
      if (event.key === 'Escape') { this.panel = ''; this.root.classList.remove('mg-immersive'); this.renderPanel(); return; }
      const forward = this.prefs.direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const backward = this.prefs.direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
      if ([forward, backward, ' ', 'PageDown', 'PageUp'].includes(event.key)) {
        event.preventDefault(); this.turn(event.key === backward || event.key === 'PageUp' ? -1 : 1);
      }
    };
    document.addEventListener('keydown', this.onKey);
  }
  async load() {
    const [manga, result] = await Promise.all([api(`/manga/${this.mangaId}?refresh=0`), api(`/chapters/${this.chapterId}/pages`)]);
    if (!this.alive) return;
    if (Number(result.chapter.mangaId) !== this.mangaId) throw new Error('章节不属于此漫画');
    this.manga = manga; this.chapter = result.chapter; this.pages = result.pages;
    this.space.catalog.set(manga.id, manga);
    this.chapters = [...(manga.chapters?.nodes || [])].sort((a, b) => a.chapterNumber - b.chapterNumber || b.sourceOrder - a.sourceOrder);
    const state = this.space.library[this.mangaId];
    const progress = state?.progress?.[this.chapterId];
    const requestedPage = new URLSearchParams(this.space.route.split('?')[1]).get('page');
    this.page = Math.max(0, Math.min(this.pages.length - 1, requestedPage !== null && /^\d+$/.test(requestedPage) ? Number(requestedPage) : progress?.page ?? (state?.chapterId === this.chapterId ? state.page : 0) ?? 0));
    document.title = `${manga.title} · ${this.chapter.name} · ciacord`;
    this.root.innerHTML = `<header class="mg-reader-toolbar"><button data-route="detail/${manga.id}">${icon('back')}<span>返回详情</span></button><div><strong>${esc(manga.title)}</strong><small>${esc(this.chapter.name)}</small></div><nav><button data-reader="chapters" aria-label="章节目录">${icon('list')}<span>目录</span></button><button data-reader="bookmark" aria-label="收藏本页">${icon('heart')}</button><button data-reader="settings" aria-label="阅读设置">${icon('gear')}</button><button data-reader="fullscreen" aria-label="全屏">${icon('full')}</button></nav></header>
      <div class="mg-reader-modes">${this.modeButtons()}<span class="mg-reader-hint">${this.prefs.direction === 'rtl' ? '从右向左' : '从左向右'} · 方向键翻页 · 点击空白收起工具栏</span></div>
      <div class="mg-reader-workspace"><div class="mg-reader-canvas" tabindex="0" aria-label="漫画阅读区域"><button class="mg-page-turn previous" data-reader="left" aria-label="向左翻页">${icon('back')}</button><div class="mg-pages"></div><button class="mg-page-turn next" data-reader="right" aria-label="向右翻页">${icon('next')}</button></div><aside class="mg-reader-panel" hidden></aside></div>
      <footer class="mg-reader-bottom"><button data-reader="previous-chapter">${icon('back')}<span>上一话</span></button><button data-reader="previous-page" aria-label="上一页">${icon('back')}</button><input type="range" min="0" max="${Math.max(0, this.pages.length - 1)}" value="${this.page}" data-reader-page aria-label="阅读页码"><output data-page-label></output><button data-reader="next-page" aria-label="下一页">${icon('next')}</button><button data-reader="next-chapter"><span>下一话</span>${icon('next')}</button><small data-save-label>阅读进度自动保存</small></footer><button class="mg-reveal" data-reader="controls">${icon('gear')}显示工具栏</button>`;
    this.root.querySelector('[data-reader-page]').addEventListener('input', event => this.go(Number(event.target.value)));
    this.root.querySelector('.mg-pages').addEventListener('load', event => {
      if (!event.target.matches('img[data-page]')) return;
      this.loaded.add(Number(event.target.dataset.page));
      if (Number(event.target.dataset.page) === this.page || (this.prefs.mode === 'double' && Number(event.target.dataset.page) === this.page + 1)) this.save();
    }, true);
    this.root.querySelector('.mg-pages').addEventListener('error', event => {
      if (!event.target.matches('img[data-page]')) return;
      const figure = event.target.parentElement;
      if (!figure.querySelector('button')) {
        const retry = document.createElement('button'); retry.className = 'mg-btn'; retry.textContent = '此页加载失败，点击重试';
        retry.onclick = () => { const img = figure.querySelector('img'); img.src = this.pages[Number(img.dataset.page)] + '?retry=' + Date.now(); retry.remove(); };
        figure.append(retry);
      }
    }, true);
    const canvas = this.root.querySelector('.mg-reader-canvas');
    canvas.addEventListener('click', event => {
      if (event.target === canvas || event.target === this.root.querySelector('.mg-pages')) this.root.classList.toggle('mg-immersive');
    });
    let touch;
    canvas.addEventListener('touchstart', event => { touch = { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY }; }, { passive: true });
    canvas.addEventListener('touchend', event => {
      if (!touch || this.prefs.mode === 'webtoon') return;
      const dx = event.changedTouches[0].clientX - touch.x, dy = event.changedTouches[0].clientY - touch.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) this.turn((dx > 0 ? -1 : 1) * (this.prefs.direction === 'rtl' ? -1 : 1));
      touch = null;
    }, { passive: true });
    this.renderPages(); this.auto();
  }
  modeButtons() {
    return `<div class="mg-tabs">${[['single', '单页'], ['double', '双页'], ['webtoon', '条漫']].map(([mode, title]) => `<button data-reader="mode-${mode}" class="${this.prefs.mode === mode ? 'active' : ''}">${title}</button>`).join('')}</div>`;
  }
  renderPages() {
    if (!this.alive) return;
    this.observer?.disconnect();
    const target = this.root.querySelector('.mg-pages');
    const webtoon = this.prefs.mode === 'webtoon';
    target.className = `mg-pages ${this.prefs.mode} fit-${this.prefs.fit} ${this.prefs.direction}`;
    target.style.setProperty('--page-gap', `${Math.max(0, Math.min(40, Number(this.prefs.gap) || 0))}px`);
    this.root.querySelector('.mg-reader-canvas').dataset.background = this.prefs.background;
    const indices = webtoon ? this.pages.map((_, index) => index) : this.prefs.mode === 'double' ? [this.page, this.page + 1].filter(index => index < this.pages.length) : [this.page];
    target.innerHTML = this.pages.length ? indices.map(index => `<figure><img data-page="${index}" src="${this.pages[index]}" alt="第 ${index + 1} 页" ${webtoon && Math.abs(index - this.page) > 2 ? 'loading="lazy"' : ''}><figcaption>${index + 1}</figcaption></figure>`).join('') : '<div class="mg-empty"><p>此章节没有可读取的页面。</p></div>';
    if (webtoon) {
      this.observer = new IntersectionObserver(entries => {
        const visible = entries.filter(entry => entry.isIntersecting && this.loaded.has(Number(entry.target.dataset.page))).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) { this.page = Number(visible.target.dataset.page); this.updateControls(); this.save(); }
      }, { root: this.root.querySelector('.mg-reader-canvas'), threshold: [0, .1, .25, .5, .75] });
      target.querySelectorAll('img').forEach(img => this.observer.observe(img));
      requestAnimationFrame(() => target.querySelector(`[data-page="${this.page}"]`)?.scrollIntoView({ block: 'start' }));
    }
    this.updateControls();
    const next = this.page + (this.prefs.mode === 'double' ? 2 : 1);
    if (!webtoon && this.pages[next]) { const preload = new Image(); preload.src = this.pages[next]; }
  }
  updateControls() {
    const label = this.root.querySelector('[data-page-label]'); if (!label) return;
    label.textContent = `${this.page + 1}${this.prefs.mode === 'double' && this.page + 1 < this.pages.length ? '–' + (this.page + 2) : ''} / ${this.pages.length} 页`;
    this.root.querySelector('[data-reader-page]').value = this.page;
    this.root.querySelector('[data-reader=previous-page]').disabled = this.page <= 0;
    this.root.querySelector('[data-reader=next-page]').disabled = this.page >= this.pages.length - 1;
    const index = this.chapters.findIndex(chapter => chapter.id === this.chapterId);
    this.root.querySelector('[data-reader=previous-chapter]').disabled = index <= 0;
    this.root.querySelector('[data-reader=next-chapter]').disabled = index < 0 || index >= this.chapters.length - 1;
  }
  go(page) {
    if (!this.pages?.length) return;
    this.page = Math.max(0, Math.min(this.pages.length - 1, page));
    if (this.prefs.mode === 'webtoon') this.root.querySelector(`[data-page="${this.page}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    else this.renderPages();
    if (this.loaded.has(this.page)) this.save();
  }
  turn(direction) {
    const step = this.prefs.mode === 'double' ? 2 : 1;
    if (this.page + direction * step >= this.pages.length) { this.space.toast('这一话读完了，可以切换到下一话'); return; }
    this.go(this.page + direction * step);
  }
  save() {
    if (!this.pages?.length || !this.loaded.has(this.page)) return;
    clearTimeout(this.saveTimer);
    const end = Math.min(this.pages.length - 1, this.page + (this.prefs.mode === 'double' ? 1 : 0));
    const patch = { chapterId: this.chapterId, chapterName: this.chapter?.name || '', page: this.page, pageCount: this.pages.length, chapterRead: end === this.pages.length - 1 && this.loaded.has(end) };
    this.space.save(this.mangaId, patch);
    const label = this.root.querySelector('[data-save-label]'); if (label) label.textContent = '✓ 进度已保存到本机';
  }
  renderPanel() {
    const panel = this.root.querySelector('.mg-reader-panel'); if (!panel) return;
    panel.hidden = !this.panel;
    if (!this.panel) return;
    if (this.panel === 'chapters') {
      panel.innerHTML = `<header><h3>章节目录</h3><button data-reader="close-panel" aria-label="关闭目录">${icon('close')}</button></header><div class="mg-reader-chapters">${this.chapters.map(chapter => `<button data-route="read/${this.mangaId}/${chapter.id}" class="${chapter.id === this.chapterId ? 'active' : ''}">${esc(chapter.name)}</button>`).join('')}</div>`;
      panel.querySelector('.active')?.scrollIntoView({ block: 'nearest' }); return;
    }
    const select = (key, entries) => `<select data-reader-setting="${key}">${entries.map(([value, label]) => `<option value="${value}" ${this.prefs[key] === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
    panel.innerHTML = `<header><h3>阅读设置</h3><button data-reader="close-panel" aria-label="关闭设置">${icon('close')}</button></header><label>阅读模式${select('mode', [['single', '单页'], ['double', '双页'], ['webtoon', '条漫']])}</label><label>阅读方向${select('direction', [['rtl', '从右向左'], ['ltr', '从左向右']])}</label><label>缩放方式${select('fit', [['height', '适应高度'], ['width', '适应宽度'], ['original', '原始大小']])}</label><label>背景颜色${select('background', [['white', '清透白'], ['cream', '奶油色'], ['gray', '浅灰色']])}</label><label>页间距<input type="range" min="0" max="40" value="${this.prefs.gap}" data-reader-setting="gap"></label><label class="mg-toggle">自动翻页（每 12 秒）<input type="checkbox" data-reader-setting="auto" ${this.prefs.auto ? 'checked' : ''}></label><button class="mg-btn" data-reader="controls">隐藏工具栏</button><p class="mg-muted">方向键翻页 · 空格下一页<br>Esc 显示工具栏</p>`;
  }
  setting(name, value) {
    const allowed = { mode: ['single', 'double', 'webtoon'], direction: ['rtl', 'ltr'], fit: ['height', 'width', 'original'], background: ['white', 'cream', 'gray'] };
    if (allowed[name] && !allowed[name].includes(value)) return;
    this.prefs[name] = name === 'gap' ? Math.max(0, Math.min(40, Number(value))) : value;
    storage.set(this.prefsKey, this.prefs);
    this.root.querySelector('.mg-reader-modes').innerHTML = this.modeButtons() + `<span class="mg-reader-hint">${this.prefs.direction === 'rtl' ? '从右向左' : '从左向右'} · 方向键翻页</span>`;
    this.renderPages(); this.renderPanel(); this.auto();
  }
  auto() {
    clearInterval(this.autoTimer);
    if (this.prefs.auto) this.autoTimer = setInterval(() => { if (this.alive && this.space.active && !document.hidden && !this.panel && this.loaded.has(this.page)) this.turn(1); }, 12000);
  }
  async action(action) {
    if (action.startsWith('mode-')) { this.setting('mode', action.slice(5)); return; }
    if (action === 'left') this.turn(this.prefs.direction === 'rtl' ? 1 : -1);
    if (action === 'right') this.turn(this.prefs.direction === 'rtl' ? -1 : 1);
    if (action === 'previous-page') this.turn(-1);
    if (action === 'next-page') this.turn(1);
    if (['settings', 'chapters', 'close-panel'].includes(action)) { this.panel = action === 'close-panel' || this.panel === action ? '' : action; this.renderPanel(); }
    if (action === 'controls') { this.panel = ''; this.renderPanel(); this.root.classList.toggle('mg-immersive'); }
    if (action === 'fullscreen') {
      try { if (document.fullscreenElement) await document.exitFullscreen(); else await this.space.root.requestFullscreen(); } catch { this.space.toast('当前窗口暂不支持全屏'); }
    }
    if (action === 'bookmark') { await this.space.save(this.mangaId, { bookmarkedChapter: this.chapterId, bookmarkedPage: this.page }); this.space.toast(`已收藏第 ${this.page + 1} 页`); }
    if (action === 'previous-chapter' || action === 'next-chapter') {
      const index = this.chapters.findIndex(chapter => chapter.id === this.chapterId);
      const chapter = this.chapters[index + (action === 'next-chapter' ? 1 : -1)];
      if (chapter) { this.save(); this.space.navigate(`read/${this.mangaId}/${chapter.id}`); }
    }
  }
  destroy() {
    if (!this.alive) return;
    this.save(); this.alive = false; this.observer?.disconnect();
    clearInterval(this.autoTimer); clearTimeout(this.saveTimer);
    document.removeEventListener('keydown', this.onKey);
  }
}
