# 怎么把这个插件发给别人

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

发版前记得：`node tests/selfcheck.cjs` 过、`npm pack --dry-run` 只含 5 个文件（`tests/` 不会进包）。

## D. 进社区市场（能被搜到）

[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 是 `dshmarket` 的目录源，收录方式是给那个仓库提 PR，加一条插件条目（仓库 `data/` 下按分类组织，`ui` / `session` 两类都合适）。收录后会：

- 市场里可搜到、一键安装；
- 自动做静态能力扫描（`dsh-trust-check`）——我们宿主端是空壳、客户端只碰 DOM，预计 `capabilities` 为空，是加分项；
- 显示 `engines.dsh` 兼容范围（当前 `>=0.2.0-rc.2 <0.3.0`）。

## 发布前需要你补的元数据

`package.json` 里现在缺 `repository` / `homepage` / `bugs` / `author`——建好仓库后补上，npm 页面和市场卡片会好看很多，也方便别人判断可信度。

## 一个提醒

你现在这台机器上装的是 `link:` 依赖，**和发布无关**：`link:` 只在你本机生效，别人拿到包是用上面的 A/B/C 方式装。发布后你自己也可以从 `link:` 切到正式版本，避免以后再维护两份。
