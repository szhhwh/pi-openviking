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

一次性配置：

```bash
git remote add upstream https://github.com/volcengine/OpenViking.git
```

以后每次同步（在安装克隆里，merge 完立刻 push）：

```bash
git fetch upstream main --depth 1
git merge --allow-unrelated-histories -s subtree FETCH_HEAD
# -s subtree 自动对齐：本仓库根 = 上游的 examples/pi-coding-agent-extension
git push
```

## 与上游的差异

仅新增三个上游没有的文件（不会造成同步冲突）：

- `package.json` — pi 包清单（`pi.extensions` 指向 `./index.ts`）
- `.gitignore`
- `SYNC.md` — 本文件

## 其他

- 行为配置：仓库内 `config.json`（随仓库走）；凭据在 `~/.openviking/ovcli.conf`
  或 `OPENVIKING_*` 环境变量（不受本仓库影响）
- 上游基线 commit：`0c5147cae26aec8d6d93445ec6ad86d5faff4035`
- 如需独立开发克隆：`git clone git@github.com:szhhwh/pi-openviking.git <dir>`
  （记得重新 `git remote add upstream ...`，remote 配置不随仓库走）
