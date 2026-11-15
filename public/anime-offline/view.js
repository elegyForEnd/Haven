import { offlineEpisodes, deleteOfflineEpisode } from '/js/anime/offline.js';

const list = document.querySelector('ul');
const video = document.querySelector('video');
const status = document.querySelector('#status');
let playing;

function clearVideo() {
  video.removeAttribute('src');
  video.load();
  video.hidden = true;
  if (playing) URL.revokeObjectURL(playing.url);
  playing = null;
}

async function render() {
  try {
    const rows = await offlineEpisodes();
    list.replaceChildren();
    status.textContent = rows.length ? '' : '此设备还没有离线缓存。';
    for (const row of rows) {
      const item = document.createElement('li');
      const play = document.createElement('button');
      play.textContent = row.title + ' · 第 ' + row.episode + ' 话';
      play.onclick = () => {
        clearVideo();
        playing = { id: row.id, url: URL.createObjectURL(row.video) };
        video.src = playing.url;
        video.hidden = false;
        video.play().catch(() => {});
      };
      const remove = document.createElement('button');
      remove.textContent = '删除';
      remove.onclick = async () => {
        try {
          await deleteOfflineEpisode(row.id);
          if (playing?.id === row.id) clearVideo();
          await render();
        } catch { status.textContent = '删除缓存失败'; }
      };
      item.append(play, ' ', remove);
      list.append(item);
    }
  } catch { status.textContent = '无法读取离线缓存'; }
}

render();
