# ciacord 看番空间

本功能集成在现有 Express / 原生 JavaScript 项目中，无新增 npm 依赖。

## 使用

运行 `npm start`，登录 `/app`，点击最左上角服务器图标直接切换到看番。看番界面的 C 图标直接切回聊天，不经过菜单或整页刷新。已打开的播放器保留 DOM 和播放进度，切回聊天时继续播放。

也可以直接打开 `/anime` 浏览。访客的追番记录保存在当前浏览器；登录后的收藏与观看进度关联当前 ciacord 账号，在同一服务器的设备间同步。评论、点赞与弹幕需要登录。

## 界面

- 已确认的长页面参考稿保存在 `docs/design/anime-home-reference.webp` 和 `docs/design/anime-watch-reference.webp`。
- 首页使用最左侧窄图标栏 + 文字导航栏。桌面两栏分别约占 5% 与 15%，其余为可滚动内容区。
- 播放页仅保留最左侧窄图标栏；播放器保持 16:9，页面本身可以向下滚动。
- 浅色樱花粉 / 淡紫、小字号、透明侧栏角色、樱花与星光装饰；新插画均使用内置 imagegen 生成。
- 图片已转为 WebP，保留透明度。素材清单与完整生成提示词见 `docs/design/anime-assets.json`。UI 图标、C 标志和无封面占位为代码原生 SVG。
- 手机宽度折叠文字导航，卡片换行，选集移到内容下方。

### 侧栏角色

网站侧栏使用原配色的闭眼捧书版。待机时上下浮动、摆动发梢，点击时播放一次挥手并更换气泡文案。网页使用 WebP 动画，挥手时显示补绘的手腕后方发丝。开启系统的减少动态效果设置时，显示静态立绘并保留气泡回应。

捧书版拆层文件 `ciacord-closed.psd` 和 Cubism 工程 `ciacord-layered.cmo3` 位于 `artwork/ciacord-live2d-original/`。Live2D 导出文件位于 `public/live2d/ciacord-layered/`，包含发梢待机和点击挥手动作。

## 内容与播放

番剧资料、真实封面、评分、搜索、正片集数和每日放送使用 [Bangumi API](https://bangumi.github.io/api/)，与 [Animeko](https://github.com/open-ani/animeko) 的资料来源一致。首页精选使用真实 Bangumi 条目 ID，其余通过实时搜索和每日放送扩展。

播放源来自 Animeko README 链接的 [公开订阅](https://github.com/creamycake-anime/animeko-subs)，运行时读取 `https://sub.creamycake.org/v1/css1.json`。本实现解析其 `json-api` 配置进行搜索、精确匹配番剧原名/译名、匹配集数、解析播放候选。当前订阅中的「稀饭动漫 Next」已实测返回 MP4 和 HLS 候选并在浏览器播放。数据源配置作为数据读取，不执行其中的脚本。

播放器支持续播、进度拖动、音量/静音、倍速、上一话/下一话、自动连播、线路切换、剧场模式、浏览器全屏及浏览器支持时的画中画。HLS 使用现有 hls.js 依赖或浏览器原生支持；多码率 HLS 显示实际码率选项。音轨和字幕使用视频自带轨道。

服务端媒体中继处理 MP4 Range、HLS 播放列表、分片与密钥，避免浏览器跨域限制。媒体 URL 由服务端解析结果创建随机短期能力地址，不接受用户传入的任意目标；每次请求及重定向都检查并固定 DNS 地址，阻止内网请求。上游 HTML 不会以可执行 HTML 类型返回。

此实现接入网页播放源，不运行 Animeko 的 Kotlin / Compose 原生客户端，也不移植 libtorrent、BT 缓存、WebView 网页选择器或云弹幕过滤。特典标签展示 Bangumi 特典条目并链接其资料，不将没有适配的特典伪装成可播放视频。第三方视频源可能失效，页面提供真实失败提示、重新查找和切换线路。

## 记录与讨论

`<HAVEN_DATA_DIR>/anime.sqlite` 保存当前 ciacord 服务器的用户收藏、观看进度、已看集数、评论、点赞和弹幕，按账号区分。它独立于现有聊天数据库，部署时需要持久化整个 Haven 数据目录；备份也应包含该文件，在线备份应使用 SQLite 备份机制处理 WAL。

这不是 Bangumi 账号云同步：界面明确显示「追番记录已同步」或「本机追番记录」，不会显示虚假的 Bangumi 登录状态。弹幕和讨论为当前 ciacord 服务器的真实用户内容，不预置参考图里的示例评论、观看进度或弹幕。

## 验证

```powershell
node --test --test-concurrency=1 test/anime.test.js test/httpModeHeaders.test.js test/authAsync.test.js
```

新增检查覆盖订阅 JSONPath/模板处理、译名与季度匹配、播放候选、HLS 重写、内网隔离、用户数据隔离、持久化、进度校验、评论点赞及弹幕校验。另用隔离数据目录启动完整服务，在浏览器验证真实 MP4/HLS 播放、聊天切换播放不中断、收藏与进度同步、390px 手机布局与桌面布局。没有修改真实用户的数据。

本次检查结果：38 项通过，1 项 PostgreSQL 条件检查跳过；JS 打包与 CSS 语法检查无警告。实际浏览器截图见 [首页](previews/anime-home-desktop.jpg) 和 [播放页](previews/anime-watch-desktop.jpg)。截图使用隔离 QA 账号的真实测试观看进度。
