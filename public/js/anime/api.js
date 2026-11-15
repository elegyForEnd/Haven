export function token() { try { return localStorage.getItem('haven_token') || ''; } catch { return ''; } }
export async function api(path, options = {}) {
  const auth = token();
  const response = await fetch(`/api/anime${path}`, { ...options,
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || (response.status === 429 ? '操作有些频繁，请稍后重试' : '加载失败，请稍后重试'));
  return data;
}
export const write = (path, body, method = 'POST') => api(path, { method, body: JSON.stringify(body) });
export const storage = {
  get(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key)); return value === null ? fallback : value; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Session continues without persistent storage. */ } }
};
