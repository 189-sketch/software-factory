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
# tarball 文件名以 npm pack 实际输出为准(2026-09 当前版本 0.3.0)
npm install --global .\software-factory-cli-0.3.0.tgz
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
# 可选:启用 typesafe(Jev) judgment 后端
TYPESAFE_API_KEY=填写 typesafe.ai 的 API key
# typesafe 端点由 runtime/typesafe-backend.mjs 硬编码为 https://api.typesafe.ai/v1/systemone
FACTORY_TYPESAFE_MODEL=jev-latest          # 默认值
# 可选:FACTORY_TYPESAFE_OFF=1 显式关闭 typesafe,所有判断回到 claude-code
```

模型地址和模型 ID 没有硬编码默认值，必须与服务端匹配。
优先级为 shell 环境变量、`.env`、本机 Claude settings 的 `env` 配置及 `gh auth token` 回退。
仓库关联 GitHub ProjectV2 时，factory 默认把 issue 加入关联 Project，并同步 `Backlog`、`Ready`、`In progress`、`In review`、`Done` 状态。
ProjectV2 同步要求 `GH_TOKEN` 具备 `project` scope；使用 `gh` 登录时可运行 `gh auth refresh -s project`。
设置 `FACTORY_SYNC_PROJECTS=0` 可显式关闭 ProjectV2 同步。
`--no-env-file` 禁止读取 dotenv，`--no-fallback-env` 禁止读取本机回退配置。
`FACTORY_AGENT_MODE=stub` 已被移除：流水线始终以真实 LLM 驱动。
`claude-code` 后端的凭据来自 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`，三者都未设置时使用本机 `claude` CLI 自身的登录状态（启动日志 `agent-credentials` 记录来源）。
设置了 `ANTHROPIC_BASE_URL` 却没有令牌属于配置不完整，daemon 会直接失败退出。
`ANTHROPIC_MODEL` 及 `ANTHROPIC_DEFAULT_*_MODEL` 会传给 Claude Code 子进程，第三方 Anthropic 兼容服务因此使用你指定的模型 ID。
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
设置 `FACTORY_DAILY_IMPROVEMENT=1` 时，持续模式还会执行每日评审反馈改进，日志中的内部任务 `issue: 0` 属于该流程。
真实运行可能修改 GitHub 标签、评论、分支、PR，并在满足条件时合并，建议先使用测试仓库。
自动合并默认关闭，只有显式设置 `FACTORY_AUTO_MERGE=1`，且同一 commit 同时通过代码评审和行为验证后才会合并。
整条流水线没有固定总时长限制，旧配置 `FACTORY_RUN_TIMEOUT_MS` 已停用，保留该配置也不会终止 worker。
`FACTORY_AGENT_TIMEOUT_MS` 继续限制单次 agent 调用，默认 900000 毫秒，超时会终止该次调用并进入现有恢复流程。
`FACTORY_COMMAND_TIMEOUT_MS` 控制普通单次命令的上限，默认 120000 毫秒，最大 7200000 毫秒，与流水线总时长独立。
检查、安装、构建和测试使用各自的超时档位，并受 `FACTORY_VALIDATION_TIMEOUT_MS` 限制；模型可以请求调整单次超时，但不能突破对应上限。
超时回执保留 `timedOut`、终止信号、预算和实际耗时，超时不等同于产品断言失败。
`daemon.log` 中的 `agent-progress` 记录 issue、角色、运行 ID、调用开始和结束、工具开始和结束，以及等待期间每 30 秒一次的心跳。
心跳包含当前状态、累计耗时和距最近一次 CLI 事件的时间，不代表模型或工具已经成功。
进度日志不包含提示词、模型正文、工具参数或工具输出。
内部恢复记录保存到独立的 GitHub ref `refs/heads/factory/state/issue-<n>`，不会新增 Issue 状态评论，也不会修改产品文件。
正文保存在 Git blob 中，每次更新通过带哈希的版本链和非强制 ref 更新提交，中断上传由本地恢复日志续传。
代码审查与行为验收返回后，先将结果及对应代码版本写入检查点，再执行阶段结束保存。
已加载可信父版本时，状态保存先将完整待上传记录落盘，再访问 GitHub；网络故障后的恢复会核对实时租约、父哈希和版本，不能用本地记录覆盖新的远端状态。
GitHub 单次请求上限为 30 秒，连接建立上限为 10 秒；Git ref 读取遇到暂时性故障最多重试 3 次，权限错误不在单次调用内重试。
请求重试日志记录故障阶段、底层连接错误码、实际耗时、对应超时和下一次重试，不记录凭据或请求地址。
已有恢复评论和分片保留为只读历史，首次更新自动衔接新存储；所有恢复读取器和写入者应同步升级，旧版本不能读取新 ref。
worker 未正常退出或运行环境故障时，daemon 保存独立的调度隔离日志，不把它当作 GitHub 业务状态或完成证明。
相同业务输入、产品产物和运行版本下的执行故障按指数退避重试，`FACTORY_INFRA_RETRY_BASE_MS` 默认 60000 毫秒，`FACTORY_INFRA_RETRY_MAX_MS` 默认 1800000 毫秒。
新的业务输入、产品产物、经核对的外部操作恢复或运行配置/版本可以提前恢复执行，daemon 重启不会清除隔离。
失败保存导致的 checkpoint 版本、时间戳、运行 ID、工厂标签和不同错误文本均不会重置退避次数。
CLI 请求超时、中断、取消和后端异常在统一执行边界归入运行故障，保留原阶段和会话，不进入产品失败计数或需求补充流程。
运行故障归属和命令失败诊断随 GitHub 恢复状态保存，重启后继续用于原阶段恢复和针对性修复。
全仓库历史恢复审计在后台单独运行，不阻塞待处理 issue；每个 worker 执行前仍须读取自己的最新状态并取得租约。
审计日志记录开始、等待、完成和失败，同一时刻只允许一个审计任务。
调度优先处理开放 issue，确认任务可运行后立即入队，不等待其他 issue 的状态扫描；同一轮不会重复派发同一个 issue。
已处理的业务阻断返回工作流结果，不能同时向 daemon 发出未捕获执行故障，避免重复发布相互矛盾的说明。
GitHub issue comment 说明故障代码、恢复检查和操作条件，系统 comment 不会被当作用户新回复。
每日维护任务同样受隔离约束，失败不会阻止普通 issue 调度；本地调度日志损坏或写入失败需要修复磁盘、权限或损坏记录，不能以本地旧状态替代 GitHub。
行为验收的收据和截图存放在独立状态目录的 evidence 命名空间，不写入产品工作树。
状态目录位于产品工作树内时使用 Git 元数据区；没有 Git 的诊断上下文使用隔离的临时目录，不能把临时目录保留视为长期归档保证。
历史未跟踪证据只在匹配可信恢复历史、运行 ID、收据 ID 和文件清单后迁移，逐文件校验外部副本后移除原副本。
行为验收失败默认重新验收，不直接触发产品重写。
执行收据通过不等于独立语义验收通过。
正向验收要求完整的独立判断，并绑定本次运行与全部检查的内容哈希；服务不可用、关闭判断、缺失答案或判断分歧不能授权完成。
旧检查点缺少该判断证明时，不能用旧 verified 状态直接合并或关闭 issue，需要重新验收。
只有独立判断确认的产品缺陷、实际失败 AC 收据及当前规格/实现绑定全部匹配，才进入实施修复。
证据或工具问题在同一上下文及有效 AC 进度下尝试两次仍未通过时，保留现场并发布具体恢复要求。
工厂流程标签、随机运行 ID 和新的说明文本不算进展，恢复预算保存在可信检查点中。
跟踪文件、未知文件、符号链接和冲突副本不会被当作工厂产物覆盖，产品的干净工作树要求保持不变。
代码审查材料中的短文件名或路径后缀只在唯一匹配时解析为完整仓库路径，同名歧义、缺失文件及缺失行号会记录在诊断中。
没有选入任何代码片段时，工厂不会发送空代码的独立判断请求。
审查证据不足会保留实现并退避后让 reviewer 补齐材料，不要求 Issue 作者修复审查证据，也不会因此重新开发产品或绕过合并门禁。
当标签为 `needs-info` 时，daemon 会等待 Issue 正文或评论变化；用户补充信息后会自动重新分诊并继续流程。
GitHub-ref 模式下，daemon 在每个 Issue 处理开始时会在远端 `refs/heads/factory/leases/issue-N` 占位；进程被 `kill -9` 或崩溃时该 ref 可能残留，导致后续每次轮询都报 `issue-lease-busy`。设置 `FACTORY_LEASE_STALE_MS` 启用自动回收（毫秒，默认 `0` = 关闭）：
- `0`（默认）：禁止自动回收，孤儿需手工 `gh api --method DELETE repos/<owner>/<repo>/git/refs/heads/factory/leases/issue-N`。
- `3600000`（1 小时）或 `7200000`（2 小时）：只用于明确允许按租约年龄回收的部署。
流水线没有总时长上限，不能仅凭运行时间判定 worker 已失效；长任务应保留默认 `0`，避免按年龄误回收。

每次 GitHub `acquire` 使用 4 次 API 调用，并在远端仓库中产生一个带 `factory-lease issue=... ts=...` 消息的悬挂 commit 对象。
专用 commit SHA 是租约 receipt 的所有权令牌，释放前会再次读取远端 ref，只有 SHA 一致时才删除。
释放失败或所有权不匹配时会在 `daemon.log` 中产生 `ERROR lease-release-failed` 行。

测试或运维恢复时，可在 `factory start` 时附加 `--force`。
生产模式只使用 GitHub-ref 租约，会扫描所有 open issue 和 maintenance lease `0`，清理完成后才开始轮询。
显式离线 fixture 模式使用进程内互斥，不创建文件租约。

```bash
factory start --force
```

该标志会透传给 daemon（`scripts/factory-daemon.mjs --force`），daemon 启动后调用 `manager.clear()` 依次删除匹配的远端 ref，不存在时跳过。
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
issue 完成后文件进入 `.processed/`；失败或仍在等待(计划重试、等待人工)时文件返回 inbox，供后续轮询恢复。

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
.factory/sessions/14.json
.factory/recover/14.json
.factory/traces/
.factory/state-14.json
.factory/state-improve-review-pr.json
.factory/sessions/2025-01-15T12-34-56-789Z-12345-a1b2c3-close.json
```

生产 issue 状态以 GitHub issue 和仓库内的版本化恢复 ref 为准，orchestrator、daemon、面板和 freshness 共用这一读路径。
恢复 ref 使用仓库写权限保护，历史恢复评论仍按可信作者名单验证。
原有 `.factory/issues/<n>.json` 仅供显式离线 fixture 和只读迁移预检使用，生产模式不回退读取它。
`.factory/sessions/<n>.json` 只保存私有代理会话，不上传到 issue。
共享的 `factory/AGENTS.md` 保存当前状态、发现摘要、技能约定和交接信息；完整审查和恢复材料保存在 `factory/checkpoint.json`，由代理按需读取。
较长的交接记录保存在 `factory/handoffs/`，共享文件只保留摘录和索引；历史材料不会随上下文压缩被删除。
工具桥按 MCP 客户端连接管理会话，CLI 续接、输出修复和前台子 agent 可独立连接同一阶段的固定工具集合；阶段退出后统一关闭连接。
`read_file` 对大文件显式分页，返回 `truncated` 和 `nextOffset`，也支持 `jsonPointer` 读取 JSON 材料的指定部分；完整材料不会因分页被删除。
验收 agent 使用 `write_acceptance_fixture` 写入临时测试源文件，避免 shell 重定向和多层转义。
工具只创建带本轮前缀的新文件，不能覆盖项目已有文件；完整源文件归档到验收证据目录，结束或恢复时按内容哈希清理，发生外部修改则保留现场。
CLI 报告上下文窗口和当前用量时，下一次请求在用量达到窗口的 80% 后先压缩原会话。
未提供上下文窗口，或供应商实际限制更低时，收到上下文超限错误后仍会在原会话压缩并续接。
每次请求最多执行一次压缩和一次续接，压缩必须由 CLI 的 `compact_boundary` 事件确认；未确认或再次失败则保存现场，交给运行恢复调度。
会话按 `issueId + agent 身份` 独立保存，同一 agent 的修订、重试和 worker 重启继续原会话。
提交号和 runId 只标识本次任务及验收证据，不重置会话；backend 和 worktree 路径用于防止错误续接。
会话 ID 在 CLI 启动前持久化，spec 的 PRODUCT 和 TECH 是同一 spec agent 的连续对话。
不同 agent 通过 worktree 中的 `factory/AGENTS.md` 交换当前背景和交接记录，各自拥有独立会话。
工厂在根目录缺少 `AGENTS.md`、`CLAUDE.md` 时生成入口，保留已有项目指令，并在每次调用前自动加载它们和共享背景。
相关技能及资源复制到项目 `skills/`，按 agent 分配并在启动时强制加载规则，已有项目技能和人工修改优先保留。
agent 使用 `update_handoff` 追加重要决定、文件位置、已验证事项和剩余工作，评审 agent 无需获得产品文件写权限。
生成文件仅通过本地 Git exclude 排除，不进入产品提交，并能跨越 `git clean -fd` 保留。
复杂任务可在该 agent 的 Claude Code 会话内使用 `factory-task` 子 agent，父 agent 汇总结果并等待子任务完成。
该子 agent 定义使用 CLI 的 JSON 文件参数，需要 Claude Code 2.1.281 或更高版本。
历史对话和共享记录不能替代当前提交的审查、测试及工厂执行收据。
`.factory/recover/<n>.json` 是更新恢复 ref 前持久化的上传日志，不是读取主存储。
网络或凭据错误会阻止执行，不能用本地旧状态替代 GitHub。
混用个人 token 和 GitHub Actions 时，必须把全部可信写入者配置为 `FACTORY_STATE_WRITERS=你的登录名,github-actions[bot]`。
不要把不可信 issue 作者加入该名单。
外部操作的 intent/outcome 保存在恢复 ref 中，本地收据只保留 unknown 结果。
无法确认的外部操作会在 issue comment 中说明所需操作，不能自动重复推送、建 PR 或合并。
核对远端证据后，可在工厂安装目录运行 `node scripts/resolve-external-op.mjs <issue> <operation-id> succeeded|failed "核对的远端证据"`。
该命令需配置 `FACTORY_GH_REPO`、`GH_TOKEN` 和 `FACTORY_STATE_DIR`，会获取 GitHub 租约并追加审计记录。
只有确认操作未成功时才选择 `failed`，允许下一次运行重试。
`.factory/state-<n>.json` 是 daemon 的运行摘要，保存 `exitCode`、`summary`、`stdout`、`stderr` 和实际工作目录。
非零退出会输出 `ERROR pipeline-failed` 和 stderr 尾部，不会只留下空摘要。
若仍出现 `bad option: --issue`，检查是否还在使用旧 daemon 副本，然后重新安装并重启。
GitHub 轮询最多读取 1000 个打开的 Issue，按创建时间处理，并继续领取可恢复的工厂标签。
`needs-info` 和 `wait-to-implement` 在正文及评论不变时保持等待，内容变化后会自动重新分诊。

### 会话关闭回执（Session Close Receipt）

每次 `factory start`（包括 `--once`、持续模式和收到信号后的清理退出）都会在解析后的状态目录（默认 `.factory`，可用 `--state-dir` 覆盖）下写入**恰好一份**机器可读的关闭回执，路径固定为 `.factory/sessions/<sessionId>-close.json`。
文件名以可排序的时间戳开头，因此 `ls -1 .factory/sessions/` 按时间顺序列出各次会话，最新的关闭排在最前。
回执用临时文件加 `rename` 原子落盘：被 SIGKILL 中途打断时，绝不会留下半个 `-close.json`，只会看到一个遗留的 `.json.tmp`。
`--state-dir` 同样决定回执位置，回执只会落在 `<stateDir>/sessions/`，不会写到其它目录。

回执必填字段为 `sessionId`、`mode`、`startedAt`、`endedAt`、`durationMs`、`exitCode`、`exitReason`、`issueNumber`、`stateFile`，另含可选的 `pid`（用于对照 `.factory/daemon.pid`）与 `factoryVersion`。
判断一次关闭的类型只看 `exitReason`，取值固定为：

- `idle`：本轮未发现可处理的 issue，正常退出（`exitCode` 为 0，`issueNumber` 与 `stateFile` 均为 `null`）。
- `processed`：本轮处理了编号为 `<n>` 的 issue（`exitCode` 为 0，`stateFile` 指向 `.factory/state-<n>.json`）。
- `failed`：本轮以非零 `exitCode` 结束，请结合 `.factory/daemon.log` 里的 `ERROR` 行与 `.factory/state-<n>.json` 定位失败原因。
- `signaled`：持续模式收到 `SIGINT`/`SIGTERM` 后走正常清理路径退出，`exitCode` 为翻译后的 `128+信号号`（`SIGTERM` 为 143）。
   在 Windows 上从外部发送的信号会强制结束进程（等同 SIGKILL，不可捕获），此时不会产生回执；交互式 Ctrl+C 走的是 SIGINT 路径，可正常产出 `signaled` 回执。

每份回执落盘成功后，`.factory/daemon.log` 会追加**恰好一行** `session-closed <sessionId> <exitReason>`，便于 `grep session-closed .factory/daemon.log` 与回执目录互相印证。
回执默认无限期保留，暂不做轮换；如需清理可安全地删除 `.factory/sessions/`，删除它不会影响 daemon。

## 架构与其他运行方式

六个 Agent 位于 `src/agents/`，技能位于 `skills/`，编排器位于 `src/orchestrator/`。
正常运行中的分类、规格、实现、代码评审、行为验证和评审改进经过配置的代理后端，Jev 负责结构化判断。
任务就绪状态和验收方式由代理与 Jev 根据需求语义和实际证据判断，不使用 Issue 关键词决定任务类型、浏览器要求或终止状态。
Jev 不可用时 triage 可以调用代理后备判断；后备代理也失败时保留错误并进入有预算的恢复流程，不生成固定规则的业务结论。
共享判断入口收到 Jev HTTP 451 时，使用当前证据开启独立的 Claude Code 会话完成 LLM 后备判断，不复用执行者的对话。
后备判断严格校验全部问题、答案类型及置信度，并记录实际后端、降级原因和原始判断证据；调用或校验失败仍保持未批准，不重复执行产品验收来代替判断。
已有因 HTTP 451 暂停的代码审查或行为验收，只在规格、实现和证据仍匹配时恢复判断，其他服务错误继续沿用原恢复策略。
代码继续核验证据来源、退出码、覆盖绑定、权限和状态一致性；合并置信度路由仍按工厂策略执行。
Spec 审核拒绝直接进入定向修订，保留完整 findings、review 说明和修订历史；仅 TECH.md 存在问题时保留 PRODUCT.md。
Spec 审核的 Jev 输入绑定当前 PRODUCT.md、TECH.md、diff 和作者需求，并携带完整 findings；历史工厂评论不参与本轮判断。
B4 与 reviewer 的分歧只记入审计，不能单独把 APPROVE 改为 REJECT。
已有 blocking/important finding 保持阻断；B5 将建议升级为阻断时必须引用具体文件和行号，并满足置信度要求。
发布评论和 `spec-review-gate` 日志分别记录 reviewer、Jev 与最终门禁结论，并附当前快照标识，便于核对和恢复。

Issue 的待执行标签与运行标签分别表示排队和当前工作，阶段开始前同步 GitHub 标签及 Project 状态。

| 环节 | 待执行标签 | 运行标签 | 运行时 Project 状态 |
| --- | --- | --- | --- |
| 分类 | 无流程标签 | `triaging` | In progress |
| 编写规格 | `ready-to-spec` | `writing-spec` | In progress |
| 审核规格 | `ready-to-spec` | `reviewing-spec` | In review |
| 合并规格 | `ready-to-spec` | `merging-spec` | In progress |
| 实现及修订 | `ready-to-implement` / `changes-requested` | `implementing` | In progress |
| 代码评审 | `review-needed` | `reviewing` | In review |
| 行为验证 | `ready-to-merge` / `verify-failed` | `verifying` | In progress |
| 合并实现 | `verified` | `merging` | In progress |
| 完成 | 清除流程标签并关闭 Issue | 无 | Done |

阶段结束后按审核或验收结果推进，拒绝时进入对应修订阶段，等待人工处理时保留具体原因。
daemon 确认 worker 退出后，在仍持有租约且状态可读取时把未结束阶段标记为 `interrupted`，恢复待执行标签，再按原有恢复机制等待重试。
GitHub 或状态存储不可用时保留恢复记录并报告同步失败，不伪造已同步状态。
已通过审核的规格在合并阶段中断后直接继续合并，保留原提交和审核依据。
面板使用最近一次实际阶段记录显示运行状态，重试不会继承上一轮的结束时间，也不会把未执行的前置阶段显示为通过。
Agent 自动修复不设次数预算，包括推理错误、输出格式、内容合同、typesafe veto、rubric 重复失败和累计失败次数。
`FACTORY_MAX_AGENT_FAILURES` 与 `FACTORY_MAX_IMPL_ATTEMPTS` 已停用，兼容配置字段为 `0`，表示不限次数。
旧检查点因 spec 修复预算耗尽而停在 `needs-info` 时，新版 daemon 会恢复修订，无需作者回复。
网络重试、单次执行超时、权限检查和真正缺少用户输入的等待仍各自生效，审核和验收标准保持强制执行。
命令超时按执行任务区分，不使用整条流水线的总时长预算。

| 命令类别 | 默认单次超时 |
| --- | --- |
| 普通命令 | 2 分钟 |
| lint、typecheck、format:check | 5 分钟 |
| 构建、安装依赖 | 10 分钟 |
| 测试、其他工厂验证命令 | 20 分钟 |

`FACTORY_COMMAND_TIMEOUT_MS` 控制普通命令上限，`FACTORY_VALIDATION_TIMEOUT_MS` 控制验证命令上限，二者独立。
结构化 `validationCommands` 可指定正整数 `timeoutMs`，用于有依据的单条命令调整，但不能超过验证上限。
工厂验证日志记录具体命令、工作目录、超时类别、开始、心跳、结束、耗时和退出结果。
命令超时后先终止其进程树，保存输出、信号和耗时，再按退避时间回到原阶段诊断。
诊断需要区分运行缓慢、依赖或网络等待、交互输入和测试卡死，不能仅凭超时认定产品失败或要求作者补充需求。
实现验证超时后保留当前分支中的未提交修改，下一轮针对原命令和已有实现修复，验证通过前仍禁止发布。
旧版因 `configured command execution budget exhausted` 停到 `needs-info` 的可信检查点会自动恢复，无需作者回复。
确定性代码只负责工具权限、输出结构验证、状态转换和发布门禁。
`factory install` 还接受 `--mode cloud` 和 `--mode both` 并复制 GitHub Actions 模板，但本次本地 CLI 验收不包含云端 workflow 的真实执行。
不要在未协调的情况下同时启用云端和本地处理同一仓库。

## Agent 后端选择

生成阶段当前只支持 `claude-code` CLI, 默认值也是 `claude-code`。
`codex-cli`、`pi-cli`、`embedded` 和 `typesafe` 不能配置为 Agent 后端, 配置时会立即报错。
`typesafe` 仍可作为独立的只读 judgment 服务处理结构化 verdict。
所有生成阶段经 `AgentRuntime.runStage(request, ctx)` 调度。
Claude CLI 不支持工厂的 `StageRunRequest.tools` 回调, 带有该字段的请求会在启动子进程前失败。
实现阶段先从修改前的 Git 基线发现独立工程门槛，在 CLI 结束后执行这些门槛和模型附加命令，验证通过后才发布提交和 PR。
清单、锁文件及 GitHub Actions 工作流记录 Git blob 哈希，CI 记录目录、运行时、矩阵、条件和检查来源，验证计划随实现结果持久化。
可解析的字面 CI 命令通过 `program/args/cwd` 执行，不假设项目使用 npm 或固定子目录。
动态命令、特殊 shell、未支持的 action、环境变量、容器或服务等执行缺口会在启动实施代理前明确阻断，不允许模型声明的替代检查将其冒充为通过。
本地执行只是 CI 的投影，不证明全部操作系统或运行时矩阵已通过，准确合并候选的远端 CI 证据仍需独立确认。

### 关键环境变量

| 变量 | 用途 | 默认 |
| --- | --- | --- |
| `FACTORY_AGENT_BACKEND` | 全局默认后端, 当前仅接受 `claude-code` | `claude-code` |
| `FACTORY_AGENT_OVERRIDES` | 按 role 覆盖的 JSON 对象 | `{}` |
| `FACTORY_AGENT_TIMEOUT_MS` | 每次运行的超时 | `900000`(15 分钟) |
| `FACTORY_AGENT_STREAM` | agent 执行过程转写模式: `off` / `on` / `full` | `on` |
| `FACTORY_AGENT_STREAM_DIR` | 转写文件所在目录 | `<state>/streams` |
| `FACTORY_AGENT_STREAM_MAX_BYTES` | 单个转写文件的字节上限 | `8388608`(8 MiB) |
| `FACTORY_CLAUDE_COMMAND` | Claude Code CLI 可执行 | `claude` |
| `FACTORY_CLAUDE_MODEL` | Claude Code 模型名 | 空(由 CLI 决定) |
| `TYPESAFE_API_KEY` | typesafe.ai 的 API key;启用 `typesafe` judgment 后端必需 | 空 |
| `FACTORY_TYPESAFE_MODEL` | Jev 模型名 | `jev-latest` |
| `FACTORY_TYPESAFE_OFF=1` | 显式关闭 `typesafe`，生成仍可执行，但不能授权独立行为验收通过 | 关 |

`typesafe` 只承担 judgment(Choice / Score / Noul),不替代任何生成阶段。
`claude-code` 承担散文、代码和内联评论等生成任务。
TYPESAFE_API_KEY 无条件转发给 worker(2026-09-22 fix),不依赖 per-role override。

### Agent 执行过程转写

Claude Code CLI 以 `--output-format stream-json` 返回 agent 的完整执行过程。
运行时原本只解析这条流来取最终产物,中间过程(模型正文、工具调用、工具输出)解析后即丢弃,运维只能看到工具名和耗时这类元数据。

`FACTORY_AGENT_STREAM` 打开一条独立的转写通道,与元数据通道互不影响:

- `on`(默认)写入模型正文、工具调用、工具输出和系统事件,不写入模型思考过程与逐 token 增量。
- `full` 在 `on` 的基础上追加模型思考过程与增量,仅建议本地排查时使用。
- `off` 完全关闭,CLI 流解析后即丢弃,行为与引入该特性前一致。

转写落在 `<state>/streams/issue-<n>-<role>-<runId>.ndjson`,每个 stage run 一个文件,并发 run 互不交错。
daemon 会把 worker 的输出同时回显到控制台,因此 `factory start` 的终端里能实时看到 `[agent-stream]` 行,内容同样进入 `.factory/daemon.log`。

落盘前会做两件事:一是按凭据形态抹除 `TOKEN` / `SECRET` / `PASSWORD` / `API_KEY` / `AUTH` 类环境变量的值以及 `Bearer` 令牌,二是对单条记录和单个文件分别设上限。
控制台只输出有界的一行摘要,完整内容留在文件里。

### 从失败中学习(自我进化)

每个 agent 在运行中出错或未通过校验时，工厂会立刻提炼经验并改进该 agent，而不是等到每日批处理。

| 观察到的失败 | 学习的 agent |
| --- | --- |
| 阶段抛出校验 / 合同 / 推理类错误 | 该阶段的 agent |
| 输出不符合合同(首次修复前) | 该 agent |
| Spec 审核 REJECT | spec |
| 代码评审 REJECT | implementation |
| 评审确认技术规格缺陷 | spec |
| 行为验收证明产品缺陷 | implementation |
| 行为验收证据不足 | verify-behavior |

流程：

1. **过滤**：状态存储故障、网络错误、超时、取消等基础设施故障不是 agent 的错误，不会产生经验。
2. **反思**：独立、无工具、不复用 agent 会话的 `lesson-distiller` 调用分析根因，输出至多一条可推广的规则，或明确拒绝(一次性、环境问题、需要作者补充)。
3. **存储**：经验按 agent 存在 `<state>/lessons/<role>.json`，相似规则合并证据而不是增加条目；每个事件追加到 `episodes.jsonl` 便于审计。
4. **应用**：每次调度时把该 agent 评分最高的经验作为独立的、按内容哈希的用户消息交给它，同一 issue 的下一次重试即可使用上一次失败学到的规则，系统提示保持字节稳定。
5. **评估**：经验在场时 agent 的工作通过关卡记为成功；同类失败再次发生记为复发。复发明显多于成功的经验会被退役，反思时会被要求重写而不是重复。
6. **固化**：`factory lessons promote` 把被证明有效的经验写入对应 `skills/<agent>/SKILL.md` 的标记区段(默认只预览，`--write` 才写入)，经人工审核后提交即成为永久技能。

经验只能增加谨慎，不能削弱检查：提示词要求如此，代码也会拒绝任何要求跳过或关闭测试、校验、评审、验收、合同或安全规则的经验文本。
学习本身失败(反思服务不可用等)只记录日志，绝不影响流水线。

```bash
factory lessons list --state-dir .factory                 # 查看各 agent 学到的经验及效果统计
factory lessons promote --state-dir .factory              # 预览可固化到 SKILL.md 的经验
factory lessons promote --state-dir .factory --write      # 写入 skills/<agent>/SKILL.md
```

| 变量 | 用途 | 默认 |
| --- | --- | --- |
| `FACTORY_LEARNING` | `0` / `off` 关闭从失败中学习 | 开 |
| `FACTORY_LESSONS_DIR` | 经验存储目录；多个目标仓库可共享同一目录 | `<state>/lessons` |
| `FACTORY_LESSONS_MAX_ACTIVE` | 每次调度交给 agent 的经验条数上限 | `8` |
| `FACTORY_DAILY_IMPROVEMENT` | `1` 时 daemon 仍每日运行基于人工 PR 评论的 review-pr 改进 | 关 |

每日评审反馈改进不再是自我进化的主路径，默认关闭；`factory start --daily` 仍可按需运行。

### 路由层:`runtime/decisions.yaml`

per-action 的 confidence / freshness 阈值集中在
[`runtime/decisions.yaml`](runtime/decisions.yaml),启动期由
`src/core/decisions.ts` 加载,orchestrator 经 `src/core/decision-router.ts`
读取。当前生产配置覆盖五个 action:

- `freshness.skip` —— A1 freshness `Noul` 阈值(`noul_yes_max: 0.20`)
- `triage.apply_label` —— triage verdict 的 auto / confirm / escalate 分档
- `review-pr.merge_pr` —— 合并 confidence 与 blocking findings 上限
- `supervisor.retry` —— 重试决策;驱动者是 `src/core/routing-decision.ts` 的 `decideRouting`(deterministic,issue #36 后取代 LLM supervisor)
- `operator.escalate` —— 操作员升级路径

> `supervisor.retry` 的 schema 名字被刻意保留(`runtime/decisions.yaml` 不动字段),以避免破坏已经在用这个 action 的 operator `.env`;执行层自 0.3.0 起是 deterministic,不再调用 LLM。

malformed `decisions.yaml` 是启动期失败(F01 级别),不会静默回退默认值。
详细架构与 CJK fallback 契约见 [`docs/decision-architecture.md`](docs/decision-architecture.md)。

### 按角色指定 Claude Code 模型

```bash
FACTORY_AGENT_OVERRIDES='{"review-pr":{"backend":"claude-code","model":"claude-sonnet"}}' \
FACTORY_CLAUDE_COMMAND=/path/to/claude \
factory start --once
```

未覆盖的角色继续使用 Claude Code CLI 的默认模型。

### 凭据不外泄

`runtime/agent-backends.mjs::agentWorkerEnvironment(env, config)` 仍是
GH_TOKEN / GITHUB_TOKEN 不外泄到任何子进程的唯一入口,
当前生成后端为 `claude-code`。
`TYPESAFE_API_KEY` 在 `typesafe` 适配器内仅走 `Authorization: Bearer` header,
不出现在请求 body,也不会被记录到结构化日志(2026-09-22 显式移除 body 字段)。
回归测试在 `test/agent-backends-environment.test.mjs`。

### 详细规范

`specs/2026-09-16-unified-agent-runtime/requirements.md` 给出完整契约,
`specs/.../plan.md` 记录 Group 1-4 的执行记录与已标注的偏差。

## License

MIT
