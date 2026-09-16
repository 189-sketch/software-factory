# Software Factory

由 GitHub Issue 驱动的多 Agent 软件工厂，执行分类、规格设计、实现、评审、行为验证和评审反馈改进。
本 README 以当前仓库 CLI 为准，不再使用已经移除的 `npm run triage`。
本地构建出的版本不等于已经发布到 npm 的版本，修改后需要重新构建和安装。

## 安装 CLI

需要 Node.js 20+、npm、Git；连接真实 GitHub 仓库还需要 GitHub CLI 和 `gh auth login`。
以下为 PowerShell 命令，在软件工厂源码目录执行：

```powershell
npm install
npm run build
npm pack
npm install --global .\software-factory-cli-0.1.2.tgz
factory --help
```

`factory --version`（或 `factory -v`）打印当前 CLI 版本号，`factory-panel --version` 同样支持。

打包文件名以本次 `npm pack` 输出为准。
`npm run build` 同时构建可执行入口 `dist/factory/run-issue.js` 和控制面板。
`dist/factory/orchestrator.js` 是库入口，不是处理 Issue 的可执行命令。
发布包包含安装脚本、构建后的运行时、skills 清单和工作流模板，不包含 TypeScript 源码或测试 fixtures。

不想全局安装时，可直接使用源码 CLI：

```powershell
node .\bin\factory.js --help
```

## 安装到目标仓库

目标是另一个已经克隆到本地的 Git 仓库，不是软件工厂源码目录。

```powershell
factory install E:\ai\open\pi-software-factory-target --mode local --repo 189-sketch/pi-software-factory-target --non-interactive
```

安装做 3 件事：

1. **装 npm 包**：把精确版本的 `software-factory-cli` 写入目标仓库运行时依赖和 lockfile。
2. **写本地守护进程包装**：`.factory-daemon/start.sh` + `start.cmd` + `.env`（chmod 600）+ systemd unit + Windows service installer。
3. **追加 `.gitignore`**：`.factory-daemon/.env`（密钥）+ `.factory/`（运行时状态）。**不再向目标仓库复制源码**——所有运行时都来自 `node_modules/software-factory-cli/`。

被替换的旧行为（仍然受支持但不再需要）：`.agents/skills/` + `factory/` 子目录的复制。如果你的目标仓库里还有遗留的 `factory/` 子目录（来自旧版 install），删除即可；新版 install 不会自动清理。

`factory install --mode cloud` 还会把 GitHub Actions workflow 模板从 npm 包的 `dist/factory/templates/github/workflows/` 拷到 `.github/workflows/`。
依赖安装失败会明确报错，此时不要继续启动。
`--non-interactive` 跳过凭据输入，会写出 `REPLACE_ME` 占位符的 `.env`，由你稍后填入。
重复安装保留已有 `.factory-daemon/.env`。
安装器不修改 `package.json` 之外的其他文件；已经被 Git 跟踪的密钥文件仍需自行处置。

## 配置真实运行环境

编辑目标仓库的 `.factory-daemon/.env`，不要提交密钥：

```dotenv
FACTORY_GH_REPO=189-sketch/pi-software-factory-target
FACTORY_AGENT_MODE=llm
FACTORY_DEFAULT_BRANCH=main
FACTORY_POLL_INTERVAL=30
FACTORY_SYNC_PROJECTS=1
FACTORY_AUTO_MERGE=0
FACTORY_EXECUTION_ADAPTER=local
FACTORY_TRUSTED_EXECUTION=0
GH_TOKEN=填写具备目标仓库权限的令牌
ANTHROPIC_AUTH_TOKEN=填写模型服务令牌
ANTHROPIC_BASE_URL=填写Anthropic兼容服务地址
ANTHROPIC_MODEL=填写该服务支持的模型ID
```

模型地址和模型 ID 没有硬编码默认值，必须与服务端匹配。
优先级为 shell 环境变量、`.env`、本机 Claude settings 的 `env` 配置及 `gh auth token` 回退。
仓库关联 GitHub ProjectV2 时，factory 默认把 issue 加入关联 Project，并同步 `Backlog`、`Ready`、`In progress`、`In review`、`Done` 状态。
ProjectV2 同步要求 `GH_TOKEN` 具备 `project` scope；使用 `gh` 登录时可运行 `gh auth refresh -s project`。
设置 `FACTORY_SYNC_PROJECTS=0` 可显式关闭 ProjectV2 同步。
`--no-env-file` 禁止读取 dotenv，`--no-fallback-env` 禁止读取本机回退配置。
`FACTORY_AGENT_MODE=stub` 已被移除：流水线始终以真实 LLM 驱动，模型配置不完整会直接失败退出。
实现与行为验证由可配置 worker 执行，`FACTORY_EXECUTION_ADAPTER` 可设为 `local`、`docker` 或 `vm`。
`local` 仅在显式设置 `FACTORY_TRUSTED_EXECUTION=1` 后运行。
`docker` 使用 `FACTORY_DOCKER_IMAGE` 指定镜像，该镜像必须包含 Node.js、Git、GitHub CLI 和流水线需要的运行依赖。
`vm` 使用 `FACTORY_VM_COMMAND` 指定负责传送目录并启动命令的虚拟机包装器。

`FACTORY_EXECUTION_MODE` 是 `FACTORY_EXECUTION_ADAPTER` 的旧别名，仅为了向后兼容旧版 `.env`。
设置它会触发启动时的一行弃用警告；请改用 `FACTORY_EXECUTION_ADAPTER`。

## 启动 CLI

daemon 使用 `.factory/daemon.pid` 单实例锁，第二个实例会拒绝启动。
从目标仓库启动：

```powershell
Set-Location E:\ai\open\pi-software-factory-target

# 单次轮询，最多处理一个符合条件的 Issue
factory start --once

# 持续轮询并启动面板
factory start --panel --port 5174 --interval 30
```

面板默认地址为 [http://127.0.0.1:5174](http://127.0.0.1:5174)。
`--once` 没有可处理的 Issue 时也会正常退出，它不是指定 Issue 编号的命令。
持续模式还会执行每日评审反馈改进，日志中的内部任务 `issue: 0` 属于该流程。
真实运行可能修改 GitHub 标签、评论、分支、PR，并在满足条件时合并，建议先使用测试仓库。
自动合并默认关闭，只有显式设置 `FACTORY_AUTO_MERGE=1`，且同一 commit 同时通过代码评审和行为验证后才会合并。
当标签为 `needs-info` 时，daemon 会等待 Issue 正文或评论变化；用户补充信息后会自动重新分诊并继续流程。
GitHub-ref 模式下，daemon 在每个 Issue 处理开始时会在远端 `refs/heads/factory/leases/issue-N` 占位；进程被 `kill -9` 或崩溃时该 ref 可能残留，导致后续每次轮询都报 `issue-lease-busy`。设置 `FACTORY_LEASE_STALE_MS` 启用自动回收（毫秒，默认 `0` = 关闭）：
- `0`（默认）：禁止自动回收，孤儿需手工 `gh api --method DELETE repos/<owner>/<repo>/git/refs/heads/factory/leases/issue-N`。
- `3600000`（1 小时）：推荐起点。
- `7200000`（2 小时）：比 `FACTORY_RUN_TIMEOUT_MS` 默认 1 小时更安全，避免误回收仍在运行的流水线。

每次 GitHub `acquire` 使用 4 次 API 调用，并在远端仓库中产生一个带 `factory-lease issue=... ts=...` 消息的悬挂 commit 对象。
专用 commit SHA 是租约 receipt 的所有权令牌，释放前会再次读取远端 ref，只有 SHA 一致时才删除。
释放失败或所有权不匹配时会在 `daemon.log` 中产生 `ERROR lease-release-failed` 行。

测试或运维恢复时，可在 `factory start` 时附加 `--force`。
GitHub 模式会扫描所有 open issue 和 maintenance lease `0`，本地模式会扫描状态目录中的 file lease，清理完成后才开始轮询：

```bash
factory start --force
```

该标志会透传给 daemon（`scripts/factory-daemon.mjs --force`），daemon 启动后调用 `manager.clear()` 依次删除匹配的远端 ref 或本地锁，不存在时跳过。
权限和网络错误仍会报告并保留失败记录。

仅用于**确认本机是唯一 daemon** 的场景。
若同时有其他 daemon 在跑同一仓库，`--force` 会把它们持有的活锁也清掉，导致并发冲突。
底层 CLI（`factory-lease acquire --force`）支持对单个 issue 做同样操作：

```bash
node scripts/factory-lease.mjs acquire --issue 1 --force
```

不使用全局安装时，从目标仓库运行源码 CLI 的绝对路径：

```powershell
node E:\ai\open\pi-software-factory\bin\factory.js start --once
node E:\ai\open\pi-software-factory\bin\factory.js start --panel --port 5174
```

原有启动脚本仍可使用，但升级后必须重新安装以更新副本：

```powershell
.\.factory-daemon\start.cmd --once
```

Linux/macOS 使用 `./.factory-daemon/start.sh --once`。

## 常用命令

```powershell
# 单独运行面板
factory panel --target E:\ai\open\pi-software-factory-target --port 5174

# 仅执行评审反馈改进
factory start --daily

# 自定义状态及临时工作目录
factory start --state-dir E:\factory-state --workdir E:\factory-work --once

# 生成可选系统服务文件，服务注册仍需单独操作
factory install E:\ai\open\pi-software-factory-target --mode local --repo 189-sketch/pi-software-factory-target --non-interactive --install-service
```

使用自定义 dotenv 时，部分 Node 版本会提前解释 `--env-file`。
显式使用 `node --` 分隔 Node 参数与 CLI 参数：

```powershell
node -- E:\ai\open\pi-software-factory\bin\factory.js start --env-file E:\config\factory.env --once
```

配合 `--panel` 启动时，`--state-dir` 和 `--workdir` 会同时传给 daemon 与面板。
单独运行面板时，它从目标仓库的 `.factory-daemon/.env` 和进程环境解析当前项目状态目录。
面板的附加项目通过目标仓库 `.factory/projects.json` 显式注册，每个项目使用自己的根目录和状态目录。

```json
{
  "projects": [
    { "id": "secondary", "root": "../secondary-repo", "name": "Secondary" }
  ]
}
```
`factory uninstall <target>` 只删除 `.factory-daemon/`，其中可能包含密钥配置，执行前应自行备份。
该命令不会删除 `factory/`、skills 或历史状态。

## 本地无凭据验证

在新的临时目录模拟，不加载真实仓库的 dotenv。
测试通过 echo adapter 跑通：`FACTORY_MODEL_ADAPTER=echo` 让流水线复用脚本化决策，不需要真实凭据，也不会发外部请求。

```powershell
$factoryCli = 'E:\ai\open\pi-software-factory\bin\factory.js'
$demoDir = Join-Path $env:TEMP ('factory-demo-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $demoDir | Out-Null
Set-Location $demoDir
New-Item -ItemType Directory -Path inbox | Out-Null
'{"number":1,"title":"Maybe make it better? Not sure what we need.","body":""}' | Set-Content .\inbox\1.json -Encoding ascii
$env:FACTORY_MODEL_ADAPTER = 'echo'
$env:FACTORY_GH_REPO = ''
$env:GH_TOKEN = ''
$env:GITHUB_TOKEN = ''
node $factoryCli start --local-dir .\inbox --once --no-env-file --no-fallback-env
Get-Content .\.factory\state-1.json
```

预期退出码为 0，摘要包含 `issue: 1` 和 `triage: "Needs info"`，而不是空的 `{}`。
本地 inbox 文件先原子移动到 `.processing/`。
成功后文件进入 `.processed/`，失败时文件会返回 inbox 供下一轮重试。

## 测试与验收

在源码目录执行：

```powershell
npm test
node .\node_modules\typescript\bin\tsc --noEmit
npm run test:cli
```

`npm test` 包含 daemon 启动和 CLI 参数回归测试。
`npm run test:cli` 会构建、打包，在临时目录真实安装 npm 包，检查 CLI 命令、安装与重复安装、凭据保留、bundle 单次运行与每日任务、已安装 daemon 的 tsx 回退、面板 HTTP 页面与 API。
该测试会下载 npm 依赖，但清除 GitHub/模型凭据并禁用本机配置回退，不会向真实 GitHub 仓库写入内容。
这些检查不替代模型服务连通性、GitHub 写权限和真实任务验收。

## 日志与故障排查

默认状态位于目标仓库：

```text
.factory/daemon.log
.factory/daemon.pid
.factory/issues/14.json
.factory/traces/
.factory/state-14.json
.factory/state-improve-review-pr.json
```

`.factory/issues/<n>.json` 是状态机的原子检查点，保存 Agent 模式、阶段时间、当前标签、commit 绑定和验收结果。
`.factory/state-<n>.json` 是 daemon 的运行摘要，保存 `exitCode`、`summary`、`stdout`、`stderr` 和实际工作目录。
非零退出会输出 `ERROR pipeline-failed` 和 stderr 尾部，不会只留下空摘要。
若仍出现 `bad option: --issue`，检查是否还在使用旧 daemon 副本，然后重新安装并重启。
GitHub 轮询最多读取 1000 个打开的 Issue，按创建时间处理，并继续领取可恢复的工厂标签。
`needs-info` 和 `wait-to-implement` 在正文及评论不变时保持等待，内容变化后会自动重新分诊。

## 架构与其他运行方式

六个 Agent 位于 `src/agents/`，技能位于 `skills/`，编排器位于 `src/orchestrator/`。
正常运行中的分类、规格、实现、代码评审、行为验证和评审改进都经过 `pi-agent-core` 的模型工具循环。
确定性代码只负责工具权限、输出结构验证、状态转换和发布门禁。
`factory install` 还接受 `--mode cloud` 和 `--mode both` 并复制 GitHub Actions 模板，但本次本地 CLI 验收不包含云端 workflow 的真实执行。
不要在未协调的情况下同时启用云端和本地处理同一仓库。

## License

MIT
