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
npm install --global .\software-factory-cli-0.1.0.tgz
factory --help
```

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
GH_TOKEN=填写具备目标仓库权限的令牌
ANTHROPIC_AUTH_TOKEN=填写模型服务令牌
ANTHROPIC_BASE_URL=填写Anthropic兼容服务地址
ANTHROPIC_MODEL=填写该服务支持的模型ID
```

模型地址和模型 ID 没有硬编码默认值，必须与服务端匹配。
优先级为 shell 环境变量、`.env`、本机 Claude settings 的 `env` 配置及 `gh auth token` 回退。
`--no-env-file` 禁止读取 dotenv，`--no-fallback-env` 禁止读取本机回退配置。
`FACTORY_AGENT_MODE=stub` 已被移除：流水线始终以真实 LLM 驱动，模型配置不完整会直接失败退出。
实现与行为验证中的命令执行要求隔离的可信 worker，并需设置 `FACTORY_TRUSTED_EXECUTION=1`。

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

`--state-dir` 改变 daemon 输出位置，但面板仍读取目标仓库默认的 `.factory/`。
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
