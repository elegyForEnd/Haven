import { api, storage, token, imageUrl } from './api.js';
import { icon, esc } from './icons.js';
import { MangaReader } from './reader.js';

const asset = '/img/manga/';
const button = (action, label, symbol, cls = '') => `<button class="mg-btn ${cls}" data-action="${action}">${symbol ? icon(symbol) : ''}${label}</button>`;
const routeButton = (route, label, symbol, cls = '') => `<button class="mg-btn ${cls}" data-route="${esc(route)}">${symbol ? icon(symbol) : ''}${label}</button>`;
const statusNames = { ONGOING: '连载中', COMPLETED: '已完结', ON_HIATUS: '休刊中', PUBLISHING_FINISHED: '已完结', CANCELLED: '已停止' };
const empty = (title, text, action = routeButton('sources', '浏览书源', 'globe', 'primary')) => `<div class="mg-empty">${icon('book')}<h2>${esc(title)}</h2><p>${esc(text)}</p>${action}</div>`;

export class MangaSpace {
  constructor() {
    this.root = document.createElement('section'); this.root.id = 'manga-space'; this.root.hidden = true;
    this.root.setAttribute('aria-label', 'ciacord 漫画空间'); document.body.append(this.root);
    this.standalone = document.body.hasAttribute('data-manga-standalone');
    this.library = {}; this.catalog = new Map(); this.queues = new Map(); this.version = 0;
    this.filter = 'all'; this.sort = 'recent'; this.layout = storage.get('ciacord_manga_layout', 'grid'); this.chapterFilter = 'all';
    this.root.addEventListener('click', event => this.click(event));
    this.root.addEventListener('submit', event => this.submit(event));
    this.root.addEventListener('change', event => this.change(event));
    this.root.addEventListener('input', event => {
      if (event.target.matches('[data-extension-search]')) this.renderExtensionList(event.target.value);
    });
    this.root.addEventListener('error', event => {
      const image = event.target;
      if (image.matches?.('img[data-cover]')) { image.hidden = true; image.parentElement.classList.add('mg-cover-failed'); }
    }, true);
    window.addEventListener('hashchange', () => {
      if (location.hash.startsWith('#manga')) this.open();
      else this.hide();
    });
    window.addEventListener('pagehide', () => this.reader?.save());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.reader?.save(); });
    // A login/logout changes the namespace, never combine different users' shelves.
    window.addEventListener('storage', event => {
      if (event.key === 'haven_token' && this.active) this.renderRoute();
    });
    if (location.hash.startsWith('#manga') || this.standalone) {
      if (!location.hash.startsWith('#manga')) history.replaceState(null, '', '#manga/library');
      this.open();
    }
  }
  get userKey() {
    try { return String(JSON.parse(atob(token().split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).id || 'guest'); } catch { return 'guest'; }
  }
  get libraryKey() { return `ciacord_manga_library_${this.userKey}`; }
  async open() {
    if (!this.active) this.returnTitle = document.title;
    this.active = true; this.root.hidden = false; document.body.classList.add('manga-mode');
    delete document.documentElement.dataset.initialView;
    await this.renderRoute();
  }
  hide() {
    if (!this.active) return;
    this.reader?.destroy(); this.reader = null; this.version++;
    this.active = false; this.root.hidden = true; document.body.classList.remove('manga-mode');
    document.title = this.returnTitle || 'ciacord';
  }
  navigate(route) {
    const hash = '#manga/' + route;
    if (location.hash === hash) this.renderRoute(); else location.hash = hash;
  }
  async loadLibrary() {
    const local = storage.get(this.libraryKey, {});
    this.library = local && typeof local === 'object' && !Array.isArray(local) ? local : {};
    if (token()) {
      try {
        const result = await api('/library');
        // Retain a newer local pending write when temporarily offline.
        for (const item of result.items) if (!this.library[item.id] || item.updatedAt >= this.library[item.id].updatedAt) this.library[item.id] = item;
        storage.set(this.libraryKey, this.library);
      } catch { this.toast('暂时无法同步，正在显示本机书架'); }
    }
  }
  async save(id, patch) {
    const namespace = this.libraryKey, owner = this.userKey, auth = token();
    const manga = this.catalog.get(Number(id)) || this.library[id] || {};
    const previous = this.library[id] || {};
    const entry = { ...previous, id: Number(id), title: manga.title, author: manga.author, sourceId: String(manga.sourceId || ''), cover: imageUrl({ id }), ...patch, updatedAt: Date.now() };
    if (patch.chapterId) {
      entry.lastReadAt = Date.now();
      entry.progress = { ...previous.progress, [patch.chapterId]: { page: patch.page, pageCount: patch.pageCount, read: Boolean(patch.chapterRead || previous.progress?.[patch.chapterId]?.read || patch.page >= patch.pageCount - 1) } };
    }
    this.library[id] = entry; storage.set(namespace, this.library);
    if (!token()) return entry;
    const run = async () => {
      const saved = await api(`/library/${id}`, patch, 'PUT', auth);
      if (this.userKey === owner && this.library[id]?.updatedAt === entry.updatedAt) { this.library[id] = { ...entry, ...saved }; storage.set(namespace, this.library); }
      return saved;
    };
    const queued = (this.queues.get(id) || Promise.resolve()).catch(() => {}).then(run);
    this.queues.set(id, queued);
    try { return await queued; } catch { this.toast('已保存到本机，服务器同步暂时失败'); return entry; }
    finally { if (this.queues.get(id) === queued) this.queues.delete(id); }
  }
  rail() {
    return `<nav class="mg-rail" aria-label="空间切换"><button class="mg-logo" data-action="chat" title="返回聊天" aria-label="返回聊天">C<span>❧</span></button>
      <button data-action="anime">${icon('film')}<span>番剧</span></button><button class="active" data-route="library" aria-current="page">${icon('book')}<span>漫画</span></button>
      <button class="mg-rail-bottom" data-route="sources" aria-label="漫画设置">${icon('gear')}</button></nav>`;
  }
  shell(reader = false) {
    const nav = (route, text, symbol) => `<button data-route="${route}" class="${this.route === route ? 'active' : ''}">${icon(symbol)}${text}</button>`;
    this.root.classList.toggle('mg-reading', reader);
    this.root.innerHTML = this.rail() + (reader ? '<main class="mg-reader"></main>' : `<aside class="mg-sidebar"><div class="mg-brand">ciacord<small>— 漫画空间 —</small></div><nav>${nav('library', '我的书架', 'shelf')}${nav('updates', '最近更新', 'update')}${nav('history', '阅读历史', 'clock')}${nav('sources', '浏览书源', 'globe')}${nav('downloads', '下载管理', 'download')}</nav>
      <p class="mg-nav-caption">${icon('leaf')} 我的分类</p><nav>${nav('library', '全部漫画', 'grid')}${nav('library/reading', '正在阅读', 'book')}${nav('library/done', '已读完', 'check')}${nav('library/wish', '想读', 'heart')}</nav>
      <div class="mg-companion"><p>翻开下一页，遇见新故事。</p><img src="${asset}companion.png" alt="抱着漫画书的庭院小伙伴"></div><small class="mg-sync">${token() ? '☁ 账号书架 · 本机缓存' : '访客书架 · 保存在此浏览器'}</small></aside>
      <main class="mg-main"><header class="mg-toolbar"><strong>${this.route.startsWith('detail') ? '我的书架 / 漫画详情' : '我的书架'} ${icon('leaf')}</strong><form data-form="search" role="search">${icon('search')}<input name="q" type="search" placeholder="搜索漫画、作者或书源" aria-label="搜索漫画" maxlength="100"></form><button class="mg-avatar" data-action="account" aria-label="当前账号"><img src="${asset}companion.png" alt=""></button></header><div class="mg-page"></div></main>`);
    this.page = this.root.querySelector(reader ? '.mg-reader' : '.mg-page');
  }
  async renderRoute() {
    this.reader?.destroy(); this.reader = null;
    const version = ++this.version;
    this.route = location.hash.replace(/^#manga\/?/, '') || 'library';
    this.shell(this.route.startsWith('read/'));
    this.page.innerHTML = '<div class="mg-loading" role="status"><span></span>正在翻开故事…</div>';
    document.title = 'ciacord · 漫画空间';
    try {
      await this.loadLibrary();
      if (version !== this.version) return;
      const [route, id, chapter] = this.route.split('?')[0].split('/');
      if (route === 'detail') await this.renderDetail(Number(id), version);
      else if (route === 'read') {
        this.reader = new MangaReader(this, Number(id), Number(chapter));
        await this.reader.load();
      } else if (route === 'sources') await this.renderSources(version);
      else if (route === 'browse') await this.renderBrowse(id, version);
      else if (route === 'updates') await this.renderUpdates(version);
      else if (route === 'downloads') await this.renderDownloads(version);
      else this.renderLibrary(route === 'history' ? 'history' : id || 'all');
    } catch (error) {
      if (version !== this.version) return;
      this.page.innerHTML = empty('暂时没有翻开这一页', error.message, button('retry', '重新加载', 'update', 'primary') + routeButton('sources', '浏览书源', 'globe'));
    }
  }
  cover(manga) { return `<span class="mg-cover"><span class="mg-cover-placeholder">${icon('book')}</span><img data-cover src="${imageUrl(manga)}" alt="${esc(manga.title)}封面" loading="lazy"></span>`; }
  cards(items) {
    return `<div class="mg-cards ${this.layout === 'list' ? 'as-list' : ''}">${items.map(manga => {
      const state = this.library[manga.id] || {}, percent = state.pageCount ? Math.min(100, Math.round((state.page + 1) / state.pageCount * 100)) : 0;
      return `<button class="mg-manga-card" data-route="detail/${manga.id}">${this.cover(manga)}<div><strong>${esc(manga.title)}</strong><small>${esc(state.chapterName || manga.author || '打开查看章节')}</small>${state.pageCount ? `<progress value="${percent}" max="100" aria-label="本话阅读进度"></progress>` : ''}</div></button>`;
    }).join('')}</div>`;
  }
  renderLibrary(filter = 'all') {
    this.libraryFilter = filter;
    const all = Object.values(this.library);
    let items = all.filter(item => filter === 'history' ? item.lastReadAt : item.favorite && (filter === 'all' || item.status === filter));
    if (this.query) items = items.filter(item => item.title?.toLowerCase().includes(this.query.toLowerCase()));
    if (this.filter === 'unread') items = items.filter(item => !item.lastReadAt);
    else if (this.filter !== 'all') items = items.filter(item => item.status === this.filter);
    items.sort((a, b) => this.sort === 'title' ? a.title.localeCompare(b.title, 'zh') : (b.lastReadAt || b.updatedAt) - (a.lastReadAt || a.updatedAt));
    const continuing = all.filter(item => item.lastReadAt).sort((a, b) => b.lastReadAt - a.lastReadAt)[0];
    this.page.innerHTML = `<section class="mg-garden"><div class="mg-garden-copy"><span class="mg-eyebrow">${icon('leaf')} 薄荷庭院 · 阅读时光</span><h1>${continuing ? '故事，读到哪里了？' : '你的故事，从这一页开始'}</h1><p>把喜欢的漫画，收进自己的小小庭院。</p>${continuing ? `<strong>${esc(continuing.title)}</strong><small>${esc(continuing.chapterName)} · 第 ${(continuing.page || 0) + 1} 页</small>${routeButton(`read/${continuing.id}/${continuing.chapterId}`, '继续阅读', 'book', 'primary')}` : routeButton('sources', '发现喜欢的漫画', 'globe', 'primary')}</div></section>
      <div class="mg-section-head"><h2>${icon(filter === 'history' ? 'clock' : 'shelf')}${filter === 'history' ? '阅读历史' : '我的收藏'} <small>${items.length} 部</small></h2>${routeButton('sources', '添加漫画', 'plus')}</div>
      <div class="mg-filters"><div class="mg-tabs">${[['all', '全部'], ['reading', '阅读中'], ['unread', '未读'], ['done', '已读完']].map(([value, name]) => `<button data-filter="${value}" class="${this.filter === value ? 'active' : ''}">${name}</button>`).join('')}</div><select data-sort aria-label="排序"><option value="recent" ${this.sort === 'recent' ? 'selected' : ''}>最近阅读</option><option value="title" ${this.sort === 'title' ? 'selected' : ''}>名称排序</option></select><button class="mg-icon-btn" data-action="layout" aria-label="切换书架视图">${icon(this.layout === 'list' ? 'grid' : 'list')}</button></div>
      ${items.length ? this.cards(items) : empty(filter === 'history' ? '还没有阅读记录' : '书架里还没有故事', '前往浏览书源，找到漫画后加入书架。')}`;
  }
  async renderDetail(id, version) {
    const manga = await api(`/manga/${id}?refresh=0`);
    // Fetch metadata/chapters only if not initialized, avoiding an upstream crawl on every visit.
    const detail = manga.chapters?.nodes?.length ? manga : await api(`/manga/${id}`);
    if (version !== this.version) return;
    this.detail = detail; this.catalog.set(id, detail); this.chapters = detail.chapters?.nodes || [];
    const state = this.library[id] || {}, ascending = [...this.chapters].sort((a, b) => a.chapterNumber - b.chapterNumber || b.sourceOrder - a.sourceOrder);
    const start = this.chapters.find(item => item.id === state.chapterId) || ascending.find(item => item.chapterNumber >= 0) || ascending[0];
    this.continueChapter = start;
    document.title = `${detail.title} · ciacord`;
    this.page.innerHTML = `${routeButton('library', '返回书架', 'back', 'quiet')}<section class="mg-detail-header mg-panel">${this.cover(detail)}<div class="mg-detail-copy"><span class="mg-eyebrow">漫画详情 ${icon('leaf')}</span><h1>${esc(detail.title)}</h1><p class="mg-muted">${esc(detail.author || '作者未提供')}${detail.artist && detail.artist !== detail.author ? ' · 作画 ' + esc(detail.artist) : ''}</p><div class="mg-tags">${(detail.genre || []).slice(0, 8).map(name => `<span>${esc(name)}</span>`).join('')}<span class="solid">${esc(statusNames[detail.status] || '状态未知')}</span></div><p class="mg-synopsis">${esc(detail.description || '书源暂未提供简介。')}</p><div class="mg-actions">${start ? routeButton(`read/${id}/${start.id}`, state.chapterId ? '继续阅读' : '开始阅读', 'book', 'primary') : ''}${button('favorite', state.favorite ? '已加入书架' : '加入书架', state.favorite ? 'check' : 'plus')}${button('refresh-detail', '检查更新', 'update')}${state.bookmarkedChapter ? routeButton(`read/${id}/${state.bookmarkedChapter}?page=${state.bookmarkedPage || 0}`, '回到书签', 'heart') : ''}</div>${state.chapterId ? `<small class="mg-muted">上次读到 ${esc(state.chapterName)} · 第 ${(state.page || 0) + 1} 页</small>` : ''}</div><div class="mg-detail-stats"><span>总章节<strong>${this.chapters.length} 话</strong></span><span>已读<strong>${Object.values(state.progress || {}).filter(item => item.read).length} 话</strong></span><label>我的分类<select data-library-status><option value="reading" ${state.status === 'reading' ? 'selected' : ''}>正在阅读</option><option value="wish" ${state.status === 'wish' ? 'selected' : ''}>想读</option><option value="done" ${state.status === 'done' ? 'selected' : ''}>已读完</option></select></label></div></section>
      <div class="mg-detail-columns"><section class="mg-panel"><div class="mg-section-head"><h2>章节目录 <small>共 ${this.chapters.length} 话</small></h2>${button('download-selected', '批量下载', 'download')}</div><div class="mg-filters"><label><input type="checkbox" data-select-all aria-label="选择当前显示的所有章节"> 全选</label><div class="mg-tabs">${[['all', '全部'], ['unread', '未读'], ['downloaded', '已下载']].map(([value, name]) => `<button data-chapter-filter="${value}" class="${this.chapterFilter === value ? 'active' : ''}">${name}</button>`).join('')}</div><button class="mg-btn quiet" data-action="chapter-order">${this.ascending ? '正序 ↑' : '倒序 ↓'}</button></div><div class="mg-chapters"></div></section><aside><section class="mg-panel"><h3>${icon('book')} 阅读进度</h3><p>${state.chapterId ? esc(state.chapterName) : '还没有开始阅读'}</p><progress max="${state.pageCount || 1}" value="${state.pageCount ? (state.page || 0) + 1 : 0}"></progress><small>${state.pageCount ? `本话第 ${(state.page || 0) + 1} / ${state.pageCount} 页` : '翻开漫画，记录每一页'}</small></section><section class="mg-panel"><h3>${icon('globe')} 书源信息</h3><p data-source-name>图源 ID：${esc(detail.sourceId)}</p>${routeButton(`sources?search=${encodeURIComponent(detail.title)}`, '切换书源', 'globe')}<small>搜索同名作品后选择新图源</small></section><section class="mg-panel"><h3>${icon('leaf')} 我的笔记</h3><textarea data-notes maxlength="5000" rows="4" placeholder="记下喜欢的台词与瞬间…">${esc(state.notes || '')}</textarea>${button('save-notes', '保存笔记', 'check')}</section></aside></div>`;
    this.renderChapters();
    api('/sources').then(result => {
      if (this.version !== version) return;
      const source = result.items.find(item => String(item.id) === String(detail.sourceId));
      if (source) this.page.querySelector('[data-source-name]').textContent = source.name;
    }).catch(() => {});
  }
  renderChapters() {
    const state = this.library[this.detail.id] || {};
    let chapters = [...this.chapters].sort((a, b) => this.ascending ? a.chapterNumber - b.chapterNumber || b.sourceOrder - a.sourceOrder : b.chapterNumber - a.chapterNumber || a.sourceOrder - b.sourceOrder);
    if (this.chapterFilter === 'unread') chapters = chapters.filter(chapter => !state.progress?.[chapter.id]?.read);
    if (this.chapterFilter === 'downloaded') chapters = chapters.filter(chapter => chapter.isDownloaded);
    this.page.querySelector('.mg-chapters').innerHTML = chapters.length ? chapters.map(chapter => `<div class="mg-chapter ${state.chapterId === chapter.id ? 'current' : ''}"><input type="checkbox" value="${chapter.id}" data-chapter-select aria-label="选择${esc(chapter.name)}"><button data-route="read/${this.detail.id}/${chapter.id}"><span>${esc(chapter.name)}</span>${state.progress?.[chapter.id]?.read ? '<small>已读</small>' : ''}</button><time>${chapter.uploadDate ? new Date(Number(chapter.uploadDate) < 1e12 ? Number(chapter.uploadDate) * 1000 : Number(chapter.uploadDate)).toLocaleDateString('zh-CN') : ''}</time><small>${chapter.pageCount > 0 ? chapter.pageCount + ' 页' : ''}</small><button data-download="${chapter.id}" class="mg-icon-btn" aria-label="下载${esc(chapter.name)}">${icon(chapter.isDownloaded ? 'check' : 'download')}</button></div>`).join('') : '<p class="mg-muted mg-pad">此分类没有章节。</p>';
  }
  async renderSources(version) {
    const status = await api('/status');
    if (version !== this.version) return;
    this.canManage = status.canManage;
    this.page.innerHTML = `<div class="mg-section-head"><div><span class="mg-eyebrow">${icon('leaf')} 故事的入口</span><h1>浏览书源</h1><p class="mg-muted">从喜欢的图源发现漫画，也可以添加本地作品。</p></div>${status.canManage ? button('sync-repositories', '同步扩展仓库', 'update', 'primary') : ''}</div><section class="mg-panel mg-repositories"><h3>扩展仓库</h3><div>${status.repositories.map(repo => `<span title="${esc(repo.url)}">${icon('globe')}${esc(repo.name)}</span>`).join('')}</div><p data-repo-result class="mg-muted">${status.connected ? '引擎已连接 · 扩展按需安装' : '首次打开时会启动漫画引擎，请稍候。'}</p></section><div class="mg-section-head"><h2>已启用的图源</h2></div><div data-sources><div class="mg-loading">正在读取图源…</div></div><section class="mg-panel mg-extension-panel"><div class="mg-section-head"><h2>扩展管理</h2><input data-extension-search type="search" placeholder="筛选扩展名称或语言" aria-label="筛选扩展"></div><div class="mg-filters"><label><input type="checkbox" data-chinese-only checked> 中文优先</label><label><input type="checkbox" data-installed-only> 仅看已安装</label></div><div data-extensions></div></section>`;
    const result = await Promise.allSettled([api('/sources'), api('/extensions')]);
    if (version !== this.version) return;
    if (result[0].status === 'fulfilled') {
      this.sources = result[0].value.items;
      this.renderSourceItems();
    } else this.page.querySelector('[data-sources]').innerHTML = `<p class="mg-error">${esc(result[0].reason.message)}</p>`;
    if (result[1].status === 'fulfilled') { this.extensions = result[1].value.items; this.renderExtensionList(); }
    else this.page.querySelector('[data-extensions]').innerHTML = `<p class="mg-error">${esc(result[1].reason.message)}</p>`;
  }
  renderSourceItems() {
    const query = new URLSearchParams(this.route.split('?')[1]).get('search');
    const items = (this.sources || []).filter(source => this.allLanguages || source.lang.startsWith('zh') || ['all', 'localsourcelang'].includes(source.lang)).sort((a, b) => Number(b.lang.startsWith('zh')) - Number(a.lang.startsWith('zh')) || a.name.localeCompare(b.name, 'zh'));
    this.page.querySelector('[data-sources]').innerHTML = `<label class="mg-language-toggle"><input type="checkbox" data-all-languages ${this.allLanguages ? 'checked' : ''}> 显示所有语言</label><div class="mg-source-grid">${items.map(source => routeButton(`browse/${source.id}${query ? '?q=' + encodeURIComponent(query) : ''}`, `${esc(source.name === 'Local source' ? '本地书库' : source.name)} <small>${esc(source.lang === 'localsourcelang' ? '本地' : source.lang)}</small>`, 'globe', 'mg-source')).join('')}</div>`;
  }
  renderExtensionList(query = this.root.querySelector('[data-extension-search]')?.value || '') {
    const target = this.page.querySelector('[data-extensions]'); if (!target) return;
    const chinese = this.page.querySelector('[data-chinese-only]')?.checked;
    const installed = this.page.querySelector('[data-installed-only]')?.checked;
    const items = (this.extensions || []).filter(item => (!chinese || ['zh', 'zh-Hans', 'zh-Hant', 'all'].includes(item.lang)) && (!installed || item.isInstalled) && `${item.name} ${item.lang}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.isInstalled) - Number(a.isInstalled) || Number(b.lang.startsWith('zh')) - Number(a.lang.startsWith('zh')) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    target.innerHTML = `<p class="mg-muted">共 ${items.length} 个扩展${items.length > 100 ? ' · 当前显示前 100 个，请输入名称缩小范围' : ''}${this.canManage ? '' : ' · 安装扩展请联系服务器管理员'}</p>` + items.slice(0, 100).map(item => `<div class="mg-extension"><span class="mg-extension-icon">${icon('book')}</span><div><strong>${esc(item.name)}</strong><small>${esc(item.lang)} · v${esc(item.versionName)}${item.isNsfw ? ' · 成人内容标记' : ''}</small></div>${this.canManage ? `<button class="mg-btn ${item.isInstalled ? '' : 'primary'}" data-extension="${esc(item.pkgName)}" data-install-action="${item.isInstalled ? item.hasUpdate ? 'update' : 'uninstall' : 'install'}">${item.isInstalled ? item.hasUpdate ? '更新' : '卸载' : '安装'}</button>` : `<small>${item.isInstalled ? '已安装' : '未安装'}</small>`}</div>`).join('');
  }
  async renderBrowse(sourcePart, version) {
    const [source] = sourcePart.split('?');
    const params = new URLSearchParams(this.route.split('?')[1]);
    const q = params.get('q') || '', page = Math.max(1, Number(params.get('page')) || 1);
    this.browseSource = source; this.browseQuery = q;
    const [result, sources] = await Promise.all([api(`/browse/${source}?page=${page}&q=${encodeURIComponent(q)}${params.has('latest') ? '&latest=1' : ''}`), api('/sources')]);
    if (version !== this.version) return;
    result.mangas.forEach(item => this.catalog.set(item.id, item));
    const name = sources.items.find(item => String(item.id) === source)?.name || '浏览漫画';
    this.page.innerHTML = `${routeButton('sources', '返回书源', 'back', 'quiet')}<div class="mg-section-head"><div><span class="mg-eyebrow">${icon('globe')}${esc(name)}</span><h1>${q ? '搜索：' + esc(q) : '发现新的故事'}</h1></div><form data-form="source-search"><input name="q" value="${esc(q)}" maxlength="100" placeholder="搜索此图源" aria-label="搜索此图源"><button class="mg-btn primary">${icon('search')}搜索</button></form></div>${result.mangas.length ? this.cards(result.mangas) : empty('没有找到漫画', '试试其他关键词或切换图源。')}
      <div class="mg-pagination">${page > 1 ? routeButton(`browse/${source}?q=${encodeURIComponent(q)}&page=${page - 1}`, '上一页', 'back') : ''}<span>第 ${page} 页</span>${result.hasNextPage ? routeButton(`browse/${source}?q=${encodeURIComponent(q)}&page=${page + 1}`, '下一页', 'next') : ''}</div>`;
  }
  async renderUpdates(version) {
    const books = Object.values(this.library).filter(item => item.favorite);
    this.page.innerHTML = `<div class="mg-section-head"><h1>最近更新</h1>${button('check-updates', '检查书架更新', 'update', 'primary')}</div><p class="mg-muted">逐部检查收藏作品；更新速度取决于图源。</p><div data-updates>${books.length ? this.cards(books) : empty('还没有收藏作品', '先把喜欢的漫画加入书架。')}</div>`;
  }
  async checkUpdates() {
    const books = Object.values(this.library).filter(item => item.favorite);
    const version = this.version, updates = [];
    for (let i = 0; i < books.length; i += 2) {
      const batch = await Promise.allSettled(books.slice(i, i + 2).map(async book => {
        const data = await api(`/manga/${book.id}`); this.catalog.set(data.id, data);
        const chapters = data.chapters?.nodes || [];
        return { ...data, chapterCount: chapters.length, newest: chapters[0]?.name || '' };
      }));
      if (version !== this.version) return;
      batch.forEach((result, offset) => updates.push(result.status === 'fulfilled' ? result.value : { ...books[i + offset], error: result.reason.message }));
      this.page.querySelector('[data-updates]').innerHTML = updates.map(book => `<div class="mg-update-row">${routeButton(`detail/${book.id}`, esc(book.title), 'book')}<span>${book.error ? esc(book.error) : `${book.chapterCount} 话 · ${esc(book.newest)}`}</span></div>`).join('');
    }
    this.toast('书架更新检查完成');
  }
  async renderDownloads(version) {
    const books = Object.values(this.library).filter(item => item.favorite || item.chapterId || item.downloads?.length);
    const result = await Promise.allSettled(books.map(item => api(`/manga/${item.id}?refresh=0`)));
    if (version !== this.version) return;
    const items = result.flatMap(value => value.status === 'fulfilled' ? (value.value.chapters?.nodes || []).filter(chapter => chapter.isDownloaded || this.library[value.value.id]?.downloads?.includes(chapter.id)).map(chapter => ({ ...chapter, title: value.value.title })) : []);
    this.page.innerHTML = `<div class="mg-section-head"><h1>下载管理</h1>${button('retry', '刷新下载状态', 'update')}</div><p class="mg-muted">章节保存在服务器漫画引擎中。下载尚未完成时，可稍后刷新检查。</p>${items.length ? items.map(chapter => `<div class="mg-update-row">${routeButton(`read/${chapter.mangaId}/${chapter.id}`, `${esc(chapter.title)} · ${esc(chapter.name)}`, 'book')}<span>${icon(chapter.isDownloaded ? 'check' : 'download')}${chapter.isDownloaded ? '已下载' : '待完成 · 刷新检查'}</span></div>`).join('') : empty('还没有下载记录', '在漫画详情页选择章节并下载，稍后刷新查看。', routeButton('library', '返回书架', 'shelf'))}`;
  }
  async click(event) {
    const target = event.target.closest('button'); if (!target || target.disabled) return;
    if (target.dataset.route) { this.query = ''; this.navigate(target.dataset.route); return; }
    if (target.dataset.filter) { this.filter = target.dataset.filter; this.renderLibrary(this.libraryFilter); return; }
    if (target.dataset.chapterFilter) { this.chapterFilter = target.dataset.chapterFilter; this.page.querySelectorAll('[data-chapter-filter]').forEach(el => el.classList.toggle('active', el === target)); this.renderChapters(); return; }
    target.disabled = true;
    try {
      if (this.reader && target.dataset.reader) { await this.reader.action(target.dataset.reader); return; }
      if (target.dataset.extension) {
        await api(`/extensions/${encodeURIComponent(target.dataset.extension)}`, { action: target.dataset.installAction });
        this.toast('扩展已更新'); await this.renderRoute(); return;
      }
      if (target.dataset.download) { await this.download([Number(target.dataset.download)]); return; }
      switch (target.dataset.action) {
        case 'anime': if (window.ciacordAnime) location.hash = '#anime/discover'; else location.href = '/anime#anime/discover'; break;
        case 'chat': this.hide(); if (this.standalone || document.body.hasAttribute('data-anime-standalone')) location.href = '/app'; else location.hash = ''; break;
        case 'account': this.toast(token() ? '书架与当前 ciacord 账号关联' : '访客记录保存在本机；登录聊天账号后可同步'); break;
        case 'retry': await this.renderRoute(); break;
        case 'layout': this.layout = this.layout === 'grid' ? 'list' : 'grid'; storage.set('ciacord_manga_layout', this.layout); this.renderLibrary(this.libraryFilter); break;
        case 'favorite': await this.save(this.detail.id, { favorite: !this.library[this.detail.id]?.favorite, status: this.library[this.detail.id]?.status || 'reading' }); await this.renderRoute(); break;
        case 'save-notes': await this.save(this.detail.id, { notes: this.page.querySelector('[data-notes]').value }); this.toast('笔记已保存'); break;
        case 'refresh-detail': await api(`/manga/${this.detail.id}`); await this.renderRoute(); break;
        case 'chapter-order': this.ascending = !this.ascending; target.textContent = this.ascending ? '正序 ↑' : '倒序 ↓'; this.renderChapters(); break;
        case 'download-selected': await this.download([...this.page.querySelectorAll('[data-chapter-select]:checked')].map(input => Number(input.value))); break;
        case 'check-updates': await this.checkUpdates(); break;
        case 'sync-repositories': {
          const result = await api('/repositories/sync', {});
          await this.renderRoute();
          const text = result.items.map(repo => `${repo.name}：${repo.ok ? '已同步' : repo.error}`).join('；');
          const output = this.page.querySelector('[data-repo-result]'); if (output) output.textContent = text;
          break;
        }
      }
    } catch (error) { this.toast(error.message); } finally { target.disabled = false; }
  }
  async download(ids) {
    if (!ids.length) return this.toast('请先勾选要下载的章节');
    if (!token()) return this.toast('登录聊天账号后即可下载章节');
    await api('/downloads', { ids });
    if (this.detail) await this.save(this.detail.id, { downloads: [...new Set([...(this.library[this.detail.id]?.downloads || []), ...ids])] });
    this.toast(`已将 ${ids.length} 话加入下载队列`);
  }
  submit(event) {
    const type = event.target.dataset.form;
    if (!type) return;
    event.preventDefault(); const q = event.target.elements.q.value.trim();
    if (type === 'source-search') this.navigate(`browse/${this.browseSource}?q=${encodeURIComponent(q)}`);
    else if (type === 'search') {
      if (this.route.startsWith('browse/')) this.navigate(`browse/${this.browseSource}?q=${encodeURIComponent(q)}`);
      else this.navigate(`sources?search=${encodeURIComponent(q)}`);
    }
  }
  async change(event) {
    const input = event.target;
    if (input.matches('[data-sort]')) { this.sort = input.value; this.renderLibrary(this.libraryFilter); }
    if (input.matches('[data-chinese-only],[data-installed-only]')) this.renderExtensionList();
    if (input.matches('[data-all-languages]')) { this.allLanguages = input.checked; this.renderSourceItems(); }
    if (input.matches('[data-select-all]')) this.page.querySelectorAll('[data-chapter-select]').forEach(box => { box.checked = input.checked; });
    if (input.matches('[data-library-status]')) { await this.save(this.detail.id, { status: input.value, favorite: true }); this.toast('分类已保存'); }
    if (input.dataset.readerSetting) this.reader?.setting(input.dataset.readerSetting, input.type === 'checkbox' ? input.checked : input.value);
  }
  toast(message) {
    this.root.querySelector('.mg-toast')?.remove(); clearTimeout(this.toastTimer);
    const element = document.createElement('div'); element.className = 'mg-toast'; element.setAttribute('role', 'status'); element.textContent = message;
    this.root.append(element); this.toastTimer = setTimeout(() => element.remove(), 5000);
  }
}
window.ciacordManga = new MangaSpace();
