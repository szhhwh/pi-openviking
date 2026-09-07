# pi-openviking

[volcengine/OpenViking](https://github.com/volcengine/OpenViking)
`examples/pi-coding-agent-extension` 的镜像仓库，打包为 pi git 包安装。

- 安装：`pi install git:git@github.com:szhhwh/pi-openviking`
- 安装克隆位置：`~/.pi/agent/git/github.com/szhhwh/pi-openviking`

## 开发方式：直接在安装克隆里改

```
cd ~/.pi/agent/git/github.com/szhhwh/pi-openviking
# 改文件...
git add -A && git commit -m "..." && git push
# 重启 pi 生效（或试 /reload）
```

## ⚠️ 铁律

pi 的 reconcile 逻辑：`pi update`（含 `--extensions`/`--all`）触发时，若
**本地 HEAD ≠ origin/main**，pi 会执行 `git reset --hard` + `git clean -fdx`，
未推送的提交、未提交的改动、未跟踪文件**全部丢失**。

因此：

1. 改完**立刻** commit + push，不在安装克隆里留未推送工作
2. 若从别处（网页编辑、其他机器）push 过新提交，先 `git pull` 再动手改
3. merge/复杂操作做完立即 push，不要停留

## 同步上游

一次性配置（已完成，remote 已存在）：

```bash
git remote add upstream https://github.com/volcengine/OpenViking.git
```

⚠️ 不要用 `git merge -s subtree`：实测该策略会把本地自有文件
（package.json / settings.ts / SYNC.md）直接删除、本地改动全部回退。
正确方式：**graft 合并已完成**（历史已挂接上游，commit a9223db9），
之后每次同步都是普通增量合并，**必须始终带 `-X subtree=`**：

```bash
git fetch upstream main
git merge -s ort -X subtree=examples/pi-coding-agent-extension upstream/main \
  -m "merge: sync upstream OpenViking <short-sha>"
git push
```

冲突处理：自有文件（package.json / settings.ts / SYNC.md）永远不会接受
上游版本，`git checkout --ours -- <file>` 后 `git add`；其余文件一般取
本地版（本地树 = 最新上游 + 本地功能）。定期同步由 Hermes cron 执行
`~/.hermes/scripts/sync_forks.sh`，冲突时自动 abort 并报警。

## 与上游的差异

在新增四个上游没有的文件之外，还有四个文件带本地功能改动：

- `package.json` — pi 包清单（`pi.extensions` 指向 `./index.ts`）
- `settings.ts` — 设置页（会话召回开关、footer 状态栏配置）
- `.gitignore`
- `SYNC.md` — 本文件

另有本地改动的文件：`README.md`、`config.json`（statusBar 等）、
`config.ts`、`index.ts`（settings 页接线、/viking 子命令补全）。

## 其他

- 行为配置：仓库内 `config.json`（随仓库走）；凭据在 `~/.openviking/ovcli.conf`
  或 `OPENVIKING_*` 环境变量（不受本仓库影响）
- 上游基线 commit：`0c5147cae26aec8d6d93445ec6ad86d5faff4035`
- 如需独立开发克隆：`git clone git@github.com:szhhwh/pi-openviking.git <dir>`
  （记得重新 `git remote add upstream ...`，remote 配置不随仓库走）
