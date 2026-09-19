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

## 同步上游（diff/apply 内容同步）

同步一律用 diff/apply，**禁止 merge 上游历史**（会把上游 monorepo 全部提交
挂进本仓库历史）。只把上游 `examples/pi-coding-agent-extension` 子目录的
内容变化作为一个 sync commit 落地，不引入任何上游 commit 对象：

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

- 上游有新提交但扩展子目录（含 shared/、tests/support/ 的生成源）无变化时，
  只推进基线引用、不产生提交。
- 冲突处理：`git apply --3way` 失败即回滚报警，人工解决；自有文件
  （package.json / settings.ts / SYNC.md）冲突时永远取本地版。

**shared/ 运行时副本**：上游不提交各 harness 的 `shared/`，由
`examples/memory-plugin-shared/lib` 在打包时生成。镜像仓库直接从 git 安装、
没有打包步骤，所以 sync 时从上游 tip 整体重新生成 `shared/`（全部 .mjs，
加 GENERATED 头注释）并入同一个 sync commit。生成文件禁止手改。

**tests/support/ 测试支持**：`recall-deferred.test.mjs` 在 monorepo 里用
`../../memory-plugin-shared/testing/support.mjs` 相对路径引用兄弟目录，
镜像仓库里该路径会逃出仓库根。sync 时从上游 tip 生成
`tests/support/*.mjs`（内部 `../lib/` 引用重写为 `../../shared/`），并把
测试的 import 改指向仓库内生成物。禁止在 git 安装克隆根目录
（`~/.pi/agent/git/github.com/`）下留任何非 git 目录，否则 pi update 守卫
fetch 失败会放弃整轮更新。

**部分克隆**：origin 和 upstream 均为 `blob:none` 部分克隆
（`remote.<name>.promisor=true` + `partialclonefilter=blob:none`）。
增量 fetch 只进 commit/树元数据（KB 级），sync 时需要的子目录 blob 按需
lazy fetch（单次 KB~10KB 级）。`extensions.partialClone` 必须设置，否则
diff/apply 触发的 lazy fetch 会报错。注意：blob:none 只省**对象库**空间，
历史与提交内容与全量克隆完全一致。

以上全部由 Hermes cron 每 6h 执行 `~/.hermes/scripts/sync_forks.sh`，
失败自动回滚并推送飞书报警。

## 自愈（重克隆 / pi update 换新克隆后必做）

重克隆会把以下 git 配置全部丢掉，cron 预检会发现并报警（不再误报成网络问题）。
按顺序补回：

```bash
cd ~/.pi/agent/git/github.com/szhhwh/pi-openviking
# 1. origin 转 https 部分克隆（push 保持 ssh）
git remote set-url origin https://github.com/szhhwh/pi-openviking
git config remote.origin.pushurl git@github.com:szhhwh/pi-openviking
git config remote.origin.promisor true
git config remote.origin.partialclonefilter blob:none
git config extensions.partialClone origin
# 2. upstream 补建 + 只拉 main + 部分克隆
git remote add upstream https://github.com/volcengine/OpenViking.git
git config remote.upstream.fetch "+refs/heads/main:refs/remotes/upstream/main"
git config remote.upstream.promisor true
git config remote.upstream.partialclonefilter blob:none
# 3. 本仓库级 github 代理（lazy fetch / fetch 需走 mihomo）
git config http.https://github.com/.proxy http://127.0.0.1:7890
# 4. 恢复已同步基线（sha 取最近一条 sync 提交信息里的）
git fetch origin main && git fetch upstream main
git update-ref refs/synced/upstream-main <最近 sync 提交里的 full-sha>
```

基线引用 `refs/synced/upstream-main` 单独丢失时（remote 还在），只做第 4 步即可；
脚本也会自动回退扫描 sync 提交信息里的 sha。

## 与上游的差异

在新增四个上游没有的文件之外，还有四个文件带本地功能改动：

- `package.json` — pi 包清单（`pi.extensions` 指向 `./index.ts`）
- `settings.ts` — 设置页（会话召回开关、footer 状态栏配置）
- `.gitignore`
- `SYNC.md` — 本文件

另有本地改动的文件：`README.md`、`config.ts`（sidecar config.json 持久化 +
statusBar；上游删了 config.json 改走 ovcli.conf 分层，本地把 sidecar 作为
设置页持久化层保留在 `loadConfigFromModuleUrl`）、`client.ts`（fetchJSON
第 4 参数 AbortSignal：Esc 中断、aborted/timedOut 归因，向上兼容上游新的
options 对象形态）、`index.ts`（settings 页接线、/viking 子命令补全）、
`recall.ts`（searchPending 的 signal 短路）。

`config.json` 现为运行时 sidecar（.gitignore 已忽略）：设置页把用户改动
持久化到这里，启动时覆盖在标准分层之上。上游版本不含此文件。

## 其他

- 行为配置：仓库内 `config.json`（随仓库走）；凭据在 `~/.openviking/ovcli.conf`
  或 `OPENVIKING_*` 环境变量（不受本仓库影响）
- 上游 fetch 配置：`remote.upstream.fetch = +refs/heads/main:refs/remotes/upstream/main`（仅 main，勿改回 `*`）
- 部分克隆配置：origin/upstream 均 `blob:none`（见「部分克隆」说明），勿删
  `extensions.partialClone`，否则 sync 时的按需 blob 取回会直接失败
- 已同步基线：`refs/synced/upstream-main`（本地引用，丢失时脚本会回退扫描
  sync 提交信息里的 sha；都没有则需人工首次同步）
