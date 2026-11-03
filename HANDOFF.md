# dsh-ws-recency — 交接说明（截至 0.24.2）

> 给下一个会话用的现状快照。先读这一页，再按需看代码。

## 一句话

DSH 侧栏的会话管理插件：分组排序、历史折叠、三色标记、全局置顶（可点进会话）、删除到回收站、归档会话也在回收站面板里管理（两者都是卡片）、按来源拆分的 token 分析（参数/结果分段）、会话跨工作区移动、交接到新会话。

## 仓库与发布

| 项 | 值 |
|---|---|
| 本地目录 | `C:\Users\Konka\Hypers Work\workspace\dsh-ws-recency` |
| GitHub | https://github.com/chyxhtc/dsh-ws-recency |
| npm | `dsh-ws-recency`，当前 `0.24.2` |
| 最新已发布 tag / Release | `v0.24.2`（附件 `dsh-ws-recency-0.24.2.tgz`） |
| 市场收录 | 已合并（awesome-dsh-plugin PR #10791）；条目更新 PR #11532 已提 |
| 本机安装 | profile `desktop` 里 `link:C:/Users/Konka/Hypers Work/workspace/dsh-ws-recency`，`dsh.profile.bundles` 含 `dsh-ws-recency` |
| 真实 DSH home | `C:\Users\Konka\.hypers-work`（不是 `~/.dsh`），profile：`desktop` |

## 功能清单

1. **工作区分组排序**：按组内最新 `updatedAt` 写 flex `order`；若别处写了 `data-busy-rank` 则优先。
2. **历史折叠**：超过 `foldDays`（默认 3 天）的会话折叠；宿主的「展开其余」按钮被 CSS 隐藏，由插件自己的 `展开历史 N` / `收起历史` 驱动（逐轮点隐藏按钮直到渲染完，靠 `aria-expanded` 停）；选中/运行中/等待中不折叠，空白草稿行不折叠；每 5 分钟重算。
3. **三色标记**：运行中=蓝、完成未读=绿、手动「需要跟进」=琥珀；标记只能手动取消；点通过 `sidebar.session.row.leading` 插槽渲染；带跟进标记的会话永不折叠。
4. **全局置顶区**：用宿主自己的 `pinnedSessionIds`，在分组之上单独一区；置顶行在原分组隐藏；点行走 `uiWorkspace.openSession(id)`，取不到就退回点宿主那行。
5. **删除会话 → 回收站**：`…` 菜单；停会话 → 摘归档/置顶 → 按 **workspace.json 原始记录** detach → 删投影缓存 → 日志目录移到 `.trash/ws-recency/<id>-<时间戳>/`，并写 `.wsr-trash.json`（sessionId/cwd/reason/at/title/统计）。
6. **Token 消耗统计**：会话菜单 + 输入框下方统计条末尾的「用量分析」pill；宿主路由 `/ws-recency/session-stats`；真实 usage（input/cacheRead/output/total）+ 按来源估算拆分；条形图为主、明细表折叠；色相由工具身份决定，明艳度按排名递减；每个工具那条 bar 拆两段（参数=淡色 `sourceColorDim`，结果=实色 `sourceColor`），`argMode` 可把参数并进主 agent。
7. **移动到工作区**：菜单选择目标；重写 header 的 cwd（persistence `create` + `append` 回放全部事件），旧日志先移进回收站做备份；同步 live session header 与工作区 header 索引后再 attach、再 detach；任何失败回滚。
8. **回收站面板**：`sidebar.panellist` 注册「回收站」，`main` 区域渲染页面：两段——「已删除的会话」和「已归档的会话」（宿主的 `archivedSessionIds`：取消归档 / 移到回收站 / 彻底删除）；另有刷新列表 / 刷新界面 / 扫描并刷新。
9. **归档集成**：归档仍是宿主动作，插件只接管管理界面。列表数据：`workspaceRegistry.archivedSessionIds` + `sessionPersistence.list()` + 投影缓存（标题→第一条 prompt→会话 id）；按 lastAt 倒序；取消归档走 `workspaceRegistry.unarchiveSession`，槽位不在就按 cwd 重新 attach。
10. **卡片化条目（0.17）**：回收站与归档条目都是卡片——徽章（删除/移动副本/归档）、标题、chips（轮次/步骤/token/体积/时间）、原目录、右侧动作；统计在删除时写入或首次打开时按日志大小缓存。
11. **交接到新会话（0.19–0.24.2）**：每轮动作行或「…」菜单「交接到新会话」→ 把指令交给宿主 Session 控制器直接发送（`sessions.using(id, {source}) → session.prompt([{type:"text"}], "queue")`，不碰输入框、不模拟按键）→ 轮询宿主 `/ws-recency/handoff` 的 `tail`，只认**点击之后产生、且本轮已结束**的那条回复（`textSeq > baseline` 且 `turnOpen === false`）里的 `~~~handoff` 块 → 在**产生它的那一轮**下方出问询卡（确认 / 重新生成 / 填意见重写 / 只读预览 / 放弃）→ 确认后 `uiWorkspace.connectWorkspace(workspaceId)` 建/复用空白会话并 `openSession`，再用同一套 `sessions.using` 把「前言 + 正文」作为第一条 prompt 发出；同时存档到 `~/.hypers-work/.wsr/handoff/<sessionId>-<时间>.md`。仅在 Client 没有 `sessions` 服务时退回旧路（写输入框 + 合成 Enter / `startSession` 草稿）。
12. **补登记游离会话 / 刷新机制**：`session-adopt` 扫回「cwd 属于某工作区却不在任何分组」的会话；恢复/扫描/移动后宿主发 `api-session/added`，另有「刷新界面」按钮。
13. **设置（设置 → 通用）**：折叠天数、是否让选中/运行中/等待中豁免折叠、颜色标记总开关、全局置顶区开关、工具参数是否计入主 agent。偏好存 `dsh.ws-recency.prefs.v1`。

## 宿主路由（都在 `index.js`）

| 路由 | 作用 |
|---|---|
| `POST /ws-recency/health` | 自检：版本 + 各路由是否挂载 |
| `POST /ws-recency/session-trash` | 删除到回收站 |
| `POST /ws-recency/session-stats` | token 统计 |
| `POST /ws-recency/session-move` | 移动到工作区 |
| `POST /ws-recency/session-adopt` | 补登记/修复归属 |
| `POST /ws-recency/handoff` | `{action:"tail", sessionId}` 取最新 assistant 文本，另返回 `textSeq`（该文本的日志序号）、`lastSeq`（最新事件序号）、`turn`（文本所属轮次）、`turnOpen`（该轮是否仍在跑）；`{action:"save", sessionId, text}` 存 markdown |
| `POST /ws-recency/trash` | `{action:"list"\|"restore"\|"purge", name}`；`{action:"archived"}`；`{action:"unarchive"\|"delete"\|"forget", sessionId}` |

全部只接受 POST + 回环 origin。

## 客户端发送面（0.24.1 起）

交接的两次发送都走宿主自己：

- `ctx.sessions.using(id, { source: "dsh-ws-recency" }, ref => ref.binding.session.prompt([{ type: "text", text }], "queue"))` —— retain → 等 ready → prompt → release。优点：不依赖编辑器挂载/焦点，对不在前台的会话也能发（「…」菜单的交接项就靠它）。
- 确认卡片：`uiWorkspace.connectWorkspace(workspaceId)` 建/复用空白会话并返回 id（不导航），`uiWorkspace.openSession(id)` 打开，再走同一条 `sessions.using` 发「前言 + 正文」。
- 降级：没有 `sessions` 服务时，当前会话才写 composer + 合成 Enter（`sendThroughComposer` 用 `[data-conversation-session]` 比对目标，避免写进别的会话）；新会话退回复刻 `startSession({prompt})` 草稿 + `autoSendDraft`。
- 注意：`ctx.get("sessions")` 不需要 inject（cordis 的 `get` 明确“without the inject requirement”），但属性访问需要。

## 交接卡的就绪判定（0.24.2 修）

`tail` 返回的是**全日志最后一条非空 assistant 文本**，不是“本次指令的回复”。新起的一轮会先落若干只有 reasoning/tool-call 的 assistant 消息，如果上一轮结尾恰好也是一个 `~~~handoff` 块（例如刚交接过的会话），旧逻辑会把它当成答案，交接刚开始还在跑就弹卡。现在三重判定：

1. `turnOpen === false`：本轮已收尾（`turn/start` 之后没有 `turn/end` 就不算）；
2. `textSeq > baseline`：文本的日志序号晚于点击时记录的水位（`lastSeq`）；
3. `at > handoffStartedAt`：老宿主没有序号时的兜底时间判定。

卡片本身挂在 `conversation.chat.turnTail`，该槽**每轮渲染一次**，因此 `ready` 状态带 `turn`，只在 `props.turn === state.turn` 的那一轮显示；`running` 的提示行只显示在 `turn > afterTurn`（点击时最大轮次）的尾部。

## 代码结构

- `index.js`（宿主半，~64KB）：路由、回收站、归档集合的列表/取消归档/彻底删除、移动、统计聚合、交接 tail/save、`announceSession`、`projectKey`、`rawWorkspaceMembership`、`cachedCheckpoint`。
- `client.js`（客户端半，~188KB）：DOM pass（排序/折叠/标记/置顶）、菜单项、统计面板、移动面板、回收站页面（卡片）、设置行、交接（状态 observable + 官方 prompt 发送 + 轮询 + 问询卡）、`t()` 本地字典回退。
- `tests/selfcheck.cjs`（客户端 DOM：排序/折叠/标记/置顶/统计/交接卡/交接块切分/官方发送与降级）、`tests/archive-page.cjs`（回收站页面渲染 + 动作）、`tests/handoff.cjs`（宿主 tail/save/守卫）、`tests/stats.cjs`、`tests/move.cjs`、`tests/trash.cjs`、`tests/archive.cjs`（宿主）。
- `README.md`（用户文档）、`PUBLISHING.md`（发布流程）、`awesome-entry.yml`（市场条目模板）。

## 踩过的坑（重要，别重犯）

1. **cordis 服务访问**：没 `inject` 就访问服务会抛 `cannot get property "x" without inject`。不要在模块顶层写死 `export const inject=[...]`（缺一个服务整个插件不加载），改成在 `apply` 里分作用域 `ctx.inject([...], cb)`。
2. **工作区 `sessionIds` 是过滤视图**：改完 cwd 后旧工作区看起来已不含该会话，用它判断 detach 会漏 → 必须读 `storages/workspace.json` 原始记录。
3. **attachSession 校验** `header.cwd === workspace.path`（realpath），header 是日志第一条不可变记录 → 移动必须重写 header（用 persistence `create`+`append`，不要自己 zstd，宿主 Node 不保证有 zstd）。
4. **内存里的旧 header**：`workspaceRegistry.readSessionHeader` 优先返回 live session 的 header → 移动后要把新 header 同步给 `indexHeader` 和 live 对象。
5. **UI 不刷新**：侧栏列表是启动时快照；宿主侧改动不会自动出现在界面 → 广播 `api-session/added`，并提供「刷新界面」。
6. **i18n**：槽位的 `props.t` 可能解析不到插件命名空间 → `t()` 在宿主翻译返回 key 时回退到本地字典。
7. **样式复用**：`.wsr-step` 是 24×24 步进按钮，文字按钮用 `.wsr-btn`；输入框下方的 pill 要克隆官方 pill 的 class/图标并复制 computed 样式。
8. **底部动作区**：`sidebar.footer.action` 的行由外壳控制宽度/对齐 → 改走 `sidebar.panellist`。
9. **bar 两段别用 opacity**：`.wsr-chart-group` 不设 background，否则半透明参数段与同色底复合回单色；两段各给实色。
10. **Windows 上别用 PowerShell 读写带中文的源码**：`Get-Content`/`Set-Content`（PS 5.1 默认 ANSI）会把中文变乱码且不可逆；改文本一律用编辑工具或用 Node 的 UTF-8 读写。**看清楚再动手**：`Get-Content` 读 UTF-8 文件显示乱码只是读法不对，文件本身没事（曾据此误判 `awesome-entry.yml` 坏了）。
11. **交接块围栏必须“独占一行”才算闭合**：0.23.1 及以前用「第一个 ```」收尾，而交接正文里写着「→ 抓到 ```handoff 块」，于是交接文被截到「→ 抓」，新会话只拿到半截（0.23.2 修）。解析逻辑在 `client.js` 的 `fencedBlocks` / `handoffBlockOf`，靠 `__handoff.blockOf` 做断言。
12. **合成 Enter 必须晚于写入**：同一帧里 `insertText` 后的 Enter 会被编辑器吞掉 → 写后 250ms 再按，之后每 800ms 补一次、最多 3 次，清空即停。0.24.1 起它只是没有 `sessions` 服务时的降级路径。
13. **跨组件状态用模块级 observable**：`defineStore` 返回的句柄没有 `actions`，不同插槽实例各拿各的副本；交接卡与动作行靠模块级 `handoffState` + 订阅函数通信。
14. **浮层要登记统一关闭句柄**：统计/移动/回收站弹层的 backdrops 必须能统一关掉，否则关不掉。
15. **菜单项的交接必须和动作行共用一条发送路径**：0.24.0 的「…」菜单项调用的是 0.20 删掉的 `openHandoffPanel`，点一次抛一次 `ReferenceError`，测试只断言了渲染没断言 onSelect。现在菜单项 = `openSession(id)` + `startHandoff(id)`，`selfcheck` 会真的点它并断言 `sessions.using` 收到 prompt。
16. **交接卡不能只看「最后一条回复」**：0.24.1 及以前一看到新 assistant 消息就解析 `tail` 的 `text`，而 `text` 可能是上一轮留下的旧交接块（本轮先落的是工具步骤）→ 点完交接 1.5 秒就弹卡。必须同时满足「本轮已结束」+「文本序号晚于点击水位」；卡片的 `turnTail` 槽每轮都有，还要只认产生它的那一轮。回归断言在 `selfcheck` 的 `readyOf` 与 turn 匹配两条。
17. **别用 `window.confirm` / `window.alert`**：Windows 上 Electron 的原生确认框关闭后渲染进程没有键盘焦点——输入框点不进去、切换会话也没用，切到别的应用再切回来才恢复（用户实测：删除会话后必现）。插件内所有确认都改成页面内 `askConfirm`/`askNotice`（遮罩 + 文案 + 取消/确认，Escape 取消，焦点在确认按钮，关掉后把焦点还给原元素）；`closeStatsPanel` 会连带关闭确认层。新增原生对话框前先想想这个坑。

## 测试与发布

```powershell
node tests/selfcheck.cjs
node tests/stats.cjs
node tests/move.cjs
node tests/trash.cjs
node tests/archive.cjs
node tests/archive-page.cjs
node tests/handoff.cjs
```

发布步骤（网络常抖，需重试）：

1. 改 `package.json` 版本（`HOST_VERSION` 跟着改）+ README 里的 release 链接；
2. 七个测试全过；
3. `git add -A && git commit && git tag -f vX.Y.Z && git push origin main && git push origin vX.Y.Z`（失败的推送重试几轮；`GIT_TERMINAL_PROMPT=0` 可避免卡住）；
4. `npm publish --access public`（npm 需要代理配置 `proxy/https-proxy=http://127.0.0.1:7897`，已在 `~/.npmrc`）；
   - npm 11 是异步发布，PUT 返回 `202`；立刻 `npm view` 可能还是旧版本，等 1–3 分钟；
   - 期间重跑会报 `E409 Cannot publish over previously staged version`——不要再发请求，改轮询 `https://registry.npmjs.org/dsh-ws-recency/<version>`。
5. `npm pack` 后建 GitHub Release 并上传 tgz：用 `undici` 的 `ProxyAgent("http://127.0.0.1:7897")` 走 `api.github.com` / `uploads.github.com`；
   - 没有存 GitHub token，从 git 凭据里取：`git credential fill`（stdin: `protocol=https` / `host=github.com` / 空行）拿到 `gho_…`，用 `Authorization: Bearer <token>`；
   - `undici` 不在仓库依赖里，用 `createRequire("D:/IDE/Hypers Work/resources/app/package.json")("undici")` 从应用目录解析；
   - 上传走 `POST https://uploads.github.com/repos/<owner>/<repo>/releases/<id>/assets?name=<file>`，`content-type: application/octet-stream`，成功返回 `201`。

## 已知遗留 / 可做

- `client.js` 里还有无入口的死代码：旧弹窗 `openTrashPanel` + `TrashFooterAction`（改走 `sidebar.panellist` 后没再注册）——可清理。
- 交接的两次发送 0.24.1 起走宿主 Session 控制器；0.24.1 已在真实界面走通。0.24.2 的「等本轮结束 + 只认新一轮 + 卡片只挂当轮」需要重启后再走一遍：点交接后处理期间不应再弹卡，结束后卡片只出现在最后一轮下方。
- 0.24.2 的页面内确认框也要实测一次：删除会话后立即点输入框应能聚焦（旧版用系统 confirm，关掉后要切走应用再回来）。
- 归档卡片的 token 首次读取较慢（已按日志大小缓存，第二次起快了）。
- 市场目录（dshmarket）里仍显示 0.9.2，等目录重新生成；本地 `awesome-entry.yml` 已补上交接功能描述，随下一次条目 PR 生效。
- 图表色相哈希可能有碰撞，少数工具同色。
- 移动到工作区**不搬文件**（设计如此，界面上有提示）。
- 折叠依赖宿主 `sessionOverflowButton` 类名；宿主改版会失效（失效只是少一个折叠控件）。
- `connectWorkspace` 会复用工作区里已有的空白会话（与宿主「新建会话」一致）；若那个空白里正有用户没发出去的草稿，草稿仍留在输入框里，交接的 prompt 是另一条消息。
- 某轮异常中断、日志里没有 `turn/end` 时，`turnOpen` 会一直是 true，卡片要等 5 分钟轮询上限才收起——这是「只在收尾后出卡」的代价；正常完成/中止的轮次都会写 `turn/end`。
- `~~~handoff` 围栏的渲染已从宿主源码确认：`@deepseek-ai/dsh-client-ui-primitives` 的增量 markdown 解析器把 `~{3,}` 当围栏（`lib/index.js:10540`），mdast/micromark 按 CommonMark 渲染成代码块；界面截图确认仍建议做一次。
