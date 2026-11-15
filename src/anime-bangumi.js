'use strict';

const types = { wish: 1, done: 2, doing: 3 };
const statuses = { 1: 'wish', 2: 'done', 3: 'doing' };

function createBangumiSync(service, store, fetchImpl = fetch) {
  async function request(token, path, method = 'GET', body) {
    const response = await fetchImpl('https://api.bgm.tv/v0' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: {
        Authorization: 'Bearer ' + token,
        'User-Agent': 'Ciacord/1.0 (Anime Bangumi sync)',
        Accept: 'application/json',
        ...(body && { 'Content-Type': 'application/json' })
      },
      ...(body && { body: JSON.stringify(body) })
    });
    if (response.status === 401 || response.status === 403) {
      const error = new Error('Bangumi 访问令牌无效、过期或权限不足');
      error.status = 403;
      throw error;
    }
    if (!response.ok) throw new Error('Bangumi 请求失败 (' + response.status + ')');
    return response.status === 204 ? null : response.json();
  }

  async function pull(token, user) {
    const { username } = await request(token, '/me');
    if (!username) throw new Error('Bangumi account is missing a username');
    const rows = [];
    for (let offset = 0; offset < 20000;) {
      const page = await request(token, '/users/' + encodeURIComponent(username) +
        '/collections?subject_type=2&limit=50&offset=' + offset);
      if (!Array.isArray(page.data) || !Number.isSafeInteger(page.total)) throw new Error('Invalid Bangumi collections response');
      rows.push(...page.data);
      offset += page.data.length;
      if (!page.data.length || offset >= page.total) break;
    }
    const imports = rows.filter(row => statuses[row.type] && Number.isSafeInteger(row.subject_id));
    store.db.transaction(() => {
      for (const row of imports) store.save(user, row.subject_id, { status: statuses[row.type] });
    })();
    return { username, count: imports.length };
  }

  async function syncEpisode(token, user, id, direction) {
    const { items } = await service.episodes(id);
    const path = '/users/-/collections/' + id + '/episodes';
    if (direction === 'push') {
      const row = store.libraryItem(user, id);
      if (!row || !types[row.status]) return { count: 0 };
      const ids = items.filter(item => row.watched.includes(item.sort)).map(item => item.id);
      await request(token, '/users/-/collections/' + id, 'POST', { type: types[row.status] });
      if (ids.length) await request(token, path, 'PATCH', { episode_id: ids, type: 2 });
      return { count: ids.length };
    }
    const { data } = await request(token, path + '?episode_type=0&limit=1000');
    const watchedIds = new Set(data.filter(item => item.type === 2).map(item => item.episode.id));
    const remote = items.filter(item => watchedIds.has(item.id)).map(item => item.sort);
    const row = store.libraryItem(user, id);
    if (remote.length) store.save(user, id, { watched: [...new Set([...(row?.watched || []), ...remote])] });
    return { count: remote.length };
  }

  return { pull, syncEpisode };
}

module.exports = { createBangumiSync };
