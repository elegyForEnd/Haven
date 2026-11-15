'use strict';

const { setTimeout: delay } = require('node:timers/promises');

const DRIVE = 'https://api-drive.mypikpak.com/drive/v1';
const COMPLETE = 'PHASE_TYPE_COMPLETE';
const MAX_PENDING = 3;

function createPikPak({ token = process.env.ANIME_PIKPAK_TOKEN, folder = process.env.ANIME_PIKPAK_FOLDER_ID, request = fetch, drive } = {}) {
  if ((!token && !drive) || !folder) return null;
  const tasks = new Map();
  let pending = 0;

  async function api(path, signal, body) {
    if (drive) return drive(path, signal, body);
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    const response = await request(DRIVE + path, {
      headers, signal, redirect: 'error', method: body ? 'POST' : 'GET', body: body && JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`PikPak API HTTP ${response.status}`);
    const data = await response.json();
    if (data.error || data.error_code) throw new Error('PikPak 拒绝请求');
    return data;
  }

  async function ready(entry, signal) {
    const { hash } = entry;
    if (!/^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(hash)) throw new Error('无效的 BT 资源');
    let task = tasks.get(hash);
    if (!task || (!task.wait && task.expires <= Date.now())) {
      if (tasks.size >= 256) {
        const removable = [...tasks].find(([, item]) => !item.wait && item.expires <= Date.now());
        if (!removable) throw new Error('PikPak 任务记录已满');
        tasks.delete(removable[0]);
      }
      task = { expires: Date.now() + 60_000 };
      tasks.set(hash, task);
    }
    if (task.fileId) return task.fileId;
    if (task.failed) throw new Error('PikPak 离线任务暂不可用');
    if (!task.wait) {
      if (pending >= MAX_PENDING) throw new Error('PikPak 等待队列繁忙');
      pending++;
      task.wait = (async () => {
        if (!task.id) {
          const result = await api('/files', signal, {
            kind: 'drive#file', upload_type: 'UPLOAD_TYPE_URL', parent_id: folder,
            url: { url: `magnet:?xt=urn:btih:${hash}` }
          });
          task.id = result.task?.id;
          task.fileId = result.file?.id || (result.task?.phase === COMPLETE && result.task.file_id);
          if (!task.id && !task.fileId) throw new Error('PikPak 未返回任务');
        }
        while (!task.fileId) {
          const state = await api('/tasks/' + encodeURIComponent(task.id), signal);
          if (state.phase === COMPLETE && state.file_id) task.fileId = state.file_id;
          else if (state.phase === 'PHASE_TYPE_ERROR') throw new Error('PikPak 离线下载失败');
          else await delay(1500, undefined, { signal });
        }
        return task.fileId;
      })().catch(error => {
        task.failed = !signal.aborted || !task.id;
        throw error;
      }).finally(() => {
        task.wait = null;
        task.expires = Date.now() + (task.id || task.fileId ? 2 * 3600_000 : 60_000);
        pending--;
      });
    }
    return task.wait;
  }

  async function video(entry, selectVideo) {
    const signal = AbortSignal.timeout(15_000);
    const fileId = await ready(entry, signal);
    const detail = id => api('/files/' + encodeURIComponent(id) + '?usage=FETCH', signal);
    let file = await detail(fileId);
    if (file.kind === 'drive#folder') {
      const files = [];
      const pages = [{ parentId: fileId }];
      while (pages.length && files.length < 1000) {
        const { parentId, pageToken } = pages.shift();
        const params = new URLSearchParams({ parent_id: parentId, limit: '100', with_audit: 'false', filters: '{"trashed":{"eq":false}}' });
        if (pageToken) params.set('page_token', pageToken);
        const page = await api('/files?' + params, signal);
        for (const child of page.files || []) {
          if (child.kind === 'drive#folder' && child.id) pages.push({ parentId: child.id });
          else files.push(child);
        }
        if (page.next_page_token) pages.push({ parentId, pageToken: page.next_page_token });
      }
      if (pages.length) return null;
      const selected = selectVideo(files, entry.episode);
      if (!selected?.id) return null;
      file = await detail(selected.id);
    }
    if (!selectVideo([file], entry.episode)) return null;
    const href = file.links?.['application/octet-stream']?.url || file.web_content_link;
    if (!href) return null;
    const url = new URL(href);
    return url.protocol === 'https:' && !url.username && !url.password ? { url: url.href, name: file.name } : null;
  }

  return { video };
}

module.exports = { createPikPak };
