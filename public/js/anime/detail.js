import { icon, escape as esc } from './icons.js';

const infoRow = (key, value) => value ? `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>` : '';
const placeholder = '/img/anime/cover-placeholder.svg';
const image = (src, alt = '') => `<img src="${esc(src || placeholder)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer">`;

export function setupBackdrops(hero, urls) {
  if (!urls.length) return;
  const backdrop = hero.previousElementSibling;
  const layers = backdrop.querySelectorAll('img');
  layers[0].src = urls[0];
  layers[0].classList.add('active');
  if (urls.length < 2) return;
  const picker = document.createElement('div');
  picker.className = 'ac-hero-dots';
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', '选择横幅');
  const buttons = urls.map((_, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', `第 ${index + 1} 张横幅`);
    button.setAttribute('aria-pressed', String(index === 0));
    button.classList.toggle('active', index === 0);
    button.addEventListener('click', () => { schedule(); void select(index); });
    picker.append(button);
    return button;
  });
  hero.append(picker);
  let current = 0;
  let front = 0;
  let request = 0;
  let timer;
  async function select(index) {
    const version = ++request;
    if (index === current) return;
    const next = layers[1 - front];
    next.src = urls[index];
    try { await next.decode(); } catch { return; }
    if (version !== request || !hero.isConnected) return;
    next.classList.add('active');
    layers[front].classList.remove('active');
    front = 1 - front;
    current = index;
    buttons.forEach((dot, position) => {
      dot.classList.toggle('active', position === index);
      dot.setAttribute('aria-pressed', String(position === index));
    });
  }
  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (!document.hidden && !hero.closest('[hidden]')) void select((current + 1) % urls.length);
    }, 30000);
  }
  schedule();
  return () => { clearInterval(timer); request++; };
}

export function episodeCards(id, episodes, special = false, activeEpisode = null) {
  if (!episodes.length) return '<p class="ac-summary">暂无集数资料</p>';
  return episodes.map(episode => {
    const number = String(episode.sort).padStart(2, '0');
    const name = episode.name || (special ? '特别篇' : '未命名');
    const attrs = `data-episode-summary="${esc(episode.description?.trim() || 'Bangumi 暂无这一集的简介。')}"`;
    const body = `<b>${esc(number)}</b><span>${esc(name)}</span>`;
    return special
      ? `<a class="ac-detail-episode" ${attrs} href="https://bgm.tv/ep/${Number(episode.id)}" target="_blank" rel="noopener noreferrer">${body}</a>`
      : `<button class="ac-detail-episode" ${attrs} data-route="watch/${id}/${episode.sort}" ${episode.sort === activeEpisode ? 'aria-current="true"' : ''}>${body}</button>`;
  }).join('');
}

export function bindEpisodeSummaries(root) {
  const tooltip = document.createElement('div');
  tooltip.className = 'ac-episode-tooltip';
  tooltip.id = 'ac-episode-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  root.append(tooltip);
  let trigger, timer;
  function hide() {
    clearTimeout(timer);
    trigger?.removeAttribute('aria-describedby');
    trigger = null;
    tooltip.hidden = true;
  }
  function show(event) {
    const card = event.target.closest('[data-episode-summary]');
    if (!card || card === trigger) return;
    hide();
    trigger = card;
    timer = setTimeout(() => {
      if (!card.isConnected || root.hidden) return;
      const box = card.getBoundingClientRect();
      const title = document.createElement('strong');
      title.textContent = `第 ${card.querySelector('b').textContent} 话 · ${card.querySelector('span').textContent}`;
      const summary = document.createElement('p');
      summary.textContent = card.dataset.episodeSummary;
      tooltip.replaceChildren(title, summary);
      tooltip.hidden = false;
      card.setAttribute('aria-describedby', tooltip.id);
      tooltip.style.left = Math.max(8, Math.min(box.left, root.clientWidth - tooltip.offsetWidth - 8)) + 'px';
      tooltip.style.top = (box.bottom + tooltip.offsetHeight + 8 < root.clientHeight
        ? box.bottom + 6 : Math.max(8, box.top - tooltip.offsetHeight - 6)) + 'px';
    }, 3000);
  }
  function leave(event) {
    if (trigger?.contains(event.target) && !trigger.contains(event.relatedTarget)) hide();
  }
  root.addEventListener('pointerover', show);
  root.addEventListener('pointerout', leave);
  root.addEventListener('focusin', show);
  root.addEventListener('focusout', leave);
  root.addEventListener('scroll', hide, true);
  root.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  return hide;
}

export function detailEpisodeList(id, episodes, special, expanded, current) {
  return `<div class="ac-detail-grid">${episodeCards(id, expanded ? episodes : episodes.slice(0, 12), special, current)}</div>
    ${episodes.length > 12 ? `<button class="ac-btn ac-detail-expand" data-action="detail-expand" aria-expanded="${expanded}">${expanded ? '收起选集 ↑' : `展开全部 ${episodes.length} 集 ↓`}</button>` : ''}`;
}

export function detailMarkup(show, episodes, record, heading) {
  const followed = ['doing', 'wish', 'done'].includes(record?.status);
  return `<article class="ac-detail">
    <div class="ac-detail-backdrop" aria-hidden="true"><div class="ac-detail-backdrop-frame"><img alt=""><img alt=""></div></div>
    <section class="ac-detail-hero">
      <button class="ac-back-link" data-route="discover">${icon('back')} 返回发现</button>
      ${image(show.largeImage, show.name)}
      <div><h1>${esc(show.name)}</h1>${show.originalName !== show.name ? `<p class="ac-detail-original">${esc(show.originalName)}</p>` : ''}
      <div class="ac-detail-meta">${show.score ? `<strong>★ ${show.score.toFixed(1)}</strong>` : ''}${show.date ? `<span>首播 ${esc(show.date)}</span>` : ''}${show.episodes ? `<span>全 ${show.episodes} 话</span>` : ''}</div>
      ${show.tags?.length ? `<div class="ac-detail-tags">${show.tags.slice(0, 6).map(tag => `<span class="ac-tag">${esc(tag)}</span>`).join('')}</div>` : ''}
      <button class="ac-btn" data-detail-follow data-follow="${show.id}">${icon(followed ? 'check' : 'heart')}${followed ? '追番中' : '加入追番'}</button></div>
    </section>
    <div class="ac-detail-info ac-panel">
      <section>${heading('剧情简介') }<p>${esc(show.summary || 'Bangumi 暂无剧情简介。')}</p></section>
      <section>${heading('制作信息', 'calendar')}<dl>${(show.info || []).map(field => infoRow(field.key, field.value)).join('')}${infoRow('首播', show.date)}${infoRow('类型', show.platform)}${infoRow('话数', show.episodes)}</dl>
      <a href="https://bgm.tv/subject/${show.id}" target="_blank" rel="noopener noreferrer">Bangumi 条目 ↗</a></section>
    </div>
    <section class="ac-panel ac-detail-episodes">${heading('选集')}
      <div class="ac-tabs" aria-label="集数分类"><button class="active" aria-pressed="true" data-action="detail-main">正片</button><button aria-pressed="false" data-action="detail-special">特别篇</button></div>
      <div data-detail-episodes>${detailEpisodeList(show.id, episodes, false, false, record?.episode)}</div>
    </section>
    ${show.characters?.length ? `<section>${heading('角色与声优')}<div class="ac-detail-cast">${show.characters.map(character => `<a href="https://bgm.tv/character/${Number(character.id)}" target="_blank" rel="noopener noreferrer">${image(character.image)}<span><strong>${esc(character.name)}</strong><small>${esc(character.actors.slice(0, 2).join(' / ') || character.role || '')}</small></span></a>`).join('')}</div></section>` : ''}
    <div data-detail-artwork></div>
    ${show.related?.length ? `<section>${heading('关联作品')}<div class="ac-detail-gallery">${show.related.map(item => {
      const body = `${image(item.image, item.name)}<b class="ac-tag">${esc(item.relation || '')}</b><strong>${esc(item.name)}</strong>`;
      return item.type === 2 ? `<button data-route="detail/${item.id}">${body}</button>` : `<a href="https://bgm.tv/subject/${item.id}" target="_blank" rel="noopener noreferrer">${body}</a>`;
    }).join('')}</div></section>` : ''}
  </article>`;
}

export function artworkMarkup(artwork, heading) {
  if (!artwork.posters?.length) return '';
  return `<section>${heading('海报墙', 'flower', artwork.posters.length > 5 ? '<button class="ac-more" data-action="detail-posters" aria-expanded="false">查看全部 ›</button>' : '')}
    <div class="ac-detail-gallery">${artwork.posters.map((url, i) => `<a ${i >= 5 ? 'hidden data-extra-poster' : ''} href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="查看原尺寸海报">${image(url)}</a>`).join('')}</div>
    <p class="ac-summary"><a href="${esc(artwork.url)}" target="_blank" rel="noopener noreferrer">TMDB</a> · This product uses the TMDB API but is not endorsed or certified by TMDB.</p></section>`;
}
