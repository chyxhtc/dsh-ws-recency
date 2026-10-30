# dsh-ws-recency

DSH 侧栏的两件事：**工作区分组按最近活跃排序**、**折叠时只显示 N 条会话**。

## 一、分组排序

DSH 已经把**组内**会话按 `updatedAt` 倒序排好了（排序方式 = 最近更新），但**分组自身**用的是工作区注册表的顺序（创建工作区的先后），所以一个刚跑完一堆活的工程可能仍排在侧栏很下面。

做法：从 Client store 读每个工作区自己的会话，取组内最大的 `updatedAt`；空工作区回落到该工作区的 `createdAt`；把结果写成各分组元素的 flex `order`。不碰会话行、不碰原生置顶、不碰归档、不改 store。

与 `dsh-plugin-busy-workspace` 共存：busy 会在同一批分组元素上写 `data-busy-rank`（紧急度档位），本插件把它作为**主键**，只负责档位**内部**按活跃度排序。没装 busy 时就是纯最近活跃排序。

## 二、历史折叠

会话超过 `foldDays`（默认 **3 天**）没有更新就折叠起来；整个工作区都过期时，它只剩一行工作区标题——需要翻历史时点开就行。

- **每组只有一个控件**：宿主自己还有没渲染的行时，用它的「展开其余 N 条会话」（N 已含被折叠的行）；宿主把该组渲染完了时，才出现插件的 `展开历史 N` / `收起历史`；
- 点宿主的「展开其余」会同时放出被折叠的行；它变成「收起」时，折叠也一并复原；
- 选中 / 运行中 / 等待处理的会话**永不折叠**（可在设置里关掉这个豁免）；
- 空白草稿行（新会话）不参与折叠判断；
- 每 5 分钟自动重算一次，所以跨过 3 天边界的会话会自己折叠，不用刷新。

## 三、颜色与“需要跟进”

自动那部分只做能读准的：运行中（蓝）、完成未读（绿）。**“看过但没决策”不猜**——DSH 只有 `completionUnread` 一个布尔，点开就清零，猜不准反而制造噪音。

改成反向标记，由你自己打：

| 状态 | 颜色 | 怎么产生 |
|---|---|---|
| 运行中 | 蓝 | 宿主状态 |
| 完成未读 | 绿 | 宿主状态 |
| **需要跟进** | 琥珀 | 你在会话「…」菜单点「标记需要跟进」 |

- 标记存在 Client store 的 `followUps`（随 `dsh.ws-recency.prefs.v1` 持久化），重启后还在；
- 琥珀圆点渲染在宿主自己的 `sidebar.session.row.leading` 槽里，**不往行里塞子元素**——塞进去会让后面的行整体下移一格；点圆点即取消标记；
- 标记后该会话**又有新活动**（`updatedAt` 前进）→ 自动视为已跟进，标记消失；
- 不受 20 秒、不受打开时长影响——你标记就一直是琥珀，直到你取消或它又有新活动。

## 设置

**设置 → 通用**：

- **历史折叠天数**：`−` / 数字输入 / `+`（1–90，默认 3），以及“选中 / 运行中 / 等待处理的会话不折叠”；
- **颜色与跟进标记**：颜色标记总开关。

偏好持久化在 Client store 的 `dsh.ws-recency.prefs.v1`。

## 已知边界

- 依赖宿主 DOM：分组容器带 `_groupSection`、分组头带 `data-row-key="workspace:<id>"`、行带 `data-row-key="session:<id>"`、溢出按钮类名含 `sessionOverflowButton`。宿主改结构就要跟着改。
- 折叠只能作用于宿主**已经渲染**的行；更早的行仍在宿主自己的「展开其余」之后。
- “未分组”桶永远排在真实工作区之后。
- 只在按工作区分组（含工作区树顶层）时生效。

## 安装

npm（推荐，升级最简单）：

```powershell
dsh plugin --profile <profile> add dsh-ws-recency
```

或从 GitHub 直装：

```powershell
dsh plugin --profile <profile> add github:chyxhtc/dsh-ws-recency
```

或固定版本的预构建包：

```powershell
dsh plugin --profile <profile> add https://github.com/chyxhtc/dsh-ws-recency/releases/download/v0.7.1/dsh-ws-recency-0.7.1.tgz
```

装完把 `dsh-ws-recency` 加进 `~/.hypers-work/profiles/<profile>/package.json` 的 `dsh.profile.bundles`，重启应用。

本地开发可以直接 `link:`：

```powershell
dsh plugin --profile desktop add "link:C:\Users\Konka\Hypers Work\workspace\dsh-ws-recency"
```

自检：`node tests/selfcheck.cjs`（桩 DOM，验证排序、按天数折叠、分组控件展开、宿主按钮计数、三色与跟进标记）。
