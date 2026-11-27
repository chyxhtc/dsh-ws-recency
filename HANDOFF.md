# dsh-ws-recency — 交接说明（截至 0.30.0）

> 给下一个会话用的现状快照。先读这一页，再按需看代码。

## 一句话

DSH 侧栏的会话管理插件：分组排序、历史折叠、三色标记、全局置顶（可点进会话）、删除到回收站、归档会话也在回收站面板里管理（两者都是卡片）、按来源拆分的 token 分析（参数/结果分段）、会话跨工作区移动、交接到新会话，以及跨会话的内容搜索（点结果跳到那句话所在的那一轮）。

## 仓库与发布

| 项 | 值 |
|---|---|
| 本地目录 | `C:\Users\Konka\Hypers Work\workspace\dsh-ws-recency` |
| GitHub | https://github.com/chyxhtc/dsh-ws-recency |
| npm | `dsh-ws-recency`，已发布 `0.28.0`（0.28.0 删除保留归档标记；0.27.1 恢复即时显示；0.27.0 记录失效可移出；0.26.0 内容搜索） |
| 最新已发布 tag / Release | `v0.28.0`；此前 `v0.27.1`、`v0.27.0`、`v0.26.x` 的 Release 都已建好带附件 |
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
- `compactions`（0.30.0）：压缩完成的步号数组，客户端据此把曲线切段。只认 `compaction/end`——同一族还有 `compaction/start`、`compaction/summary`、`compaction/prune`，其中 `prune` 只裁 token、不重置上下文，把它们一起算会把曲线切在错误的位置。
- `byKind`：`results / args / agent / user / system` 的放大成本与占账单比例。
- `blocks`：前 15 个内容块（工具调用为主），含 `entry`（第几步进入，1 基）、`remaining`（之后重读次数）、`tokens`、`amplified`、`share`、`saving`（压到 20% 可省）。
- 思维链不计入：多数 provider 不回传，算了会虚高。
- 压缩事件会把早于压缩点的块截断；当前实现按「`at >= entry` 即被压缩」处理，偏保守。

### 客户端的分段拐点（0.30.0）

`contextJumps()` 按 `compactions` 切段，**每段各自取涨幅最大的三步**（段内排序，标记之间按 `series.length/10` 保持间距）。跨段相邻两点不参与比较：压缩后的第一点是新基线，拿它和压缩前比没有意义。

- 颜色表示段内排名：第 1 红 `#f0553d`、第 2 黄 `#f5c542`、第 3 蓝 `#4f9df7`。多段时颜色会重复，靠行首的段号区分。
- 排版（0.30.1 起）：**每行一个拐点**，行内是 `40px 84px 62px 1fr` 四列（段 / 步号 / 涨幅 / 谁进来的）。每行自己是独立 grid，靠**固定 px 列宽**对齐——不要改成 `auto` 列宽，否则数字位数一变就错位；也别再回到「一段一行、三组横排」，那样每项只剩约 150px，文件名全被截断。
- 归属（0.30.1）：宿主给每个曲线点带 `entered`（这一桶步数里第一个出现、token 最多的块）。别在客户端用 `blocks` 猜——面板只拿到前 15 名，一根柱覆盖十几步，猜出来经常落到系统提示上。
- 三个 tab：分布统计 / 放大归因（曲线 + 拐点）/ 放大排行（构成 + 内容块清单）。`buildAmplified` 返回 `{top, ranking}`，两个 panel 分别注入。
- 悬停联动：`highlightJumpRow` / `clearJumpHighlight` 通过 `data-wsr-jump-hit` 与 `data-wsr-jump-row` 配对，重写 `className` 时只加 `-hot`，颜色来自 `data-wsr-rank`，所以不会被覆盖。

实测（本会话 354 步，账单 94.8M）：工具结果放大后占 42.7%，参数 11.1%；最贵的是同一份 `index.js` 被 read 两次（9,221 和 8,753 token，分别放大成 3.22M / 3.05M），两笔合计 6.6% 账单——这就是「小数字 × 剩余步数」的解释力。

## 回收站面板的卡片网格（0.30.0）

两个分区（已删除 / 已归档）从整行铺满改成 `auto-fill` 网格（最小 300px，窄面板退回单列）。卡片结构：

```
标题
chips（轮次 / 步骤 / token / 体积 / 时间）
路径
                      [✕] [↻] [🗑]   ← 底部一行，右对齐，悬停或聚焦才浮现
```

- 徽章去掉了：分区标题已经写明「已删除 / 已归档」，卡片上再标一遍是重复信息。
- 操作全部是图标按钮（24×24，`wsr-icon-btn`），名称放在 `title` / `aria-label`；图标缺失时 `iconButton` 自动退回文字按钮。
- 踩过的坑：
  - `.wsr-card-danger` 曾带 `margin-left:auto`（把叉号钉在标题行最右时加的）。叉号移到按钮行后这条规则还在，把它推到整行最右、和另外两个按钮分开。移动按钮位置时记得连定位规则一起改。
  - 给卡片加 `height:100%` 撑满网格行会把内容少的卡片拉成长条，已否掉。按钮行是卡片正常流的一行（`margin-top:auto`），不拉伸卡片。
  - 按钮行三条 CSS 缺一不可：`justify-content:flex-end`（右对齐）、`min-height:24px`（隐藏时也占位，同行卡片高度一致）、`opacity` 过渡 + `:hover / :focus-within` 显示。
  - 不要在 `TrashPanelPage` 里新增 `useEffect`：之前加过一个「点击外部关闭菜单」的 effect，删掉后就恢复正常——这类 hook 变动在宿主里报错时表现为整块白页，而该环境没有可用的控制台。

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

- **删除 = 摘归属 + 搬日志 + 保留归档标记（0.28.0）**：`trashSession` 不再 `unarchiveSession`，没归档的会补 `archiveSession`；日志照旧搬进 `.trash/ws-recency/`，sidecar 里写 `archived: true`。恢复时把文件搬回、attach、**最后**才 `unarchiveSession`（顺序反了面板会出现“记录失效”）；彻底删除（`purgeTrashEntry(name, ctx)`）先摘标记再删文件。搬日志失败或落点找不到（日志在外部被删）时回滚标记。这样 dsh-context 这类读 `archivedSessionIds` 的看板会把已删会话显示成归档不可点。代价：宿主的「仅显示已归档」里能看到已删会话。
- **dsh-context 看到已删会话（0.28.0 之后）**：删除保留归档标记后，它在看板上显示为“已归档不可点”，但**要等重启或它下一轮扫描才刷新**。已查清：宿主 `workspaceRegistry.setState()` 只写存储、不 emit，归档变化没有事件；dsh-context 的 `ctx.on(` 出现 0 次，靠 `version()/coverage()/foldedSince()` 定期轮询，归档状态在 `vs()` 里是渲染时从 `ss()` 现读的——所以只要有任意一次重算就会正确。它的 `/api/dsh-context/backfill` 能强制重算，但**不要**在插件里调（没装它的用户会 404，跨插件私有路由耦合）。这是它自己的失效策略问题，建议它把 `archivedSessionIds` 纳入覆盖度签名或响应 `api-session/removed`。
- **`moveWithRetry` 的 ENOENT 语义（0.28.0 修）**：源不存在时立即返回 false，不再重试三次后返回 false 被上层当成成功——旧行为会给一条日志已不在的会话写侧车、留一个空回收站条目。
- **issue #2 的闭环（0.27.0）**：归档记录比日志活得久 → 面板里每一行都调 `stat`，会话已不在磁盘上的标 `missing: true`，客户端换成「记录失效」徽章 + 唯一的 **移出归档**（`action: "detach"` → `detachMissingArchive`，只清归档标记/工作区槽位/投影缓存，不删文件；会话还在就拒绝）。复现脚本 `tools/simulate-ghost.mjs` 在真实 home 上跑过：旧路径仍报 `session not found`，新动作能清掉记录。
- **issue #1（dsh-context）**：已核实到具体机理，不再是猜测——宿主 `workspaceRegistry.setState()` 不发事件；dsh-context 不监听任何 `ctx.on`，靠定期轮询；它列的是宿主 `listSessions` 的结果（`is()` 只信 header、不查日志），所以日志进了回收站仍会列出。**点开已删会话会重新建出空会话**这条在本机没能复现（0.27.1 修了恢复不显示的投影问题后更不可能）。插件侧不做跨插件调用（没装的用户会 404）。
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

## 搜索跳转的性能边界（0.30.x 实测结论）

- **跳到早先轮次慢，是宿主加载历史，不是插件。** 关掉插件手动点栅格跳同一轮，同样要十几秒。插件这侧只报自身同步耗时（`spentMs`），当前实测几十毫秒级；浮标里那个数字早期把宿主打开会话的时间也算进去了，已改成只累加自己的同步工作。
- **聊天区滚动不会触发历史加载，点栅格才会。** 早前用 `scrollTop` 加派发 `scroll` 事件最多只能滚到已加载窗口的头，翻不动下一页；正路是点 `button[data-index]`（一格一轮，`aria-label` 以轮号开头，取第一个整数，不能取最后一个——计数会排在后面）。
- **真正把界面拖垮的是“在大 DOM 上多一个浮层”。** 悬停轮号标签最初在 `mouseover` 里同步 `getBoundingClientRect()` 再写样式，在几万节点的会话里每次换格都强制整树重排，tooltip 延迟到几秒；改成 `transform` 合成层 + 只换格写文字后降到约 1 秒；最终按页面体量让路：`HOVER_LABEL_MAX_TURNS`(40) 或 `HOVER_LABEL_MAX_NODES`(12000) 任一越界就完全不画，才回到无延迟。跳转瞬间那一次标注保留（单次读写，无感）。
- **只用轮数判断“重”会漏。** 一轮可以有几十步（实测某会话第 3 轮走到第 74 步），所以挂载行数不多时页面可能已经很重；判据必须带上节点总数。
- **插件的 `MutationObserver` 挂在 `document.body` 上**，早期只排除了聊天区内的变动，结果栅格与宿主 tooltip（都挂在 body 的浮层）每次重绘都触发一次侧栏扫描，这是“跳转后悬停卡”的另一半原因。现在按“侧栏自己的祖先链”判定，并加 400ms 最小间隔兜底，避免观察者自激。
- **定位片段要按渲染后的文本准备**：日志里是 markdown，界面里没有 `#`、`**`、反引号、表格竖线；命中片段必须先剥掉这些标记，并同时给出命中处、稍前、开头三个候选。

### 开关（client.js 顶部）

```js
var SEARCH_ENABLED = true;   // 搜索面板、跳转、上下文展开、关键词高亮、搜索历史
```

0.30.2 起栅格轮号标签整套删除：悬停标签在大 DOM 上最少也要约 1 秒才画出 tooltip，与“只保留跳转标注”相比不值得，连带 `RAIL_LABELS_ENABLED` / `RAIL_BADGE_PAINT` / 页面体量判据一起移除。轮次信息仍在搜索结果行（`第 N 轮 / 第 N 步`）与跳转浮标里。

- 搜索结果行有 `看上下文`（行内展开命中处前后各约 400 字，不动聊天区）和 `打开会话`（跳转）。
- 搜索历史存在 `prefs.searchHistory`（最多 12 条，大小写不敏感去重，可单条删/一键清空）。

## 0.31.0

- 放大排行加了「重复读取合计」：宿主机（`index.js` 的 `byTarget`）按 `kind + name + detail` 汇总出现两次以上的块，客户端在排行下面单独列一段（N 次 / 合计 token / 占比）。只看重复，单次大读取已经在上面的逐条排行里。
- 删掉两段无入口死代码：`openTrashPanel`（旧弹窗）与 `TrashFooterAction`（改走 `panellist` 后没再注册）。
- 图表色相不再撞车：不属于任何工具族的工具按名字 FNV 散列出稳定色相，并避开五个工具族的色相 ±16°，不再统一落到中性 210（那个值本身还和 web 族 205 撞）。
- 侧栏折叠：一个项目里的会话**全部**是历史时，展开项目即视为展开历史，不再要求点第二次「显示历史」；这种组也不再渲染「收起历史」控件（没有可折叠的东西）。判据是组内存在任一「未过期且非空白」的行。
- 搜索支持过滤与语法（宿主解析，客户端只显示）：`"词组"`、`a|b` / `a or b`、`-排除`、`ws:` / `in:` / `role:`（含中文别名 `工作区:` `会话:` `角色:`）。`or` 会把上一个词所在的组重新打开，所以是「任一即可」而不是两个都必须有。
- 搜索框下面加了语法提示行。

## 0.31.1

- 搜索的范围改成控件：工作区下拉（来自 `data.workspaces.items` 的名字）、会话标题输入框（回车生效）、角色三个按钮。改控件会用当前关键词自动重搜；控件值随 `searchFilters` 跨面板保留。
- 宿主同时接受结构化字段（`workspace` / `session` / `role`）与键入的 `ws:` / `in:` / `role:`，**两者都有时以控件为准**——屏幕上看得见的选择应该赢。
- 提示行只留匹配语法（词组 / 或 / 排除），范围不再需要记语法。

## 0.32.0

- 只给范围不给关键词也能搜：客户端不再在 `query === ""` 时直接返回，宿主在「无词组」分支返回**会话列表**（`sessions[]`，按标题/工作区过滤，不读正文），客户端用它渲染可点击的会话行。
- 会话模式匹配的是**会话 header 标题**（不去读索引缓存，否则要为每个会话打开一次 JSON 文件）；正文命中模式仍然用标题兜底链。
- 搜索页元素顺序改成：标题 → 输入框 → 语法提示 → 筛选控件 → 最近搜索 → 结果。历史词从输入框上方挪到下方。

## 0.32.1

- 搜索页重排：筛选栏 → 搜索框 → 最近搜索 → 状态行 → 结果。语法提示收进 `?` 按钮，角色改成连体分段控件，控件统一 24px 高，历史固定在单行横向滚动。
- 搜索历史记住**整套条件**：`{query, workspace, session, role}`，点一下连同筛选一起回填。落盘形式是一行字符串（`\u0001` 分隔），旧数据（纯字符串）自动按“只有关键词”解码。
- 两个真 bug：
  - **显示被挤没**：搜索页是固定高度的纵向 flex 容器，结果一多子元素就按比例收缩，最矮的「最近搜索」行首当其冲被压成 0。改成框架行 `flex:0 0 auto`、只让结果列表 `flex:1 1 auto; min-height:0` 滚动。症状会随结果数量变化（选具体工作区时结果少，看起来正常），很容易误判成过滤逻辑的问题。
  - **历史读不到新值**：面板原来在首次渲染时冻结一份存储快照，快照若早于存储 hydrate 就永远为空。现在改成“本次记录 ∪ 存储列表”，按整套条件去重，删除/清空各有独立标记防止回读复活。
- 定位手法留档：把条数打到标题上（`历史 4 / 本次 0 / 存储 4`）一次就分清了“数据没写”“写进去读不到”“读到了没渲染”。以后再遇到这类“看不见”的问题，先上一次计数，不要靠猜。
- 空关键词 + 只有范围时返回会话列表（0.32.0 起）；跳转只点可见的栅格并复核当前会话。

## 0.32.2

- issue #3：宿主路由的来源校验从“必须是回环地址”改成**同源**。浏览器发 `Origin`，就要求它的 host 与请求的 `Host`（或代理的 `X-Forwarded-Host`，按逗号拆开逐个比对）一致；没有 `Origin` 的非浏览器请求照旧放行；都提供了但都不匹配时，只保留“回环→回环”这一条兜底。
- 按**主机名**比对、忽略端口：网关通常把 80/443 转成 43120，端口相等会误杀；威胁模型是“别的域名的网页来驱动本地破坏性接口”，主机名不同就挡得住。
- 影响全部路由：删除、回收站列表/恢复/清除、统计、搜索、移动、交接。测试里补了三种：局域网同源 200、跨站 403、局域网主机但跨站来源 403。

## 0.33.0

- 跳转进度与落地判定：点击栅格后显示「正在加载第 N 轮… 已等 Xs」（离最新轮 > 40 时补一句“历史较早”），**只有目标轮次的行真的出现在 DOM 里**才换成「已定位」。
  - 上一版把“行存在且能找到命中文本”当落地条件，可宿主是先移动视口、后渲染正文，于是已经跳过去了却在读秒 30s 以上，最后还报“没找到”——测试里补了对应断言，也留了教训：判定要用“宿主做了没有”，不要用“内容渲染完没有”。
- 冷命中先确认：命中离最新轮超过 `coldJumpTurns`（默认 40，设置项可改，0 = 关闭）时，点结果行先弹「只看上下文 / 仍然跳过去」；点行内的「打开会话」按钮视为已确认，直接跳。
- 设置页新增一行「跳转前确认」，步进 10 轮。
- 顺带修掉一次编辑事故：改 settleJump 的补丁把 revealHit 整段删掉了，冒烟测试直接报 `revealHit is not defined`，已重写恢复。

## 0.33.1

- 冷命中不再弹框：手写的确认层没有被 `closeConfirm` 登记，点了也不会消失，遮罩一盖上下文就没法看，只能重启。改成点结果行直接在行内展开上下文 + 一条 6 秒提示，要跳就点该行的「打开会话」。顺带在打开搜索页时清理旧版残留的 `data-wsr-confirm="cold"` 遮罩。
- 上下文可读性：宿主侧只折叠空格和制表符、保留换行（连续空行压到两行），客户端在窗口内高亮命中词，字号 11→12、行高 1.75。之前把整段压成一行的做法等于毁掉结构。

## 0.33.2

- 删掉会话菜单里的「插件耗时诊断」：它是为定位“跳转后悬停卡”临时加的，问题已经结束，菜单该只放动作。连带移除 `passSamples` / `recordPass` / `passCount` 与相关字符串、样式。
- 会话菜单里本插件保留的项：标记需要跟进、交接到新会话、移动到工作区…、删除会话（移入回收站）、Token 消耗统计。其余（置顶、重命名、分叉、复制 Session ID、在文件夹显示、归档）都是宿主自带的。

## 0.34.0

- 会话菜单只保留两项：**标记需要跟进**、**移动到工作区…**。移除 `ws-recency-handoff`（交接到新会话）、`ws-recency-stats`（Token 消耗统计）、`ws-recency-trash`（删除会话（移入回收站））三个菜单行及其组件。
- 交接仍在每轮回复下方的动作行（`conversation.chat.assistant-actions`）；统计面板仍由输入框上方的「分析」胶囊打开（新增测试钩子 `exports.__stats.open`，因为原来测试是借菜单行触发的）。
- **删除到回收站暂时没有 UI 入口**：宿主的删除能力本来就不存在（只有归档），所以移除这一行等于放弃“可恢复删除”的入口；回收站面板（侧栏图标）仍在，能管理已归档会话和回收站里已有的条目，宿主路由也都还在。恢复方法是把那一段注册加回去。
- 教训：删「一个菜单行」要连带检查它的组件是否还有别的入口、以及测试是不是借它当入口。这次因为测试借 `StatsMenuItem`/`HandoffItem`/`TrashMenuItem` 驱动功能，连着改了四处断言。

## 0.34.1

- 「移动到工作区」对**打开着的会话**改为直接拒绝，返回 `code: "session-live"`（HTTP 409）并给中文原因。以前会先 rename 日志、再 `create` 重建，而宿主持久化层仍被活句柄占着这个 id（`create` 的重复检查在 `dsh-session-persistence-jsonl/lib/index.js`），于是抛 `SessionAlreadyExistsError`，路由一律按 500 返回，用户看到的是 `HTTP 500 · session "…" already exists`，没有任何可执行的提示。
- 机制说明：宿主 `create()` 只在 `hasPending(id)` 或 `findLog(id)` 命中时抛错；`pending` 只用于“已创建未落盘”的会话，所以打开着的旧会话命中的是 `findLog`——活句柄按需重开时把刚挪走的路径又建了回来。插件侧无法安全卸掉活会话（detach 由创建者持有），所以只能拒绝。
- 客户端把该 code 映射成一句中文，不再拼 HTTP 状态与英文错误；测试里把“打开着的会话随移动同步 header”那条改成“开着的会话被拒绝、且日志没动”。

## 0.34.2

- 打开着的会话不做“安排到下次启动”的队列：释放活句柄没有公开入口，重启是唯一可靠路径，与其加一层时序不确定的延迟操作，不如把话说清楚。
- 文案改成唯一可行路径：`这个会话正开着，无法移动。请重启应用，重启后不要打开它，再从列表里移动。`；移动面板在会话正是当前打开的那个时，直接把这句放在顶部（`data-wsr-move-live`），不用等失败才看到。

## 0.35.0

- 新增「插件功能」面板（侧栏 `sidebar.panellist` 第 21 个 + `main` 页）：7 个开关，默认全开，可一键恢复。存 `prefs.features`，缺失的键按 `FEATURE_DEFAULTS` 视为开。
- 开关不是摆设：关掉后入口消失**并且后台停下**——侧栏开关会让 `Sorter` 停止 pass 并把已画的 `data-wsr-rank` / `data-wsr-dot` / `.wsr-hidden` 撤掉；统计开关会移除输入框上方的胶囊；其余组件由挂载与否决定，停用即卸载。
- **实现要点（踩过）**：最初把 `if (!featureOn(...)) return null` 写在组件内部，开关一翻组件自身的 hook 数量就变，React 会报错。改成 `withFeature(Component, feature)` 包一层：包装器每次只调用一个 `useStore`，再决定渲染或返回 null，开关翻转等于卸载/挂载，hook 数量恒定。包装器带 `__featureGate` 标记，测试据此解包。
- 测试：新增「7 行 + 开关回调 + 关掉后图标与页面都不渲染」；`selfcheck` 里那些直接调用注册组件的断言改用 `mount()` 解包（包装器 → 真组件一次，宿主 primitive 不再重复调用，否则会丢 children）；`archive-page.cjs` 的本地 `mount` 同样加了一步解包。
- 顺带清掉两处过时断言：`TrashMenuItem` 的捕获与断言（0.34.0 已删菜单行）。

## 0.35.1

- 0.35.0 把开关做成了一个侧栏面板（多一个 `sidebar.panellist` 按钮 + `main` 页），位置错了。宿主的插件页本来就有自己的扩展点，0.35.1 改成注册 `plugins.detail.section`（`order: 60`），只在 `subject` 是本插件（`pkg.name` / `name` / `row.package` 命中 `dsh-ws-recency`）时才渲染；别人的插件页返回 null。
- 顺手去掉多出来的侧栏图标与整页组件，`FeaturesSection` 直接作为插件详情页的一节（标题 + 说明 + 7 行开关 + 计数 + 全部启用）。
- 详情槽的 standardProps 里没有 `useStore`，所以这一节自己维护一份 override：点开关时先本地翻转再调 store 动作，界面上立刻可见；`resetFeatures` 清空 override。
- 教训：加 UI 之前先确认宿主已有的扩展点（`plugins.detail.section`、`plugins.detail.actions`、`plugins.detail.badge`），不要自造一个新的导航入口。

## 0.35.2

- 搜索 / 回收站关掉后只掉图标、留一条文字行：侧栏那一行来自 `sidebar.panellist` 的**注册**，宿主用 `label` 渲染文字，图标返回 null 只掉图标。改成按开关**注册/注销**：`bindPanels(feature, build)` 保存整个 injection 的 disposer（`ctx.slots.inject` 返回幂等 disposer），关掉时 dispose 图标与页面两处注册，Sorter 每次渲染调 `syncPanels(data.settings)` 对齐。
- 侧栏会话管理关不掉：`apply()` 里的 `setInterval(schedule, TICK_MS)` 从不检查开关，pass 一直在画。现在 `schedule()` 一进来就判断，关掉则 `unpaintSidebar()` 后直接返回。`unpaintSidebar` 也补全了：删掉整块置顶区（`[data-wsr-pin]`）、清 `data-wsr-state` / `data-wsr-pin-hidden` / `data-wsr-rank` / `data-wsr-dot`、去掉 `.wsr-hidden` 与内联 `order`。
- 开关改用宿主的 `Switch` primitive（`@deepseek-ai/dsh-client-ui-primitives`），和插件页其它开关同款；老宿主没有该导出时退回自带按钮样式。

## 0.35.3

- 0.35.2 的「按开关注销/重建注册」只灵一次：开启后再关闭，第二次 dispose 不起作用（行留着），重启才恢复。改成**只在启动时注册一次**（`syncPanels` 用 `panelBoot` 记住当前值，之后不再动），搜索与回收站的开关改为「重启后生效」，插件页对这两行追加说明（`features.restart`）。其余开关仍然当场生效。
- 这样也去掉了「在 React 渲染过程中 dispose 宿主注册」这种脆弱写法；`ctx.slots.inject` 的 disposer 一次性用完就没法重复使用，实测不可靠。
- 测试改成：切换后注册数不变（不重建），且行文本出现「the change takes effect after a restart」。
- 教训：宿主把侧栏行当成注册的属性，不是组件的输出——能画多少都不能让一行消失；要么在启动时决定，要么不提供这个开关。

## 0.35.5

- 0.35.3/0.35.4 把搜索与回收站的注册搬到了 Sorter 的首次渲染里，结果**回收站面板打不开**：侧栏行在，点进去没有页面。搜索没坏，因为它在同一次渲染里先注册，赶在宿主解析 `main` 键之前；回收站排在后面，键已经定稿。
- 注册搬回 `apply()`：两个面板都在 apply 里按 `readStoredFeatures()`（直接读 localStorage 的 `dsh.ws-recency.prefs.v1`，并带前缀兜底）决定是否注册。开关仍然是重启后生效，插件页的说明不变。
- 教训：`main` 的页面键必须在 shell 挂载前注册好；不要在组件渲染期间注册宿主面板。前两次「重启才生效」的结论没错，错的是注册时机。

## 0.35.6

- 发布流程改成「先提交、后验证、再发布」：新增 `tools/publish.mjs`，**没有 `--approved` 直接拒绝**，跑完 8 套测试、要求工作区干净、版本号与 `package.json` 一致才 publish，随后轮询 registry 确认版本可获取，再用同一份 tarball 建 GitHub Release。`PUBLISHING.md` 与本节都写了这条规则。
- 起因：0.35.3 报 409 `previously staged version` 却在一小时后出现，0.35.4 因此重发过一次；同时 0.35.3/0.35.4 是回收站打不开的坏版本，却已经能被客户安装。
- 待维护者决定：是否对 `dsh-ws-recency@0.35.3` 与 `@0.35.4` 执行 `npm deprecate`（提示「回收站面板打不开，请升级到 0.35.5」）。这属于 registry 写操作，按新规则需要明确同意后执行。

## 0.35.7

- 删除已归档会话时，确认框会报出指向它的定时任务数量与前几个标题：`scheduledTasksFor()` 只读 `storages/schedule.json`（同时认 v1 的顶层 `sessionId` 与 v2 的 `target.sessionId` / `involvedSessionIds`），列表里每条带 `tasks` 与 `taskTitles`。**不删任务**——`schedule` 是宿主的存储域（v2 读 v1），定时器在宿主进程内存里，改文件既不取消已排的定时器也绕过它的 schema。
- 顺带确认了删除现状：只处理被点的那个会话，子代理会话（header 的 `parentSession`）留在磁盘上；本机已存在一个例证——父会话在回收站，它的 3 个子会话还在 `sessions/`。级联删除仍待定。
- 测试：`archive.cjs` 增加 schedule 存储的 v1/v2 两种形状计数，以及存储缺失时计 0。

## 0.36.0

- 删除会话时带上子代理整棵树：`descendantSessions()` 用宿主 `sessionPersistence.list()` 的 header 建 `parentSession` 链（不是自己猜），递归收集后代；父会话与每个后代各自成为一条回收站记录，共用同一批时间戳与 `group` / `groupSize` / `parentSession` 字段。
- 恢复父会话时整组回来（`descendantsRestored`），恢复子会话只回它自己；彻底删除父会话会连组一起清（`groupPurged`）。实测场景：父会话有 3 个子会话时，删除后那 174 KB 的日志不再沉积在 `sessions/` 里。
- 回收站卡片新增两个标签：`移动时的旧副本`（`reason: move`，是移动会话时留下的备份，不是删除记录）与 `含 N 个子会话` / `子会话`；恢复确认文案会说明这一组的 N 个子会话会一起回来。
- 背景：11-02 那次移动留下的旧备份和新删除记录曾同时挂在一个 id 上，恢复时极易选错（把 11 月的旧日志复活成 duplicate）。标签是为了让人一眼分辨。

## 0.36.1

- 搜索跳转的落地判定再次收窄：行存在且**有文字**就算落地。之前要求命中片段逐字匹配，短消息的片段被截断/换行后匹配不上，于是先报「这一轮的历史内容没有被渲染」，轮询到超时又补一句「没找到第 N 轮」——两句话互相矛盾。
- `rowCarriesSeek` 的兜底阈值从 200 字符降到 12：那 200 是用来判断「整段正文在不在」，但对一个只有一两句的短消息永远不成立。
- 真正的折叠占位（行是空的）现在只报一次并停止，不再继续轮询后追加「没找到」。
- 测试：新增一条「短消息 + 片段不匹配」的跳转，断言弹出的是落地提示且带轮次号。

## 0.37.0

- 搜索结果**按工作区分组**：组内仍是宿主给的顺序（按命中时间倒序），组按“组内最新命中”排序；组头显示工作区名 + 命中数，名字的 title 是完整路径；没有工作区归属的落到「无归属工作区」。
- 每条命中新增**长会话徽章**：会话轮次 ≥ 60（`LONG_SESSION_TURNS`）时显示「长会话 · N 轮」，琥珀色，悬停说明“这一轮之前还有很多内容，跳过去要加载历史，可能很慢”。轮次取自索引里的 `maxTurn`，不需要打开会话。
- 顺带说明现状：排序一直是**命中时间倒序**（`hits.sort((a, b) => b.at - a.at)`），与工作区无关；工作区此前只在每行右侧有个小徽章，跨项目时边界不明显。

## 0.37.1

- 搜索结果改成**工作区 → 会话 → 轮次**三级：工作区按组内最新的会话更新时间排序；组内会话按会话自身的最后更新时间排（不是按它的最新命中）；会话内的命中按 `turn` → `step` → `seq` 升序，读起来就是对话本身的顺序。
- 命中里新增 `sessionAt`（宿主里取 `session.updatedAt`），否则一个只有旧命中的会话会被挤到组底，和它在侧栏里的位置不一致。
- 每行不再重复工作区徽章（上面的带已经说了）；长会话徽章上移到会话行，命中行只留轮次/步骤与时间。
- 分组逻辑抽成纯函数 `groupHits()` 并导出到 `__search.groupHits`，测试直接断言：两个工作区的顺序、组内会话按更新时间、会话内命中按轮次与步骤。

## 0.37.2

- 命中行不再重复标题与路径（上面的工作区带、会话带已经说了），腾出的位置给**轮次 · 步骤**：`第 3 轮 · 第 7 步` 用原来标题的字号与颜色，时间靠右，`title` 属性保留「会话标题 + 路径」供悬停查看。
- 字符串合并成一个 `search.turnWithStep`；命中行不再各自画工作区徽章与长会话徽章（后者上移到会话带）。
- 测试同步：断言行内不含标题与路径、`turn 3 · step 7` 在同一格、悬停属性仍带标题、片段仍在。

## 0.37.3

- 命中行顺序改成「谁 → 第几轮第几步 → 时间」，时间不再被 `flex:1` 推到右边缘（宽面板下它离内容太远）。位置用 `.wsr-hit-pos`（13px、主色、不伸展），时间紧随其后用小号次级色。
