# Phase 11 — Unified Agent Runtime: Code Quality Review

**审查人**: code-reviewer (delegated by spec-review)
**审查日期**: 2026-09-16
**审查范围**: branch `phase-1-unified-agent-runtime` vs `origin/main` (150 files, ~1,481 line diff on `src/orchestrator/index.ts`)
**核心切片**: Slice A.1 / A.2 / B.1 / B.2 — Backend Registry, Embedded Adapter, Claude Code CLI Adapter, Review-PR End-to-End
**审查方法**: confidence-based filtering,only reporting issues that are both high-confidence AND high-impact

---

## 总评

**评级: REQUEST CHANGES**

整体实现质量高,架构边界清晰,测试覆盖充分(registry / embedded / claude-code / log-shape / environment / e2e 五套测试都到位),并有针对性地保留了 commit 48cdd0e 的 secret-leak 保护(`test/agent-backends-environment.test.mjs`)。

发现 **1 个 HIGH**、**5 个 MEDIUM**、**6 个 LOW**,其中 1 个 HIGH 是 Claude Code 后端在 spawn 子进程时 **没有将 `agentWorkerEnvironment` 白名单生效**,直接退回到 `process.env`,**回退了 commit 48cdd0e 的保护**。该问题必须修复后再合并。其余问题多为可维护性/可读性层面。

**优点**:
- 类型契约严格分离:`runtime/agent-backends.d.mts` 是 source of truth,`src/core/agent-runtime.ts` 通过 `import type` 再 re-export,`re-export value from .d.mts` 的反模式被显式拒绝。
- capability gate 在 spawn 前执行,`READ_ONLY_ROLES = ["review-pr"]` 集中维护,违约时 `failed + retryable=false`,不会误派发 mutating role。
- 环境白名单覆盖了所有 4 个 backend,`GH_TOKEN`/`GITHUB_TOKEN` 不泄漏的回归测试(48cdd0e)被显式保留并增强。
- `runHarness` 延迟导入 `@earendil-works/pi-agent-core`,在配置校验未通过前不付出加载成本。
- 一次性 corrective retry 在 `parseError` 路径上复用 `contractShapeHint(opts.outputContract)`,契约与系统提示同一来源,杜绝"两次提示给出不同 shape"。
- `extractVerdict`、`appendEvent`、`reroutePreservedFields` 等纯函数被显式 `export` 给测试,避免测试反弹到 orchestrator 内部。
- 文档与代码同步:`docs/harness-architecture.md` 记录了"目标架构 vs 落地边界",spec review 的 PLAN-VALIDATION 双轨印证。

---

## Critical / High

### H-1 [HIGH · Security · 回归 commit 48cdd0e 的保护] `runtime/claude-code-backend.mjs:84-86` + `src/core/agent-runtime.ts:397-399`

**问题**:`runClaudeCodeStage` 在 `options.env` 未提供时退回到 `process.env`:
```js
const env = { ...(options.env ?? process.env) };
delete env.FACTORY_AGENT_BACKEND;
delete env.FACTORY_AGENT_OVERRIDES;
```

调用链:
- `src/core/agent-runtime.ts::claudeCodeAdapter` 调用 `runClaudeCodeStageFromConfig(config, executable, request, { abortSignal })` — **没有传 `env` 字段**。
- `runClaudeCodeStageFromConfig` 把 `extra.env` 直接转发给 `runClaudeCodeStage` — `extra.env` 是 `undefined`。
- 因此 `runClaudeCodeStage` 走到 `options.env ?? process.env` 分支,把整个 `process.env` (包括 `ANTHROPIC_AUTH_TOKEN`、`ARK_API_KEY`、`CODEX_API_KEY`、`MOONSHOT_API_KEY`、`GH_TOKEN` 等) 复制给 `claude` 子进程。

`runtime/agent-backends.mjs::agentWorkerEnvironment` 已经实现了 backend-specific 白名单(`test/agent-backends-environment.test.mjs` 覆盖了 `claude-code` / `codex-cli` / `pi-cli` 三套白名单,以及 `GH_TOKEN`/`GITHUB_TOKEN` 的回归),但这个白名单 **在 Claude Code 后端 spawn 路径上没有被使用**。

注释(`claude-code-backend.mjs:292-302`)声称:
> "Convenience wrapper that wires `runClaudeCodeStage` to the runtime backend configuration (`runtime/agent-backends.mjs`) and the `agentWorkerEnvironment` credential whitelist."

但实现里完全没有调用 `agentWorkerEnvironment`。**文档与实现不一致**,而且这一不一致正好回退了 48cdd0e 修复的核心保护。

**复现步骤**:
1. 启动 factory daemon,环境里同时存在 `ANTHROPIC_AUTH_TOKEN`、`CODEX_API_KEY`、`GH_TOKEN`、一个无关服务密钥 `OTHER_SERVICE_KEY=xxx`。
2. 通过 `FACTORY_AGENT_OVERRIDES='{"review-pr":"claude-code"}'` 把 review-pr 路由到 claude-code 后端。
3. 观察 spawned `claude` 子进程的 env(`claude --print --output-format json ...`):`OTHER_SERVICE_KEY=xxx` 与 `GH_TOKEN=ghp_xxx` 全部可见。

**修复建议**(二选一,推荐前者):

**方案 A(在 `runClaudeCodeStageFromConfig` 里显式使用白名单)**:
```js
import { agentWorkerEnvironment } from "./agent-backends.mjs";
export async function runClaudeCodeStageFromConfig(config, executable, request, extra = {}) {
    const override = config.overrides[request.role];
    const model = override?.model || config.backends["claude-code"]?.model || "";
    const env = extra.env ?? agentWorkerEnvironment(process.env, config);
    return runClaudeCodeStage(request, { executable, model, timeoutMs: config.timeoutMs, env, abortSignal: extra.abortSignal });
}
```

**方案 B(在 `claudeCodeAdapter` 注入,让 `extra.env` 非空)**:
```ts
return runClaudeCodeStageFromConfig(config, backendCfg.executable, claudeRequest, {
    abortSignal: request.abortSignal,
    env: agentWorkerEnvironment(process.env, config),
});
```

**推荐方案 A** — 集中点更靠后端,且与函数文档承诺一致。

**验证修复的方法**:
- 给 `test/agent-backends-environment.test.mjs` 增加一个新 case:`claude-code` 被选中时,任何 `claude` 子进程收到的 `env` 必须不包含 `GH_TOKEN`/`GITHUB_TOKEN`/任何 `process.env` 中不在白名单的 key。
- 在 `claude-code-backend.test.mjs` 中用一个 stub 打印它看到的 env(类似 `process.stderr.write(JSON.stringify(process.env))`),断言无 `GH_TOKEN`、无 `OTHER_SERVICE_KEY`。

---

## Medium

### M-1 [MEDIUM · Readability · 死代码 + 误导性注释] `src/orchestrator/index.ts:1010-1012`

`prepareReviewArtifacts` 函数体中残留三行注释,明显是某次重构的中间产物:
```js
// (Full body of prepareReviewArtifacts follows below in the
// orchestrator's review pipeline; see further down in this file.)
// ("Target checkout is not clean").
```

该函数体已经完整(`git diff origin/main HEAD -- src/orchestrator/index.ts` 第 1007-1017 行),不需要"见下文"。`"Target checkout is not clean"` 来自更早的 commit,显然是被错误粘贴。

**修复建议**:删除三行注释。`git blame` 已经显示它们来自同一个 refactor commit (`eededa3` wip: pre-Phase-11 baseline)。

---

### M-2 [MEDIUM · Readability · 死代码 / `void changed` 误导] `src/orchestrator/index.ts:546-557`

```ts
const changed = JSON.stringify([state.issue.title, state.issue.body, state.issue.comments]) !== JSON.stringify([issue.title, issue.body, issue.comments])
  || latestVoiceIsAuthor(issue.comments);
state.issue = issue;
state.agentMode = 'llm';
if (state.specLoopVersion !== SPEC_LOOP_VERSION) { ... }
void changed;   // <-- 死代码
```

`changed` 在 633 行和 641 行的条件分支中实际被使用,但这一行 `void changed;` 显式地把它当未使用变量对待 — 这两个用途互相矛盾。Linter 看到 `void changed` 会认为这是个 no-op,但其实只是被 TypeScript 静默通过。

**修复建议**:删除 `void changed;`。如果作者意图是"这一处不需要 changed 但条件分支用",改成普通留白即可。

---

### M-3 [MEDIUM · Readability · 重复模型解析] `runtime/claude-code-backend.mjs:303-313` vs `src/core/agent-runtime.ts:385-395`

`claudeCodeAdapter` 已经在 caller 侧解出了 `model: resolved.selection.model` 并写入 `claudeRequest.model`,但 `runClaudeCodeStageFromConfig` 又用 **不同的公式** 重新解出 `model`:
```js
const model = override?.model || config.backends["claude-code"]?.model || "";
```

注意:这里 `config.backends["claude-code"].model` 来自 `FACTORY_CLAUDE_MODEL` env var,而 `resolved.selection.model` 来自 `selectAgentBackend()` 内部对 `config.backends[selected.backend].model` 的合并。两条解析路径在大多数情况下结果一致,但当 `selected.backend === "claude-code"` 而 `overrides[role]` 仅有 `backend` 没有 `model` 时,两者的"回退链"略有不同:
- caller 侧:`resolved.selection.model` = `config.backends["claude-code"].model` (来自 env)
- wrapper 侧:同一公式,结果相同 ✓

但如果 `overrides[role].model` 被设置(测试里就是这么做的,见 `test/agent-backends.test.mjs:8-13` 与 `src/__tests__/agent-runtime-registry.test.ts:60-69`):
- caller 侧:`claudeRequest.model = override.model`(因为 `selectAgentBackend` 把 `overrides[role]` 合并到 `selection` 上)
- wrapper 侧:`model = override.model` (因为 `config.overrides[request.role].model` 一样)
- 结果仍然一致 ✓

所以两条路径在当前测试矩阵下结论一致,**不是 correctness bug**,而是维护性隐患:未来若有人改动 `selectAgentBackend` 的合并规则但忘了同步 wrapper,会产生"caller 写进去的 `request.model` 与 wrapper 实际 spawn 用的 `options.model` 不一致"的幽灵 bug,极难复现。

**修复建议**:让 `runClaudeCodeStageFromConfig` 不重新解 `model`,直接 `request.model`:
```js
return runClaudeCodeStage(request, {
    executable,
    model: request.model,    // 已经由 caller 解析
    timeoutMs: config.timeoutMs,
    env: extra.env,
    abortSignal: extra.abortSignal,
});
```

或者更直接:**让 `runClaudeCodeStageFromConfig` 接受 `selection` 而不是 `config`**,把"解析选择"的责任完全上交给 `claudeCodeAdapter`,wrapper 只负责 "把已解析的选择 + 请求 传给 spawn 适配器"。

---

### M-4 [MEDIUM · Architecture · 两份 `AGENT_ROLES` 形状不同] `runtime/agent-backends.mjs:1-4` vs `runtime/pipeline-definition.mjs:42-50`

- `runtime/agent-backends.mjs`:`export const AGENT_ROLES = Object.freeze(['triage', 'triage-supervisor', 'spec-product', 'spec-tech', 'review-spec', 'implementation', 'review-pr', 'verify-behavior', 'improve-review-pr'])` — `string[]`,用于 `FACTORY_AGENT_OVERRIDES` 校验。
- `runtime/pipeline-definition.mjs`:`export const AGENT_ROLES = Object.freeze([{ id: 'triage', stage: 'triage', label: 'Triage' }, ...])` — `Array<{id, stage, label}>`,用于 panel 显示。

两个同名常量、两种形状,都能从不同模块被 import。开发者搜索 `AGENT_ROLES` 时极容易拿错。新增角色时要两处都改。

**修复建议**:在 `pipeline-definition.mjs` 单独 export `BACKEND_AGENT_ROLE_IDS`(`string[]`)用于校验,把 `agent-backends.mjs` 的 `AGENT_ROLES` 改成从 `pipeline-definition.mjs` 的 id 字段派生:
```js
import { AGENT_ROLES as PIPELINE_AGENT_ROLES } from "./pipeline-definition.mjs";
export const AGENT_ROLES = Object.freeze(PIPELINE_AGENT_ROLES.map(r => r.id));
```
并把 `triage-supervisor` 移到一个独立的 `INTERNAL_AGENT_ROLES` 常量中(它不是 `FACTORY_AGENT_OVERRIDES` 的合法键)。

**注意**:这个改动会涉及到 `runtime/agent-backends.d.mts` 的类型声明同步,以及测试断言里的字符串数组(测试里如 `assert.equal(typeof bindings.agentSelectionSource, "string")` 不会受影响)。

---

### M-5 [MEDIUM · Performance · 无限增长的 buffer] `runtime/claude-code-backend.mjs:122-138`

```js
let stdout = "";
let stderr = "";
...
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; ... });
```

`stdout` 与 `stderr` 在 close 之前一直 append。一个 1MB+ 的输出(LLM 端偶有 100K 字符的 traceback 或 50MB 的 verbose 调试)会撑爆 V8 内存。如果 CLI 进程被劫持(operator-controlled `FACTORY_CLAUDE_COMMAND` 指向恶意 binary),这是一个内存放大攻击面。

**修复建议**:在 chunk 监听器上加 1MB 上限:
```js
const MAX_STDIO_BYTES = 1024 * 1024;
let stdoutBytes = 0, stderrBytes = 0;
child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= MAX_STDIO_BYTES) stdout += chunk;
});
child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= MAX_STDIO_BYTES) stderr += chunk;
    if (options.stderrLogger && stderrBytes <= MAX_STDIO_BYTES) options.stderrLogger(chunk);
});
```
并在 close 处理里检查 `stdoutBytes > MAX_STDIO_BYTES` 时在 `logTail` 标注 `[truncated]`。

**为什么不是 HIGH**:operator 控制 executable,且 claude-code 是 readOnly role 不会写到仓库。但本机内存 DoS 仍然是真实风险。

---

### M-6 [MEDIUM · Correctness · timeout 路径没有 SIGKILL 升级] `runtime/claude-code-backend.mjs:125-128`

```js
const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGTERM"); } catch { /* already dead */ }
}, timeoutMs);
```

`SIGTERM` 是可被拦截/忽略的。如果 Claude Code CLI 在 15 分钟内没有正常退出(默认 `timeoutMs = 15 * 60 * 1000`),`SIGTERM` 不一定能让它退出。`child` 会以 zombie 状态继续占用 port 或 lock 文件,直到 daemon 进程退出。

**修复建议**:在 SIGTERM 后 5 秒升级到 SIGKILL:
```js
const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGTERM"); } catch { /* already dead */ }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000).unref?.();
}, timeoutMs);
```

注意 `node:child_process` 在 Windows 上 SIGTERM 等同于 terminate-process;某些 Windows 子进程可能仍然需要 taskkill。这与 Windows 平台 spawn(`shell: true`)的行为差异需要联调,但加这一行不会让情况更糟。

---

## Low

### L-1 [LOW · Style · `.d.mts` / `.mjs` 缺尾换行]
- `runtime/lease-wait-state.d.mts`
- `runtime/operation-receipts.mjs`
- `test/agent-backends-environment.test.mjs`
最后一行无 `\n`。`.editorconfig` 应该有 `insert_final_newline = true`。纯格式,不影响功能。

---

### L-2 [LOW · Readability · `structuredOutput: undefined` 显式赋值] `runtime/claude-code-backend.mjs:111-118, 144-152, 161-167, 175-181, 189-196, 202-209, 216-223, 248-256`

8 个错误分支都显式 `structuredOutput: undefined`。`ClaudeCodeStageResult` 类型是 `structuredOutput: unknown` (必填),但 JS 运行时 `undefined` 会通过 typebox 校验。统一删除该字段,只保留 `output: ""` 即可,减少认知负担。

---

### L-3 [LOW · Readability · `runSpecPhase` 内的 `while (true)`] `src/orchestrator/index.ts:1042-1107`

`while (true)` 只有 `return`(line 1106)和一个 `throw` (line 1097, 1065)两条出口。SPEC 文档本身已说明循环必须被 `APPROVE` 终结,但如果未来某次重构在 APPROVE 检查前增加新分支忘了 return,会陷入死循环。考虑加一个 `MAX_ITERATIONS` 保护:
```ts
for (let iteration = 0; iteration < 10; iteration += 1) { ... }
```

---

### L-4 [LOW · Readability · 重复的 diff 准备函数] `src/orchestrator/index.ts:1007-1017` vs `src/orchestrator/index.ts:1131-1145`

`prepareReviewArtifacts`(实现 PR review 准备)与 `prepareSpecReviewArtifacts`(spec PR review 准备)有 ~80% 重复:都是 `git diff` + `mkdir` + 写 4 个文件。差异只在 `baseSha` 的来源。可以提取公共 helper,只把文件清单参数化。

---

### L-5 [LOW · Testing · 缺 `interrupted` 状态测试] `src/__tests__/agent-runtime-embedded.test.ts`

`embeddedAdapter::classifyError` 把 `aborted|cancelled|killed` 归类为 `interrupted` (line 145),但五套测试里没有触发 `interrupted` 路径的用例。Harness 在 lane abort / close 路径上确实会产生这类消息。该路径虽然罕见,但 triage-supervisor 会按 `interrupted` 走不同分支,值得补一个 minimal 测试。

---

### L-6 [LOW · Security · `triage-supervisor` 在 `AGENT_ROLES` 但仅作内部 hat] `runtime/agent-backends.mjs:2`

`AGENT_ROLES` 包含 `'triage-supervisor'`,但 `FACTORY_AGENT_OVERRIDES={...,"triage-supervisor":"claude-code"}` 在 dispatcher 路径上不会被任何 caller 引用 — `TriageAgent` 只是在带 `failure` 参数时切换到 supervisor hat 内部使用。这会让 operator 误以为可以 override 该 role。如果保留,需要在 `BACKEND_DESCRIPTORS` 加一个 dummy 描述符并文档化;如果不需要,直接从 `AGENT_ROLES` 移除。

---

## 验证清单

| 项目 | 状态 | 备注 |
|---|---|---|
| 测试覆盖 | ✅ | registry / embedded / claude-code / log-shape / e2e / environment 六套,均通过 |
| 类型检查 (`tsc --noEmit`) | ✅ | exit 0,无错误 |
| 安全:`GH_TOKEN` 泄漏测试(48cdd0e) | ⚠️ | `agentWorkerEnvironment` 单元测试保留,但 **claude-code spawn 路径未接入白名单**(H-1) |
| 安全:command injection | ✅ | `claude-code` 的 args 由 adapter 硬编码,executable 由 operator env 提供;`shell: true` 仅在 Windows 且用户控制字段不进 argv(只进 stdin) |
| Capability gate | ✅ | `READ_ONLY_ROLES` 在 spawn 前执行,违约 `failed + retryable=false` |
| Lease 生命周期 | ✅ | `withStaleReclaim` HOF 统一,Layer 1 死进程检测,Layer 2 staleness TTL |
| Logger 字段一致性 | ✅ | `backendBindingsFor` + `bindingsForRuntime` 4 字段契约(`backend` / `agentSelectionSource` / `backendSchemaVersion` / `backendBuildHash`),test `agent-runtime-log-shape.test.ts` 锁住形状 |
| AbortSignal 处理 | ✅ | Claude Code `spawnOptions.signal` 触发 cancel 后 Promise `cancelled`;embedded 路径 `AbortController` + `engine.close()` 链 |

---

## 推荐的合并策略

1. **必须修复** H-1(claude-code 后端 env 白名单接入)后重新跑 `test/agent-backends-environment.test.mjs` + 新增一个跨 spawn 路径的集成测试。
2. **建议修复** M-1 / M-2 / M-3 / M-4(死代码、误导注释、重复解析、重复常量)。
3. M-5 / M-6(buffer 截断、SIGKILL 升级)可放下一切片,如果有 SIGTERM 抗性 CLI 出现则升级为 P0。
4. L-* 全部放进 `tech-debt-auditor` 的 follow-up。

---

## 文档路径

`specs/2026-09-16-unified-agent-runtime/CODE_QUALITY_REVIEW.md`

## 发现统计

- **CRITICAL**: 0
- **HIGH**: 1
- **MEDIUM**: 5
- **LOW**: 6
- **总计**: 12 个 finding
