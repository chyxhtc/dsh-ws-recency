# 怎么把这个插件发给别人


## 发布规则（2026-11-26 起）

- **本地可以随便提交**：写代码、跑测试、`git commit`、打本地 tag 都不用问。
- **发到 npm 必须先经过人验证**：任何 `npm publish`、GitHub Release 都要在应用里实测通过、并由维护者明确说「发」之后才能做。
- 只有一条命令被允许用来发布：`node tools/publish.mjs <version> --approved`。它在**没有 `--approved` 时直接拒绝**，并且会先跑完 8 套测试、校验工作区干净、确认版本号一致，再去 publish，然后等 registry 真的能取到该版本，最后发 GitHub Release。
- 为什么这么严：npm 会有「staged」状态——收到 409 `previously staged version` 看似失败，几分钟后版本却又出现了，中间版本就可能被客户装上。一次误发不是撤一个 tag 能解决的。
- 版本号是消耗品：每个发出去的号都不能复用，出错就换下一个号，不要在同一号上反复重发。

## 操作顺序

```powershell
# 1. 本地：改完、跑测试、提交（不用问）
node tests/selfcheck.cjs
git add -A; git commit -m "..."

# 2. 维护者在应用里实测：重启、试功能

# 3. 维护者说「发」之后，才执行
node tools/publish.mjs 0.36.0 --approved
```

脚本会自动：跑完 8 套测试 → 校验工作区干净 → `npm publish` → 轮询 registry 直到能取到该版本 → 用同一份 tarball 建 GitHub Release。`GH_TOKEN` 未设置时只发 npm，并打印补发 Release 的命令。

插件是一个标准的 DSH bundle 包：`index.js`（宿主占位）+ `client.js`（全部逻辑）+ `cordis.patch.yml`（挂载一行）。下面四种方式按门槛从低到高。

## A. 直接发 tarball（最快，0 账号）

```powershell
cd "C:\Users\Konka\Hypers Work\workspace\dsh-ws-recency"
npm pack            # 产出 dsh-ws-recency-0.7.1.tgz（13 kB，只含 5 个文件）
```

对方拿到 tgz 后：

```powershell
dsh plugin --profile <profile> add "C:\path\to\dsh-ws-recency-0.7.1.tgz"
```

再把 `dsh-ws-recency` 加进 `~/.hypers-work/profiles/<profile>/package.json` 的 `dsh.profile.bundles`，重启。

## B. GitHub 仓库直装（0 账号，能更新）

仓库根目录必须就是插件包（`package.json` 在根上）：

```powershell
git init; git add -A; git commit -m "dsh-ws-recency 0.7.1"
git remote add origin https://github.com/<you>/dsh-ws-recency.git
git push -u origin main
```

别人：

```powershell
dsh plugin --profile <profile> add github:<you>/dsh-ws-recency
```

发 Release 更好——tag 固定，不会跟着分支漂：

```powershell
git tag v0.7.1; git push --tags
# 把 dsh-ws-recency-0.7.1.tgz 传上去，然后：
dsh plugin --profile <profile> add https://github.com/<you>/dsh-ws-recency/releases/download/v0.7.1/dsh-ws-recency-0.7.1.tgz
```

## C. 发到 npm（最顺手，需要账号）

`dsh-ws-recency` 这个名字目前**没被占用**（查过 registry，404）。

```powershell
npm login
cd "C:\Users\Konka\Hypers Work\workspace\dsh-ws-recency"
npm publish --access public
```

别人：

```powershell
dsh plugin --profile <profile> add dsh-ws-recency
```

发版前记得：8 套测试都过、`npm pack --dry-run` 只含 6 个文件（`tests/` 与 `tools/` 不会进包）。发布本身走上面那条 gated 命令，不要手工 `npm publish`。

## D. 进社区市场（能被搜到）

[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 是 `dshmarket` 的目录源，收录方式是给那个仓库提 PR，加一条插件条目（仓库 `data/` 下按分类组织，`ui` / `session` 两类都合适）。收录后会：

- 市场里可搜到、一键安装；
- 自动做静态能力扫描（`dsh-trust-check`）——我们宿主端是空壳、客户端只碰 DOM，预计 `capabilities` 为空，是加分项；
- 显示 `engines.dsh` 兼容范围（当前 `>=0.2.0-rc.2 <0.3.0`）。

## 发布前需要你补的元数据

`package.json` 里现在缺 `repository` / `homepage` / `bugs` / `author`——建好仓库后补上，npm 页面和市场卡片会好看很多，也方便别人判断可信度。

## 一个提醒

你现在这台机器上装的是 `link:` 依赖，**和发布无关**：`link:` 只在你本机生效，别人拿到包是用上面的 A/B/C 方式装。发布后你自己也可以从 `link:` 切到正式版本，避免以后再维护两份。
