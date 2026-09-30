# Decision Architecture

> 人类读者友好的简版总结。
> 契约细节见 [`specs/2026-09-20-decision-architecture/`](../specs/2026-09-20-decision-architecture/)。
> 本文档反映 Phase B / C 已落地的状态(2026-09-23),与仓库当前实现对齐。

## The Thesis

一个志在自主交付高质量代码的软件工厂,必须在每次轮询、每次重试、每次 issue 上做出大量内部决策。
这些决策过去是隐式的:给 LLM 一个大 prompt 和一份大 JSON 输出契约,它顺手把 orchestrator 需要的 verdict 字段塞进了人类可读的散文里。
这等于把「判断」和「生成」耦合在一起,逼着工厂在两个都不好的选项之间二选一:

- **紧 prompt + 严格 parse** —— 每个决策都变成对单次 LLM 响应的 parse-fragile 字段。
- **松 prompt + 宽松 parse** —— 每个决策都是 best-effort,orchestrator 没法判断模型何时真的不确定。

决策架构把这两种关注分开。

## The Layer Split

```
                Issue / PR / Spec / Receipts
                              │
                              ▼
        ┌─────────────────────────────────────────┐
        │   State Object  (`JudgmentState`)       │
        │   read-only, shared across primitives   │
        └─────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌──────────┐    ┌──────────┐    ┌──────────┐
        │ Choice   │    │  Score   │    │  Noul    │
        │  + conf  │    │  + conf  │    │  + conf  │
        └──────────┘    └──────────┘    └──────────┘
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                judgment + confidence surface
                              │
                              ▼
        ┌─────────────────────────────────────────┐
        │  Routing  (per-action confidence gates)│
        │  auto | confirm | escalate              │
        │  ─ read from `runtime/decisions.yaml`  │
        │  ─ seam: `src/core/decision-router.ts` │
        └─────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
        Auto-proceed                  Author / Operator
              │
              ▼ (only when narrative output is needed)
        ┌─────────────────────────────────────────┐
        │   Generation Layer (claude-code / ...)  │
        │   prose, code, inline comments,         │
        │   correction messages                   │
        └─────────────────────────────────────────┘
```

两路并行调用,共享同一份 `JudgmentState`:

- **Judgment** —— `typesafe` 后端的批量 primitive 调用:`Choice` / `Score` / `Noul`。快、便宜、有校准,带 confidence。覆盖当前工厂中可迁移的 ~32 个判断点。
- **Generation** —— `claude-code`(或 `codex-cli` / `pi-cli`):散文、代码、内联正文。仅在作者或操作员需要人类语言制品时调用。

Orchestrator 把两路合成最终的 stage result。

## The Eight Decisions (Phase A)

| # | Decision | 一句话总结 |
| --- | --- | --- |
| 1 | Judgment 是 first-class primitive | 每个 verdict / status / severity / action 字段都是类型化的 primitive,不是文本生成的副作用。 |
| 2 | Judgment 与 Generation 物理分层 | 新增 `typesafe` 只读后端,在 dispatcher 注册;dispatcher 自身不变。 |
| 3 | State 共享,不复用 | `JudgmentState` 是 canonical state 对象,每个 primitive 都消费它;不再有 per-agent `evidenceBlock`。 |
| 4 | Freshness 是首要轮询优化 | 小 state hash 上的廉价 `Noul` 短路掉 ~90% 的轮询周期判断。 |
| 5 | Routing 可配置,不硬编码 | per-action confidence 阈值写在 `decisions.yaml`,operator 不改代码也能重新调优。 |
| 6 | Composite scoring 驱动 operator dashboard | 四个 `Score` primitive 合成四维健康度(spec / impl / review / verify)。 |
| 7 | CJK fallback 是硬约束 | `typesafe` 失败 / confidence 跌破阈值 → 自动 fallback 到 `claude-code`,带结构化日志。 |
| 8 | 确定性分类器保持确定性 | `failure-classifier.ts` 和 `verification-guard.ts` 是 regex 表,保持原样。 |

## The Decision Inventory (Phase B / C 落地)

| 类别 | 数量 | 迁移阶段 | 当前落地 |
| --- | --- | --- | --- |
| A — polling-time judgments | 5 (4 migratable + 1 deterministic) | A1, A2, A3 → Phase B; A5 → Phase C | A1 freshness `Noul` 已落(`scripts/freshness-poc.mjs` + `TriageAgent` 三段复用);A2/A3 合并入 `triage` 的 typesafe batch。 |
| B — per-stage judgments | 16 (14 migratable + 2 deterministic) | B7–B14 → Phase B; B1–B3 → Phase C | B12 / B13 / B14 由 `triage` typesafe batch 在 readiness-gate 路径上承载(同 `JudgmentState`,forward-compatible);其他 stage 走 `decisionRouter` seam。 |
| C — cross-stage strategy | 4 | Phase C | 通过 `decisions.yaml` 的 escalate tier 表达(`target: needs-info` / `target: human`)。 |
| D — operational | 5 | Phase C | `operator.escalate` 已写入 `decisions.yaml`,配合 confidence 路由。 |
| E — meta-decisions | 4 | E1 → Phase B; E2–E4 → Phase C | E1 freshness `Noul` 已在 daemon polling 周期落地。 |
| **Total** | 合计见 [`specs/2026-09-20-decision-architecture/requirements.md`](../specs/2026-09-20-decision-architecture/requirements.md) §Decision Inventory | | |

> 本表为 Phase B / C 落地阶段的人类读者总结,不再硬编码 per-phase 计数 —— spec 修订后本表曾因行数相加与总和不一致而陷于自相矛盾。每个 phase 的判定点 **canonical 数字以 spec dir 为准**,特此声明。

## What Phase B / C Ships(已落地)

### Wire contract —— 官方 System One(2026-09-21 erratum)

`runtime/typesafe-backend.mjs` 适配器走 typesafe.ai 官方 System One API,严格按官方信封:

- 请求:`POST https://api.typesafe.ai/v1/systemone`,body = `{ model, state, questions }`
- `state` 在整批 primitive 间共享一次(单一来源);`instructions` 通过反引号点路径引用,如 `` `issue.comments[0].body` ``
- `questions` 中每个 id 是代码侧标识(不进 wire),`answers` 用相同的 id 回填
- 模型枚举:`jev-latest` / `jev-preview` / `jev-1.13.0`(旧别名 `jev-fast` / `jev` 在适配器中归一为 `jev-latest`,带 `model_alias_normalised` 警告)
- `api_key` 绝不出现在 body 里,只通过 `Authorization: Bearer` header 传递

`runtime/typesafe-backend.d.mts` 给出了完整类型声明。早期项目本地发明的 `{model, state_hash, primitives}` 信封已被真实端点拒绝(HTTP 400),已退役。

### CJK Fallback Contract

`requirements.md` §"CJK Fallback Contract" 定义的三种 fallback 触发,适配器现在只承认其中两种(2026-09-22 confidence-as-fallback 移除):

| # | Trigger | 适配器行为 |
| --- | --- | --- |
| 1 | `POST` 返回 4xx / 5xx / 超时 / 抛错 / 返回非 JSON(429 / 529 在 `postSystemOneWithRetry` 内指数退避) | `status: "failed"`, `warnings: ["typesafe_fallback_to_claude: <reason>"]`, `retryable: false`, `providerSessionId: null` |
| 2 | `TYPESAFE_API_KEY` 缺失或无效 | 同上,reason = `TYPESAFE_API_KEY missing` |
| 3 | **(已移除)** confidence 跌破阈值 | 改为 `decisions.yaml` 的 `escalate` tier 表达,不再让适配器以 fallback 形式吃掉 uncertainty。 |

`retryable: false` 是契约 —— 直至 Phase 11 Slice F(`FACTORY_AGENT_BACKEND_FALLBACK` opt-in)落地之前,orchestrator 不会自动用 Claude 重跑。
每条 fallback 路径都会发出结构化日志字段 `fallback.reason` / `fallback.from_backend = "typesafe"` / `fallback.to_backend = "claude-code"`。

`agentWorkerEnvironment` 是凭证白名单的唯一入口,`TYPESAFE_API_KEY` 无条件转发给 worker(2026-09-22 fix,绕过 verdict 层),`GH_TOKEN` / `GITHUB_TOKEN` 仍绝不外泄到子进程。

### Routing seam —— `src/core/decision-router.ts`

该 seam 只保留纯函数入口，调用方传入已解析的 `DecisionsFile`：

- `applyDecision(action, payload, decisions)` 接受 `confidence`、`noul_yes`、`blockingFindings`。
- `decisionRouter.apply` 是同一函数的兼容别名，不包含另一套路由规则。

层级解析顺序(高优先级优先):

1. `escalate` —— `confidence <= escalate.confidence_max` **或** `noul_yes >= escalate.noul_yes_min` 触发。
2. 硬阻断 —— `blockingFindings` 超过 `auto.blocking_findings_max` 时直接 escalate，不允许由 confidence 抵消；未配置上限时默认 0。
3. `auto` —— 每个 **已配置** gate 都通过(`confidence >= auto.confidence_min` 且 `noul_yes <= auto.noul_yes_max`)。
4. `confirm` —— 落进 auto 与 escalate 之间的 gap;未配置时按"no silent defaults"规则 escalate。

异常输入归一化:

- 畸形 confidence(missing / non-finite / 越界)归一为 `0` → 所有 confidence-gated 规则的 escalate arm 触发。
- 畸形 `noul_yes` 保持 `NaN` → 永不满足配置的 noul gate(freshness 失败保守回退到完整 batch)。

### `decisions.yaml` schema

权威定义见 [`runtime/decisions.yaml`](../runtime/decisions.yaml)。
启动期由 [`src/core/decisions.ts`](../src/core/decisions.ts) 的 `loadDecisionsSync` / `loadDecisionsSync` 加载;`runDecisionsPreCheck()` 是 F01 级别的启动守卫 —— malformed `decisions.yaml` 是启动失败,不是静默默认值。

实际生产配置(2026-09-22):

```yaml
version: 1

decisions:
  # A. Polling-time judgments
  - action: freshness.skip
    auto:     { noul_yes_max: 0.20 }
    escalate: { noul_yes_min: 0.20, target: full_triage_batch }

  - action: triage.apply_label
    auto:     { confidence_min: 0.85 }
    confirm:  { confidence_min: 0.50, prompt: "Triage suggests: <state>. Apply?" }
    escalate: { confidence_max: 0.50, target: needs-info }

  # B. Per-stage judgments
  - action: review-pr.merge_pr
    auto:     { confidence_min: 0.90, blocking_findings_max: 0 }
    confirm:  { confidence_min: 0.65, prompt: "PR <n> has <k> blocking. Merge?" }
    escalate: { confidence_max: 0.65, target: human }

  - action: supervisor.retry
    auto:     { confidence_min: 0.85, retryable_class_only: true }
    escalate: { confidence_max: 0.85, target: needs-info }

  # D. Operational judgments
  - action: operator.escalate
    auto:     { confidence_min: 0.95, channel: pager }
    confirm:  { confidence_min: 0.70, channel: dashboard_banner }
    escalate: { confidence_max: 0.70, target: log_only }

composite:
  spec:     0.30
  impl:     0.25
  review:   0.20
  verify:   0.25

fallback:
  cjk:
    trigger: any_of
    conditions:
      - typesafe_unreachable
      - typesafe_status_5xx
    fallback_backend: claude-code
    log_warning: typesafe_fallback_to_claude
```

校验规则(测试覆盖见 [`src/__tests__/decisions-validate.test.ts`](../src/__tests__/decisions-validate.test.ts),7 个用例):

1. 每个 `action` 必须出现在 `READ_ONLY_ACTIONS` 闭集中。
2. 每个 action 内 `confidence_min <= confidence_max`(适用处)。
3. `composite.*` 权重总和 = `1.0 ± 0.01`。
4. 任何层级出现未知 key,启动期 pre-check 失败。

### Freshness protocol

轮询周期优化是 `JudgmentState` hash 上的 `Noul` primitive(E1):

- `stateHashFor(state)` 在 [`src/core/judgment-state.ts`](../src/core/judgment-state.ts) 计算 SHA-256,覆盖 `(issue.updatedAt, comments.length, lastReceiptSha)`。
- 当 `Noul` 返回 `noul_yes < 0.20`(`decisions.yaml[freshness.skip].auto.noul_yes_max`),daemon 轮询周期内的 freshness-check 短路其余 judgment batch —— 权威调用点是 `scripts/factory-daemon.mjs::freshnessCheck`(Phase B / T8.4 已接入;契约表面是 `decisions.yaml[freshness.skip]` 规则加 `judgment.skip` 日志事件)。
- Phase C 把 freshness gate 推进到 per-stage `Noul` primitive;hash 形状保持稳定,daemon 侧的 `freshnessCheck` 保持向后兼容。

### Spec review R-series rubric(2026-09-21)

`src/core/spec-review-rubric.ts` 是 review-spec 阶段的 R1–R7 结构化判断点,fix issue #39 的"两轮审查反复打回同一组 finding"收敛问题:

- R1 — acceptance criterion 不可观测(noul, positive)
- R2 — story 覆盖率(score, 0/0.33/0.67/1 四档;低于 0.5 → important,0.5–0.84 → suggestion)
- R3 — validation plan item 不可运行(noul, positive)
- R4 — 开放问题阻断实现(noul, negative —— 高 yes 是 defect)
- R5 — 故事超出 issue 范围(noul, positive)
- R6 — non-goal 被 TECH 静默实现(noul, negative,severity = blocking)
- R7 — 上轮 finding 未解决(noul, positive,severity 继承上轮)

R-series 的 verdict 是结构性 verdict source of record;LLM review pass 仍然作为探索层跑在 R-series 之后,仅在 B5 severity 判断 confidence 高时才不被降权(`exploreBlockFloor`)。

R7 的棘轮:同一点连续 2 轮(`RUBRIC_RATCHET_LIMIT`)fail → 确定性升级到 needs-info,不再烧第三轮 spec cycle。

### Triage readiness-gate 路径(2026-09-22)

`src/agents/triage.ts` 现在的 readiness-gate 路径按下列顺序运行:

1. **确定性快路径**:`stateHashFor(state) === cache.lastJudgmentHash` → 直接返回 `cache.cachedTriage`,零模型调用。
2. **上游复用**:orchestrator 已经为本次轮询运行 `freshnessCheck`,结果经 `cache.freshnessResult.skip` 透传;`skip: true` → 复用 `cachedTriage`。
3. **Agent-side A1**:缓存存在但 hash 已变,无上游结果 → 调一次 `typesafe` `Noul` 问"上次 triage 后是否有 triage-worthy 变化?",按 `decisions.yaml[freshness.skip]` 路由;`mode: 'auto'` → 复用缓存,其它 → 进入完整 batch。typesafe 不可达 → 保守回退到完整 batch。
4. **无缓存** → 直接进入完整 batch。

完整 batch 一次 `POST` 同时携带 A2(`Choice`)+ A2.author_committed(`Noul`)+ A3.author_binding_decision(`Noul`)+ B14.needs_info_wakeup(`Noul`)四个 primitive,共享同一份 `JudgmentState`。
当前 readiness 路由直接采用 A2 的 Choice 结果;`triage.apply_label` 规则仍保留在配置中,但不参与这条路径。

每种 typesafe 失败模式(unreachable / format-error / no-api-key / parse-miss)都触发 fallback 到 legacy claude-code 路径,所以 pipeline 永远不会被 typesafe outage 阻塞。

LLM supervisor 已退役(2026-09-22,issue #36):失败路由改为 `src/core/routing-decision.ts` 中的纯确定性 `decideRouting` 函数,LLM 不再决定 retry / reroute / needs-info / abort。

## What Phase A Did NOT Ship(历史背景)

- 没有 `runtime/typesafe-backend.mjs` —— **Phase B 已落地**(`runtime/typesafe-backend.mjs` + `.d.mts`)。
- 没有 judgment 迁移 —— **Phase B 已落地**(`triage` / `review-spec` / `review-pr` / `verify-behavior` 全部走 `decisionRouter` seam)。
- 没有 UI 改动 —— 置信度分布尚未在控制面板可视化。
- dispatcher 没有 `typesafe` entry —— **部分落地**:`runtime/typesafe-backend.mjs` 提供独立 judgment 适配器,通过 `runtime/agent-backends.mjs` 转发 `TYPESAFE_API_KEY`(2026-09-22 起无条件转发)。`BACKEND_DESCRIPTORS` 仅含 `claude-code`,`typesafe` 不进入 dispatcher,所有需要 `typesafe` verdict 的 agent 直接调用适配器。

## Where to Read More

| Document | 回答什么 |
| --- | --- |
| `specs/2026-09-20-decision-architecture/requirements.md` | "要建什么?" |
| `specs/2026-09-20-decision-architecture/plan.md` | "怎么建?" |
| `specs/2026-09-20-decision-architecture/validation.md` | "怎么知道建好了?" |
| `specs/2026-09-16-unified-agent-runtime/requirements.md` Decision 3 | "如何挂到 Phase 11 路线图上?" |
| `docs/harness-architecture.md` §4.x | "Unified Agent Runtime 与 typesafe 后端如何协作?" |

## Cross-References

- Phase 11 Slice C–F(`specs/2026-09-16-unified-agent-runtime/requirements.md`)—— 该 spec 通过新增只读 backend descriptor 扩展的 dispatcher 契约。
- `docs.typesafe.ai/concepts/system-one.md` —— primitive 词汇的上游心智模型。
- `docs.typesafe.ai/patterns/intent-routing.md` —— routing matrix(`decisions.yaml`)的直接灵感来源。
- `src/core/spec-review-rubric.ts` —— R1–R7 结构性 verdict 的权威来源;LLM review pass 是探索层。
- `src/agents/triage.ts::runReadinessGate` —— readiness-gate 路径上的 A1 三段复用 + typesafe batch + fallback chain。
- `src/core/decision-router.ts` —— 函数式 / 类式 seam 的统一入口。

---

> Last updated: 2026-09-23(Phase B/C 落地状态;后续 commit 见 `e683d79` / `1fbef36` / `7d964a5` / `c56ed32` / `51c1837` / `8a631f7`)。
