import { storage, token } from '../anime/api.js';
export { storage, token };
export async function api(path, body, method = body === undefined ? 'GET' : 'POST', auth = token()) {
  const response = await fetch('/api/manga' + path, {
    method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || (response.status === 429 ? '操作有些频繁，请稍后重试' : '暂时无法加载，请重试'));
  return data;
}
export const imageUrl = manga => `/api/manga/image/${Number(manga.id)}`;
