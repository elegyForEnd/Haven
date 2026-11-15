# ciacord 漫画空间

入口是看番空间最左侧的第二项「漫画」，第一项始终是「番剧」。也可直接访问 `/manga`；聊天页使用 `/app#manga/library`。切换空间保留现有聊天连接和番剧播放器，不整页重载。

## 启动

本地安装（Windows x64、Linux x64、macOS x64 / ARM64）：

```sh
npm run manga:setup
npm start
```

安装脚本下载固定版本 Suwayomi Server v2.4.2366，校验 SHA-256，并解压到仓库外的 `%LOCALAPPDATA%/ciacord-manga`（其他系统为 `~/.local/share/ciacord-manga`）。包含 Java，不修改系统 Java。运行时在第一次读取图源时启动，只监听 `127.0.0.1:4567`。日志、引擎数据库、漫画下载和本地书库位于 `<HAVEN_DATA_DIR>/manga-engine`。Haven 正常退出时关闭它启动的引擎。

已有引擎或 Docker / ARM Linux 部署可设置 `MANGA_ENGINE_URL`，有 Basic Auth 时设置 `MANGA_ENGINE_USERNAME` 和 `MANGA_ENGINE_PASSWORD`。地址由服务器环境提供，浏览器不能传入任意代理目标。

Docker 可使用本仓库的叠加配置构建当前代码：

```sh
docker compose -f docker-compose.yml -f docs/examples/manga/compose.yaml up -d --build
```

此配置不会向宿主发布 Suwayomi 端口。它与 Haven 通过私有容器网络通信，数据单独持久化。

## 图源

以服务器管理员账号登录 ciacord，在「漫画 → 浏览书源」点击「同步扩展仓库」，再按需安装扩展。安装后点击已启用图源，浏览或搜索漫画。普通账号可以阅读和收藏，不能安装、更新、卸载扩展或更改仓库。默认显示中文、通用和本地图源，可勾选显示所有语言。扩展是服务器运行的程序，仅管理员可管理。

内置四个用户指定仓库：

| 仓库 | 地址 |
| --- | --- |
| 全网 Keiyoushi | `https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json` |
| 拷贝扩展 | `https://raw.githubusercontent.com/LittleSurvival/copymanga-copy20/repo/index.min.json` |
| 轻小说 | `https://raw.githubusercontent.com/hualiong/bilinovel-extension/main/index.min.json` |
| Cursed | `https://raw.githubusercontent.com/yuzono/cursed-manga-repo/repo/index.pb` |

Keiyoushi 旧 `index.min.json` 当前只返回升级提示，实际读取新版 `index.json`；Suwayomi 负责解析新索引、旧 JSON 和 Protobuf。Mihon 是 Android 应用，不能直接在 Express / Electron 中运行 APK，所以由兼容的 Suwayomi 引擎执行扩展。图源 ID 始终保留为十进制字符串，不经过 JavaScript 的 53 位数字转换。

仓库能同步不代表其中每个扩展都兼容桌面。当前实际验证：四库同步成功，1617 个条目；拷贝漫画 v1.6.87 可安装、搜索、读取 153 个章节、加载封面与第 1 话 39 页、下载入队。哔哩轻小说 v1.6.28 在安装时触发上游 Java 字节码校验错误，当前不能使用；界面会提示扩展不兼容。各网站可用性、登录要求和扩展更新由上游决定。轻小说仓库作为扩展仓库接入，没有另做文本小说阅读器。

## 页面与数据

- 薄荷庭院书架：收藏、阅读分类、排序、网格／列表、续读、历史和逐部检查更新。首次为空书架，不注入虚构漫画。
- 无横幅详情：仅使用标准竖版封面，显示作品资料、章节筛选、排序、批量下载、笔记、分类和书签。切换书源通过在其他图源搜索同名漫画进行，不自动猜测匹配或迁移进度。
- 阅读器：单页／双页／条漫、从左向右／从右向左、缩放、背景色、页间距、自动翻页、章节目录、键盘、触摸滑动、全屏及工具栏收起。只有图片加载成功后才记录阅读进度。
- 图片固定通过服务端的封面／章节／页码路由中继，保留书源的防盗链处理，并规范 `image/jpg`。不向浏览器提供通用 URL 代理。
- 访客收藏、笔记、书签与逐章进度保存在当前浏览器。登录后的记录按 ciacord 账号隔离，保存在 `<HAVEN_DATA_DIR>/manga.sqlite`，本机保留离线缓存。备份需要包含此数据库与 `manga-engine` 目录。
- 下载是服务器端缓存，通过扩展引擎共享物理文件；用户书架和阅读记录独立。下载管理显示已下载及本用户发起的待完成章节，不代表断网后仍可直接离线打开网页。

## 验证

```sh
node --test --test-concurrency=1 test/manga.test.js test/anime.test.js test/httpModeHeaders.test.js
```

23 项通过。新增检查涵盖大整数图源 ID、逐章进度持久化、账号隔离、扩展管理权限、章节归属、进度校验与固定图片路径。

使用隔离数据目录与 QA 账号，真实浏览器完成封面、内页、续读、设置、书签返回、39 页条漫、153 章目录、真实下载完成、番剧／漫画切换和 390px 手机布局验收；刷新后保留第 3 页，无脚本异常及页面横向溢出。截图在 `docs/previews/manga-*.png`。上游网络失败会提示重试。Windows 本地运行及线上 Linux Docker 部署均已验证；macOS 的本地安装尚未实机验证。

两张主题素材使用内置 imagegen 生成，保存在 `public/img/manga/`；只有书架使用通用庭院插画，详情页不依赖横幅。提示词与素材用途见 `docs/design/manga-assets.json`。

接口参考：[Mihon 数据模型](https://github.com/mihonapp/mihon/blob/main/source-api/src/main/kotlin/eu/kanade/tachiyomi/source/model/SManga.kt)、[Suwayomi Server](https://github.com/Suwayomi/Suwayomi-Server)。

## 本次线上部署（2026-11-15）

部署入口：[漫画空间](https://chat.005721.xyz/manga)。使用 `/root/Haven/docs/examples/haven-traefik-coturn/docker-compose.yml`，更新 `haven-local:dev`，漫画引擎作为独立服务运行。

- 线上原镜像保留为 `haven-local:before-manga-20261115-01`，新镜像同时标记 `haven-local:manga-20261115-01`。
- 回滚文件和源文件备份位于 `/root/ciacord-deployments/manga-20261115-01/`。该目录的 `rollback.sh` 可恢复原代码和原镜像；不删除持久化数据。
- Haven 与 Traefik 的网络明确指定为 `${COMPOSE_PROJECT_NAME:-haven-traefik-coturn}_proxy`。漫画引擎仅连接独立网络，不发布主机端口。
- 引擎限制 512 MB，Java 堆上限 192 MB，关闭内置浏览器以适应 2 GB 主机。需要交互浏览器验证的扩展在此部署上可能不可用。新增 1 GB 交换空间并写入 `/etc/fstab`，文件 `/swapfile-haven-manga`。
- 四库同步、拷贝扩展安装、搜索、153 章目录、39 页图片、公网番剧／漫画切换及 390px 布局已验证。截图为 `docs/previews/manga-production-*.png`。
