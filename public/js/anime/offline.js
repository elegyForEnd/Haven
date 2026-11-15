const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('ciacord-anime-offline', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('episodes', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function operation(mode, callback) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('episodes', mode);
    const request = callback(transaction.objectStore('episodes'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function cacheEpisode({ id, title, episode, url }, signal) {
  const registration = await navigator.serviceWorker.register('/anime-offline/sw.js');
  if (!registration.active) {
    const worker = registration.installing || registration.waiting;
    if (!worker) throw new Error('离线页面准备失败');
    await new Promise((resolve, reject) => {
      function changed() {
        if (worker.state === 'activated') resolve();
        if (worker.state === 'redundant') reject(new Error('离线页面准备失败'));
      }
      worker.addEventListener('statechange', changed);
      changed();
    });
  }
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body || !/^video\/mp4(?:;|$)/i.test(response.headers.get('content-type') || '')) {
    throw new Error('请选择可缓存的 MP4 线路');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('单集缓存上限为 512 MB');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!bytes) throw new Error('线路没有返回视频数据');
  await operation('readwrite', store => store.put({ id, title, episode, video: new Blob(chunks, { type: 'video/mp4' }) }));
}

export const offlineEpisodes = () => operation('readonly', store => store.getAll());
export const deleteOfflineEpisode = id => operation('readwrite', store => store.delete(id));
