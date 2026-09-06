# pi-openviking

[volcengine/OpenViking](https://github.com/volcengine/OpenViking)
`examples/pi-coding-agent-extension` 的镜像仓库，打包为 pi git 包安装。

- 安装：`pi install git:git@github.com:szhhwh/pi-openviking`
- 更新（改完 push 后）：`pi update --extension git:git@github.com:szhhwh/pi-openviking`
- 行为配置：仓库内 `config.json`（随仓库走）；凭据在 `~/.openviking/ovcli.conf` 或 `OPENVIKING_*` 环境变量（不受本仓库影响）

## 与上游的差异

仅新增三个上游没有的文件（不会造成同步冲突）：

- `package.json` — pi 包清单（`pi.extensions` 指向 `./index.ts`）
- `.gitignore`
- `SYNC.md` — 本文件

## 同步上游

一次性配置：

```bash
git remote add upstream https://github.com/volcengine/OpenViking.git
```

以后每次同步（本仓库目前是纯镜像，通常无冲突；有本地补丁后仅在重叠行出冲突）：

```bash
git fetch upstream main --depth 1
git merge --allow-unrelated-histories -s subtree FETCH_HEAD
# -s subtree 会自动对齐：本仓库根 = 上游的 examples/pi-coding-agent-extension
git push
pi update --extension git:git@github.com:szhhwh/pi-openviking
```

## 基线

- 上游基线 commit：`0c5147cae26aec8d6d93445ec6ad86d5faff4035`
