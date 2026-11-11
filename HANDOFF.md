# dsh-ws-recency — 交接说明（截至 0.26.2）

> 给下一个会话用的现状快照。先读这一页，再按需看代码。

## 一句话

DSH 侧栏的会话管理插件：分组排序、历史折叠、三色标记、全局置顶（可点进会话）、删除到回收站、归档会话也在回收站面板里管理（两者都是卡片）、按来源拆分的 token 分析（参数/结果分段）、会话跨工作区移动、交接到新会话，以及跨会话的内容搜索（点结果跳到那句话所在的那一轮）。

## 仓库与发布

| 项 | 值 |
|---|---|
| 本地目录 | `C:\Users\Konka\Hypers Work\workspace\dsh-ws-recency` |
| GitHub | https://github.com/chyxhtc/dsh-ws-recency |
| npm | `dsh-ws-recency`，已发布 `0.26.2`（0.26.0 内容搜索；0.25.1/0.26.1/0.26.2 修置顶行状态色与图标） |
| 最新已发布 tag / Release | `v0.26.2`；Release 已建并带附件（84,081 字节），`v0.26.1`（84,045）与 `v0.26.0`（82,851）的 Release 也补建了 |
| GitHub 凭据 | SSH key 负责 `git push`；API（Release/附件）用 Windows 凭据管理器里的 fine-grained PAT（`github_pat_…`），`git credential fill`（`protocol=https`/`host=github.com`/`username=chyxhtc`）能取到。**别再每次要 token**，`tools/release.mjs` 已封装建 Release + 传附件 |
| 市场收录 | 已合并（awesome-dsh-plugin PR #10791）；条目更新 PR #11532 已合并（11-04 nightly 目录已显示 0.24.1） |
| 本机安装 | profile `desktop` 里 `link:C:/Users/Konka/Hypers Work/workspace/dsh-ws-recency`，`dsh.profile.bundles` 含 `dsh-ws-recency` |
| 真实 DSH home | `C:\Users\Konka\.hypers-work`（不是 `~/.dsh`），profile：`desktop` |

## 功能清单

1. **工作区分组排序**：按组内最新 `updatedAt` 写 flex `order`；若别处写了 `data-busy-rank` 则优先。
2. **历史折叠**：超过 `foldDays`（默认 3 天）的会话折叠；宿主的「展开其余」按钮被 CSS 隐藏，由插件自己的 `展开历史 N` / `收起历史` 驱动（逐轮点隐藏按钮直到渲染完，靠 `aria-expanded` 停）；选中/运行中/等待中不折叠，空白草稿行不折叠；每 5 分钟重算。
3. **三色标记**：运行中=蓝、完成未读=绿、手动「需要跟进」=琥珀；标记只能手动取消；点通过 `sidebar.session.row.leading` 插槽渲染；带跟进标记的会话永不折叠。
4. **全局置顶区**：用宿主自己的 `pinnedSessionIds`，在分组之上单独一区；置顶行在原分组隐藏；点行走 `uiWorkspace.openSession(id)`，取不到就退回点宿主那行。置顶行与分组行共用同一套状态色（运行中/完成未读/需要跟进），0.25.1 起状态变化即时刷新（节不重建，只改行的 `data-wsr-state`）。0.26.1 起还画同一套状态图标：`pinDotStateOf` 把 running→ongoing、waiting→warning、unread→done、followup→warning，`paintPinState` 只在该行状态变化时重画（运行中的转圈不会每个 pass 重建）。
5. **删除会话 → 回收站**：`…` 菜单；停会话 → 摘归档/置顶 → 按 **workspace.json 原始记录** detach → 删投影缓存 → 日志目录移到 `.trash/ws-recency/<id>-<时间戳>/`，并写 `.wsr-trash.json`（sessionId/cwd/reason/at/title/统计）。
6. **Token 消耗统计**：会话菜单 + 输入框下方统计条末尾的「用量分析」pill；宿主路由 `/ws-recency/session-stats`；真实 usage（input/cacheRead/output/total）+ 按来源估算拆分；条形图为主；色相由工具身份决定，明艳度按排名递减；每个工具那条 bar 拆两段（参数=淡色 `sourceColorDim`，结果=实色 `sourceColor`），`argMode` 可把参数并进主 agent。0.25.0 起面板分三个 tab：**分布统计 / 放大归因 / 明细**（5 张摘要卡片常驻顶部，模块级 `statsTab` 记住上次选择；放大归因 tab 仅在宿主返回 `amplified` 时出现）。放大成本 / 账单归因：账单=Σ每步(input+cacheRead)，每块内容成本 = 内容 token × 之后被重读的步数（压缩点截断），返回 `amplified.bill/attributed/share/series/byKind/blocks`；放大排行给进入步、原始 token、重读次数、放大后、占账单、压到 20% 省多少。
7. **移动到工作区**：菜单选择目标；重写 header 的 cwd（persistence `create` + `append` 回放全部事件），旧日志先移进回收站做备份；同步 live session header 与工作区 header 索引后再 attach、再 detach；任何失败回滚。
8. **回收站面板**：`sidebar.panellist` 注册「回收站」，`main` 区域渲染页面：两段——「已删除的会话」和「已归档的会话」（宿主的 `archivedSessionIds`：取消归档 / 移到回收站 / 彻底删除）；另有刷新列表 / 刷新界面 / 扫描并刷新。
9. **归档集成**：归档仍是宿主动作，插件只接管管理界面。列表数据：`workspaceRegistry.archivedSessionIds` + `sessionPersistence.list()` + 投影缓存（标题→第一条 prompt→会话 id）；按 lastAt 倒序；取消归档走 `workspaceRegistry.unarchiveSession`，槽位不在就按 cwd 重新 attach。
10. **卡片化条目（0.17）**：回收站与归档条目都是卡片——徽章（删除/移动副本/归档）、标题、chips（轮次/步骤/token/体积/时间）、原目录、右侧动作；统计在删除时写入或首次打开时按日志大小缓存。
11. **交接到新会话（0.19–0.24.2）**：每轮动作行或「…」菜单「交接到新会话」→ 把指令交给宿主 Session 控制器直接发送（`sessions.using(id, {source}) → session.prompt([{type:"text"}], "queue")`，不碰输入框、不模拟按键）→ 轮询宿主 `/ws-recency/handoff` 的 `tail`，只认**点击之后产生、且本轮已结束**的那条回复（`textSeq > baseline` 且 `turnOpen === false`）里的 `~~~handoff` 块 → 在**产生它的那一轮**下方出问询卡（确认 / 重新生成 / 填意见重写 / 只读预览 / 放弃）→ 确认后 `uiWorkspace.connectWorkspace(workspaceId)` 建/复用空白会话并 `openSession`，再用同一套 `sessions.using` 把「前言 + 正文」作为第一条 prompt 发出；同时存档到 `~/.hypers-work/.wsr/handoff/<sessionId>-<时间>.md`。仅在 Client 没有 `sessions` 服务时退回旧路（写输入框 + 合成 Enter / `startSession` 草稿）。
12. **补登记游离会话 / 刷新机制**：`session-adopt` 扫回「cwd 属于某工作区却不在任何分组」的会话；恢复/扫描/移动后宿主发 `api-session/added`，另有「刷新界面」按钮。
13. **设置（设置 → 通用）**：折叠天数、是否让选中/运行中/等待中豁免折叠、颜色标记总开关、全局置顶区开关、工具参数是否计入主 agent。偏好存 `dsh.ws-recency.prefs.v1`。
14. **会话内容搜索（0.26.0）**：侧栏放大镜 → `main` 页 `ws-recency-search`。宿主 `POST /ws-recency/search` 扫全部会话日志，只取 user/assistant 的 `text` 块（思维链、工具参数、工具结果都不算）；多词 AND、大小写不敏感、纯字面匹配。命中返回 sessionId/标题/工作区/轮次/角色/片段。每个会话一份正文缓存 `~/.hypers-work/.wsr/search/<id>.json`，key 是 `sizeBytes:revision`；单请求有时间预算（6s）与新解码上限（8 个会话），没扫完返回 `pending`，面板自动续请求补齐。点结果：`openSession` → 滚到 `[data-chat-turn="<turn>"]` → 蓝框闪 2.6 秒；历史是懒加载的，所以会往上翻最多 24 步（8 秒上限）。

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
| `POST /ws-recency/search` | `{query, refresh?}` → `{hits:[{sessionId,title,workspace,cwd,turn,seq,at,role,snippet,lead,tail}], scanned,total,pending,decoded,took}`；依赖 `sessionPersistence` + `workspaceRegistry` |

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

## 放大成本 / 账单归因（0.25.0）

账单 = 每步 `input+cacheRead` 之和；每块内容进入上下文后会在后续每一步被重读，所以它的成本是 `tokens × (压缩前剩余步数)`。`aggregateSession` 的 `amplified` 字段：

- `bill`：Σ每步上下文（真实 usage）。
- `series`：按步下采样到 ≤96 点的上下文曲线。
- `byKind`：`results / args / agent / user / system` 的放大成本与占账单比例。
- `blocks`：前 15 个内容块（工具调用为主），含 `entry`（第几步进入，1 基）、`remaining`（之后重读次数）、`tokens`、`amplified`、`share`、`saving`（压到 20% 可省）。
- 思维链不计入：多数 provider 不回传，算了会虚高。
- 压缩事件（事件名含 `compact`）会把早于压缩点的块截断；当前实现按「`at >= entry` 即被压缩」处理，偏保守。

实测（本会话 354 步，账单 94.8M）：工具结果放大后占 42.7%，参数 11.1%；最贵的是同一份 `index.js` 被 read 两次（9,221 和 8,753 token，分别放大成 3.22M / 3.05M），两笔合计 6.6% 账单——这就是「小数字 × 剩余步数」的解释力。

## 代码结构

- `index.js`（宿主半，~68KB）：路由、回收站、归档集合的列表/取消归档/彻底删除、移动、统计聚合与放大归因、交接 tail/save、`announceSession`、`projectKey`、`rawWorkspaceMembership`、`cachedCheckpoint`。
- `client.js`（客户端半，~200KB）：DOM pass（排序/折叠/标记/置顶）、菜单项、统计面板（含放大排行与上下文曲线）、移动面板、回收站页面（卡片）、设置行、交接（状态 observable + 官方 prompt 发送 + 轮询 + 问询卡）、`t()` 本地字典回退。
- `tests/selfcheck.cjs`（客户端 DOM：排序/折叠/标记/置顶/统计与放大面板/交接卡/交接块切分/官方发送与降级/搜索页与跳转）、`tests/archive-page.cjs`（回收站页面渲染 + 动作）、`tests/handoff.cjs`（宿主 tail/save/守卫）、`tests/stats.cjs`（聚合 + 放大归因 + 压缩截断 + 持久层）、`tests/search.cjs`（正文提取 + 多词匹配 + 片段 + 轮次/工作区 + 缓存失效 + 路由守卫）、`tests/move.cjs`、`tests/trash.cjs`、`tests/archive.cjs`（宿主）。
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
18. **别按步骤排行「最贵的一步」**：每步的 token 就是当时的上下文（354 步的会话约 24 万/步，几乎相同），排第一永远是最后一步，数字大但不可操作。要看「内容块 × 之后还剩多少步」：一次 9k token 的 read 在第 6 步进入、后面还有 349 步，折合 322 万 token（3.4% 账单）。用户明确说过按步骤的排行「无法形成放大的直接结论」，这版就是按这个反馈做的。
19. **插件自己画的置顶行拿不到宿主的状态装饰**：`decorateRows` 只按 `data-row-key="session:<id>"` 找宿主行，而置顶行是 `data-row-key="pin:<id>"` 的插件自建节点、宿主那行又被隐藏，所以运行中/未读的状态色全丢了（0.25.1 修）。修法是 `statesOf()` 统一算出 id→state，置顶行用它写 `data-wsr-state`；**别把状态塞进节的重建签名**——那个签名只该管「哪些 id、标题、工作区名」，加状态会让整节每步重建、还会吞掉 hover；用 `applyPinStates()` 每次 pass 原地刷属性。**图标同理但要自己画**（0.26.1）：分组行的图标来自宿主的 `SessionStatusDots`（`StateDot` 组件，running 是 track+arc 的转圈 svg，done/warning 是圆点），置顶行是纯 DOM，`paintPinState()` 用 `createElementNS` 造同款 svg/圆点，并按 `data-wsr-dot` 去重，避免动画每 pass 重置。等待审批/问询（`status.pendingInteraction.kind`）在置顶行也要显示 warning 点。
20. **GitHub 只能走 SSH + 代理，且 `connect.exe` 路径不能带空格**：本机 GCM 里的 HTTPS token 已失效（401），ssh 22 被墙。可用路径是在 `~/.ssh/config` 里给 `github.com` 加 `HostName ssh.github.com` / `Port 443` / `ProxyCommand C:/Users/Konka/.ssh/connect.exe -H 127.0.0.1:7897 %h %p`（connect.exe 从 Git 目录复制到无空格路径）。`ProxyCommand` 的值由 sh 解释，写成 `C:/Program Files/...` 会报 `/bin/sh: C:/Program: No such file or directory`；另外**别用 PowerShell 的 `Set-Content -Encoding UTF8` 改 `~/.ssh/config`**（PS 5.1 会写 BOM，ssh 直接 `Bad configuration option: \357\273\277host`），用 Node 的 UTF-8 写。GitHub 的 SSH 前端有缓存不一致：同一把钥匙会间歇性 `Permission denied (publickey)`，重试即可。
21. **跳轮次只能靠 DOM，别想调宿主 API**：宿主有 `viewport.scrollToTurn()`，但只在 `@deepseek-ai/dsh-client-ui-chat` 内部（右侧轮次导轨用），没有对外暴露；对外只有 `uiWorkspace.openSession`。可用标识：对话行 `data-chat-turn="<n>"`、滚动容器 `[data-conversation-scroll]`、宿主自带的全文搜索需要改 profile 的 `session-query-sqlite` 开关（默认 `openAt: never`，全文调用直接报 `SESSION_QUERY_SEARCH_DISABLED`），所以索引和定位都自己做。历史是懒加载的：打开会话只挂最近的若干轮，往上滚才拉更早的，因此定位要「边往上滚边找」，不能打开就 `querySelector` 一次了事。
22. **搜索索引别整包读日志**：65 个会话约 91MB 压缩日志，一次性解码会把内存顶满。`readSessionEvents` 已经分页（5000 条一页），缓存只存正文（每条上限 200k 字符），并且单请求设时间预算 + 新解码上限；剩下的靠 `pending` 让面板续请求，别指望一次请求扫完。

## 测试与发布

```powershell
node tests/selfcheck.cjs
node tests/stats.cjs
node tests/search.cjs
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
5. `npm pack` 后建 GitHub Release 并上传 tgz。**pat 已在 Windows 凭据管理器里**（fine-grained，仅这个仓库，Contents 读写），别再去要 token：
   ```powershell
   $out = "protocol=https`nhost=github.com`nusername=chyxhtc`n`n" | git credential fill
   $env:GH_TOKEN = (($out | Where-Object { $_ -match "^password=" }) -replace "^password=","")
   node tools/release.mjs vX.Y.Z "X.Y.Z" notes.md dsh-ws-recency-X.Y.Z.tgz
   ```
   - `tools/release.mjs` 直接调 `api.github.com` + `uploads.github.com`，已存在就跳过（可重跑）；`undici` 从应用目录 `createRequire` 解析，代理走 `127.0.0.1:7897`；
   - 撤销 token：GitHub 设置里删 + `git credential reject`（同样喂 `protocol/host/username`）。

## 已知遗留 / 可做

- 发布链路已理顺：`git push` 走 SSH（`~/.ssh/config` 里 `github.com` → `ssh.github.com:443` + 代理），Release 走凭据管理器里的 PAT + `tools/release.mjs`，npm 用 `~/.npmrc` 的代理与登录态。三者都不再需要人给东西。
- `client.js` 里还有无入口的死代码：旧弹窗 `openTrashPanel` + `TrashFooterAction`（改走 `sidebar.panellist` 后没再注册）——可清理。
- 交接的两次发送 0.24.1 起走宿主 Session 控制器；0.24.1 已在真实界面走通。0.24.2 的「等本轮结束 + 只认新一轮 + 卡片只挂当轮」需要重启后再走一遍：点交接后处理期间不应再弹卡，结束后卡片只出现在最后一轮下方。
- 0.24.2 的页面内确认框也要实测一次：删除会话后立即点输入框应能聚焦（旧版用系统 confirm，关掉后要切走应用再回来）。
- 0.25.0 的放大面板要在重启后的真实界面确认渲染（数据已用真实会话离线验证：354 步、账单 94.8M、工具结果放大后占 42.7%、最贵两条是同一份 `index.js` 的两次 read，合计 6.6% 账单）。
- 归档卡片的 token 首次读取较慢（已按日志大小缓存，第二次起快了）。
- 市场目录 11-04 nightly 已刷新到 0.24.1（目录包 `2026.1104.14928`）；0.25.0 发布后要等下一个 nightly（约 12:25）才进目录，push 构建不重新探测 npm。
- 可以接着做：同一文件的多次 read / 重复命令的聚合提示（放大排行的 `detail` 已经能看出来，做成「同一文件 N 次、合计 X% 账单」更直接）。
- 图表色相哈希可能有碰撞，少数工具同色。
- 移动到工作区**不搬文件**（设计如此，界面上有提示）。
- 折叠依赖宿主 `sessionOverflowButton` 类名；宿主改版会失效（失效只是少一个折叠控件）。
- `connectWorkspace` 会复用工作区里已有的空白会话（与宿主「新建会话」一致）；若那个空白里正有用户没发出去的草稿，草稿仍留在输入框里，交接的 prompt 是另一条消息。
- 某轮异常中断、日志里没有 `turn/end` 时，`turnOpen` 会一直是 true，卡片要等 5 分钟轮询上限才收起——这是「只在收尾后出卡」的代价；正常完成/中止的轮次都会写 `turn/end`。
- `~~~handoff` 围栏的渲染已从宿主源码确认：`@deepseek-ai/dsh-client-ui-primitives` 的增量 markdown 解析器把 `~{3,}` 当围栏（`lib/index.js:10540`），mdast/micromark 按 CommonMark 渲染成代码块；界面截图确认仍建议做一次。
