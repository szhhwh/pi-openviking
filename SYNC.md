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

## 同步上游（diff/apply 内容同步，2026-09-09 起）

⚠️ **禁止再用 `git merge -X subtree` 同步上游**：merge 会把上游 monorepo
全部 2300+ 提交永久挂进本仓库历史（GitHub commits 页全是无关提交），
且上游目录无变化时也会制造空转 merge。2026-09-09 已重建历史：
剥离全部 merge，仅保留本地提交链（旧历史备份在 origin `backup/pre-rewrite` 分支，确认无误后可删）。

现行机制：**只把上游 `examples/pi-coding-agent-extension` 子目录的内容变化
作为一个 sync commit 落地**，不引入任何上游 commit 对象到历史：

```bash
# 已同步基线记录在 refs/synced/upstream-main（上游 tip 指针，本地引用）
git fetch upstream main                       # 只拉 main，不拉其他分支
git diff refs/synced/upstream-main:examples/pi-coding-agent-extension \
        upstream/main:examples/pi-coding-agent-extension \
  | git apply --3way --index -                # 本地功能改动参与三方合并
git commit -m "sync: upstream OpenViking <full-sha> (N commits)"
git push
git update-ref refs/synced/upstream-main <full-sha>
```

上游有新提交但扩展子目录无变化时，只推进基线引用、不产生提交。
冲突处理：`git apply --3way` 失败即回滚报警，人工解决；自有文件
（package.json / settings.ts / SYNC.md）冲突时永远取本地版。

以上全部由 Hermes cron 每 6h 执行 `~/.hermes/scripts/sync_forks.sh`，
失败自动回滚并推送飞书报警。

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
- 上游 fetch 配置：`remote.upstream.fetch = +refs/heads/main:refs/remotes/upstream/main`（仅 main，勿改回 `*`）
- 已同步基线：`refs/synced/upstream-main`（本地引用，丢失时脚本会回退扫描
  sync 提交信息里的 sha；都没有则需人工首次同步）
- 历史重建前的旧历史备份：origin `backup/pre-rewrite` 分支
