'use strict';
// Install the pinned compatible engine outside the repository. No admin rights needed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');
const { runtimeHome } = require('../src/manga-engine');
const version = 'v2.4.2366';
const hashes = {
  'windows-x64.zip': 'b955f374a8d94b8d1c2750ae28fa7eb2066b479957561b5ba9cf8ac993c8fc13',
  'linux-x64.tar.gz': '7a469f8c820e65305f795d61f1776c783919884531497b587bdff898a7e0fa73',
  'macOS-arm64.tar.gz': '3b269855928070253a4d9f7c4a57d9ff99d0272102410233c459b02a732e87e7',
  'macOS-x64.tar.gz': '18768b2e3b7fb25bf3eff9e4b4b14b6235b2dfea320701ab172ea7f902eeb97e',
};
async function main() {
  const platform = { win32: 'windows', linux: 'linux', darwin: 'macOS' }[process.platform];
  const suffix = `${platform}-${process.arch}.${platform === 'windows' ? 'zip' : 'tar.gz'}`;
  const hash = hashes[suffix];
  if (!hash) throw new Error('此平台请使用外部 Suwayomi 服务，并设置 MANGA_ENGINE_URL');
  const home = runtimeHome();
  fs.mkdirSync(home, { recursive: true });
  const name = `Suwayomi-Server-${version}-${suffix}`;
  const archive = path.join(home, name);
  const digest = async () => {
    const sum = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(archive)) sum.update(chunk);
    return sum.digest('hex');
  };
  if (!fs.existsSync(archive) || await digest() !== hash) {
    console.log(`下载 Suwayomi ${version}（约 330 MB，包含 Java）…`);
    const response = await fetch(`https://github.com/Suwayomi/Suwayomi-Server/releases/download/${version}/${name}`, { signal: AbortSignal.timeout(15 * 60000) });
    if (!response.ok) throw new Error(`下载失败 (${response.status})`);
    const partial = archive + '.partial';
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
    fs.renameSync(partial, archive);
  }
  if (await digest() !== hash) throw new Error('下载文件校验失败，请重新运行安装');
  if (suffix.endsWith('.zip')) new (require('adm-zip'))(archive).extractAllTo(home, true);
  else execFileSync('tar', ['-xzf', archive, '-C', home], { windowsHide: true });
  console.log(`漫画引擎已安装：${home}\n打开漫画空间 → 浏览书源，以管理员账号同步仓库并安装扩展。`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
