'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const REPOSITORIES = Object.freeze([
  { name: '全网 · Keiyoushi', url: 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json', originalUrl: 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json' },
  { name: '拷贝扩展', url: 'https://raw.githubusercontent.com/LittleSurvival/copymanga-copy20/repo/index.min.json' },
  { name: '轻小说', url: 'https://raw.githubusercontent.com/hualiong/bilinovel-extension/main/index.min.json' },
  { name: 'Cursed', url: 'https://raw.githubusercontent.com/yuzono/cursed-manga-repo/repo/index.pb' },
]);
const MANGA_FIELDS = 'id sourceId title author artist description genre status thumbnailUrl';
const CHAPTER_FIELDS = 'id mangaId name chapterNumber sourceOrder pageCount uploadDate isDownloaded';
const EXTENSION_FIELDS = 'pkgName name lang versionName isInstalled hasUpdate isNsfw';
const runtimeHome = () => process.env.MANGA_RUNTIME_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'ciacord-manga');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function findRuntimeFile(dir, pattern, depth = 0) {
  if (depth > 8 || !fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && pattern.test(entry.name)) return full;
    if (entry.isDirectory() && !['reference', 'data'].includes(entry.name)) {
      const match = findRuntimeFile(full, pattern, depth + 1); if (match) return match;
    }
  }
  return null;
}
function resolveRuntime(runtime, overrides = {}) {
  const jar = overrides.jar || findRuntimeFile(runtime, /^Suwayomi-Server(?:-v[\d.]+)?\.jar$/i);
  if (!jar) return {};
  const jarDir = path.dirname(jar);
  const distribution = path.basename(jarDir) === 'bin' ? path.dirname(jarDir) : jarDir;
  return { jar, java: overrides.java || findRuntimeFile(path.join(distribution, 'jre'), /^java(?:\.exe)?$/i) || findRuntimeFile(path.join(distribution, 'runtime'), /^java(?:\.exe)?$/i) || 'java' };
}

function createMangaEngine({ dataDir, baseUrl = process.env.MANGA_ENGINE_URL || 'http://127.0.0.1:4567', fetchImpl = fetch } = {}) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('无效的漫画引擎地址');
  let child, starting, syncing;
  const headers = process.env.MANGA_ENGINE_USERNAME ? { Authorization: 'Basic ' + Buffer.from(`${process.env.MANGA_ENGINE_USERNAME}:${process.env.MANGA_ENGINE_PASSWORD || ''}`).toString('base64') } : {};
  async function gql(query, variables = {}, timeout = 90000) {
    const response = await fetchImpl(new URL('/api/graphql', base), {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(timeout), redirect: 'error',
    });
    if (!response.ok) throw new Error(`漫画引擎响应异常 (${response.status})`);
    // Long source IDs must never be rounded through JS's 53-bit number type.
    const raw = await response.text();
    const result = JSON.parse(raw.replace(/("(?:id|sourceId)"\s*:\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
    if (result.errors?.length) {
      const message = result.errors[0].message;
      if (/Bad type on operand stack|VerifyError|UnsupportedClassVersion|NoClassDefFoundError/i.test(message)) throw new Error('此扩展与当前桌面引擎不兼容，请尝试其他扩展或更新扩展。原始错误记录在漫画引擎日志中。');
      throw new Error(String(message).split('\n')[0]);
    }
    return result.data;
  }
  async function ping() {
    try { await gql('{ __typename }', {}, 2500); return true; } catch { return false; }
  }
  async function start() {
    if (await ping()) return;
    if (process.env.MANGA_ENGINE_URL) throw new Error('无法连接漫画引擎，请检查 MANGA_ENGINE_URL');
    const runtime = runtimeHome();
    const { jar, java } = resolveRuntime(runtime, { jar: process.env.MANGA_ENGINE_JAR, java: process.env.MANGA_JAVA_PATH });
    if (!jar) throw new Error('漫画引擎尚未安装。请在服务器运行 npm run manga:setup，或配置 MANGA_ENGINE_URL');
    const root = path.join(dataDir, 'manga-engine');
    fs.mkdirSync(root, { recursive: true });
    const log = fs.openSync(path.join(root, 'engine.log'), 'a');
    child = spawn(java || 'java', [`-Dsuwayomi.tachidesk.config.server.rootDir=${root}`, '-Dsuwayomi.tachidesk.config.server.ip=127.0.0.1', `-Dsuwayomi.tachidesk.config.server.port=${base.port || '4567'}`, '-Dsuwayomi.tachidesk.config.server.initialOpenInBrowserEnabled=false', '-Dsuwayomi.tachidesk.config.server.webUIEnabled=false', '-Dsuwayomi.tachidesk.config.server.systemTrayEnabled=false', '-Dsuwayomi.tachidesk.config.server.authMode=none', '-jar', jar], { cwd: path.dirname(jar), windowsHide: true, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    let spawnError;
    child.on('error', error => { spawnError = error; });
    child.on('exit', () => { child = null; starting = null; });
    for (let i = 0; i < 90; i++) {
      if (spawnError) throw new Error(`漫画引擎启动失败：${spawnError.message}`);
      if (!child) throw new Error('漫画引擎已退出，请查看 manga-engine/engine.log');
      await sleep(500);
      if (await ping()) return;
    }
    throw new Error('漫画引擎启动超时，请查看 manga-engine/engine.log');
  }
  async function ready() {
    if (!starting) starting = start().catch(error => { starting = null; throw error; });
    await starting;
  }
  async function call(query, variables) { await ready(); return gql(query, variables); }
  return {
    base, headers, ready, gql: call,
    async status() { return { connected: await ping(), repositories: REPOSITORIES }; },
    async syncRepositories() {
      await ready();
      if (!syncing) syncing = (async () => {
        const results = [];
        for (const repo of REPOSITORIES) {
          try {
            await gql('mutation($input:AddExtensionStoreInput!){addExtensionStore(input:$input){extensionStore{name}}}', { input: { indexUrl: repo.url } });
            results.push({ ...repo, ok: true });
          } catch (error) { results.push({ ...repo, ok: false, error: error.message }); }
        }
        await gql(`mutation{fetchExtensions(input:{}){extensions{${EXTENSION_FIELDS}}}}`);
        return results;
      })().finally(() => { syncing = null; });
      return syncing;
    },
    async extensions() { return (await call(`{extensions(first:5000){nodes{${EXTENSION_FIELDS}}}}`)).extensions.nodes; },
    async install(pkg, action = 'install') { return (await call(`mutation($input:UpdateExtensionInput!){updateExtension(input:$input){extension{${EXTENSION_FIELDS}}}}`, { input: { id: pkg, patch: { [action]: true } } })).updateExtension.extension; },
    async sources() { return (await call('{sources(first:5000){nodes{id name lang supportsLatest}}}')).sources.nodes; },
    async browse(source, page, query, latest = false) {
      const result = await call(`mutation($input:FetchSourceMangaInput!){fetchSourceManga(input:$input){hasNextPage mangas{${MANGA_FIELDS}}}}`, { input: { source: String(source), page, type: query ? 'SEARCH' : latest ? 'LATEST' : 'POPULAR', ...(query ? { query } : {}) } });
      return result.fetchSourceManga;
    },
    async detail(id, refresh = true) {
      if (!refresh) return (await call(`query($id:Int!){manga(id:$id){${MANGA_FIELDS} chapters{nodes{${CHAPTER_FIELDS}}}}}`, { id })).manga;
      const result = await call(`mutation($input:FetchMangaAndChaptersInput!){fetchMangaAndChapters(input:$input){manga{${MANGA_FIELDS}} chapters{${CHAPTER_FIELDS}}}}`, { input: { id, fetchManga: true, fetchChapters: true } });
      return { ...result.fetchMangaAndChapters.manga, chapters: { nodes: result.fetchMangaAndChapters.chapters } };
    },
    async pages(chapterId) { return (await call(`mutation($input:FetchChapterPagesInput!){fetchChapterPages(input:$input){pages chapter{${CHAPTER_FIELDS}}}}`, { input: { chapterId } })).fetchChapterPages; },
    async download(ids) { return call('mutation($input:EnqueueChapterDownloadsInput!){enqueueChapterDownloads(input:$input){__typename}}', { input: { ids } }); },
    close() { child?.kill(); },
  };
}
module.exports = { createMangaEngine, REPOSITORIES, runtimeHome, resolveRuntime };
