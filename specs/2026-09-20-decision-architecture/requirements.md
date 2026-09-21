# Requirements: Decision Architecture

- test_runner: `npm test`
- parent_phase: Decision Architecture (Phase A — architecture spec only; Phase B implementation is a follow-on spec)

## Scope

### In Scope (Phase A)

This phase produces a **complete architecture specification** for how factory makes decisions internally.
It is documentation-first: every judgment currently buried inside a large LLM prompt is enumerated, classified by primitive, and given a state shape, a freshness rule, and a routing slot.
No new runtime backend is shipped in this phase; Phase A ends at a merged spec directory that subsequent `spec-do` invocations can pick up.

Concretely, Phase A delivers the following sections of `requirements.md` itself:

1. Decision inventory — the full enumeration of judgment points across five categories (A polling, B per-stage, C cross-stage, D operational, E meta-decision).
2. Primitive classification — each judgment point is labeled with one or more of `Choice`, `Score`, `Noul`, or `extraction`, and given a state shape and a confidence surface where applicable.
3. State shape contract — a single shared `JudgmentState` shape that every primitive question consumes, so `typesafe` batch calls can run in parallel without per-agent state duplication.
4. Freshness protocol — how to compute a state hash, how to decide when a cached judgment is stale, and when to skip re-evaluation entirely.
5. `decisions.yaml` schema — a configurable per-action confidence threshold table that the orchestrator reads instead of hard-coded if/else.
6. Composite scoring rubric — a default weight table for the system-health composite signal (spec / implementation / review / verify dimensions).
7. CJK fallback contract — the hard constraint that any `typesafe` backend must transparently fall back to `claude-code` when the Jev request fails or the confidence falls below a documented threshold.

Phase A also touches:

- `specs/roadmap.md` — add this phase as a new entry under `## Phases` with `Status: ⏳ In Flight (Phase A)`.
- `CHANGELOG.md` — record the spec under an `Unreleased / Decision Architecture` heading.

### Out of Scope (Phase A → Phase B / C)

The following are explicitly deferred and are NOT part of this phase:

1. **Phase B** — `runtime/typesafe-backend.mjs` implementation, including real `POST https://api.typesafe.ai/v1/systemone` calls, CLI session management, and the `TYPESAFE_API_KEY` credential whitelist.
2. **Phase B** — the freshness `Noul` PoC on the daemon polling path (would modify `scripts/factory-daemon.mjs` polling loop).
3. **Phase B** — migration of any single existing agent judgment (e.g. `triage.ts` supervisor) to the `typesafe` backend.
4. **Phase C** — full per-agent judgment migration for all ~22 judgment points; spec testing; production rollout.
5. **Phase D** — UI changes in `control-panel/` to visualise confidence distributions.
6. Any change to `src/core/agent-runtime.ts`, `runtime/agent-backends.mjs`, or the `claude-code` adapter. Phase A is purely additive at the spec layer.
7. Any change to existing `OutputContract` strings (`REVIEW_PR_CONTRACT`, `VERIFY_BEHAVIOR_CONTRACT`, `TRIAGE_*_CONTRACT`). They are referenced but not edited in this phase.

### Out of Scope (Permanent Non-Goals)

1. Replacing the `claude-code` backend; `claude-code` remains the generation backend for narrative outputs (prose, code, inline bodies).
2. Replacing deterministic classifiers (`src/core/failure-classifier.ts`, `src/core/verification-guard.ts`) with learned models; they stay as regex tables.
3. Real-time human-in-the-loop review of every judgment; the confidence-gated routing table reduces human load, not adds it.

---

## Decisions

### Decision 1 — Judgment is a first-class primitive

Factory internal decisions are not "things the LLM happened to also emit while generating text".
They are first-class primitives with explicit types, explicit state, and explicit confidence.

- Concretely: every judgment currently produced as a field of a free-form JSON response (e.g. `TriageResult.state`, `TriageRouting.action`, `ReviewResult.verdict`, `BehaviorVerificationResult.status`) gets a `Choice` / `Score` / `Noul` wrapper with a documented state shape and an optional confidence surface.

### Decision 2 — Judgment and Generation are physically layered

Phase 11's unified dispatcher (`src/core/agent-runtime.ts` plus `runtime/agent-backends.mjs`) is the seam.
Phase A documents how to extend it without modifying its dispatcher path: a new readonly backend descriptor (`typesafe`) is registered, and per-agent stage bodies are decomposed into two parallel calls on the same shared state.

- Judgment goes to `typesafe`.
- Narrative goes to `claude-code`.
- The orchestrator composes both into a final result.

This decomposition preserves Slice A/B/C contracts:
`BACKEND_DESCRIPTORS[backend]` gets a new row for `"typesafe"`; `AgentBackend` union widens; `READ_ONLY_ROLES` does NOT change because `typesafe` is also a readonly backend.

> **Erratum (2026-09-21) — wire envelope.**
> This document never defined the HTTP request/response envelope for `POST https://api.typesafe.ai/v1/systemone`; the `{model, state_hash, primitives:[{id,type,question,state}]}` shape implemented in Phase B was a project-local invention that the real endpoint rejects with HTTP 400 (verified live 2026-09-21).
> The authoritative wire contract is the official System One API (https://docs.typesafe.ai/api): request `{model, state, questions:{<id>:{type:"noul"|"choice"|"score", instructions, criteria}}}`, response `{model, answers:{<id>:...}, usage:{input_tokens, output_tokens}}`, model aliases `jev-latest` / `jev-preview` / `jev-1.13.0` (the Phase B default `jev-fast` never existed upstream).
> `runtime/typesafe-backend.mjs` now sends the official shape and maps official answers back into the internal `structuredOutput: [{id, value, confidence}]` contract, so the judgment inventory, `decisions.yaml` gates, and downstream parsers described in this document are unaffected.
> Historical worker reports (T8.1/T9.x) referencing the old envelope are left unamended as a record of what was built at the time.

### Decision 3 — State is shared, not duplicated

Every primitive question in a `typesafe` batch call consumes the same `JudgmentState`.
`JudgmentState` is the canonical name of the object that wraps `{ issue, factory, roadmap, repoSignals, receipts }` (see §"State Shape Contract" below).

- Multiple primitive questions on one state are parallel and isolated by contract (no context-rot).
- Per-agent `evidenceBlock` assembly is replaced by a single `buildJudgmentState(issue, ctx)` helper called by every agent that needs to ask judgments.

### Decision 4 — Freshness is the primary polling optimisation

The `polling` daemon (`scripts/factory-daemon.mjs`, default 30 s) currently runs full triage LLM calls on every ready issue every cycle.
The vast majority of those calls find the state unchanged; the model still pays tokens and latency.

Phase A specifies a `Noul` question on a *tiny* state hash:

```
state   = { issueHash, lastTriageAt, lastCommentAt, lastLabelChangeAt }
question = "Has anything changed since the last triage decision that should re-trigger triage?"
```

A `noul_yes` of `< 0.2` causes the orchestrator to skip the full triage and reuse the cached `TriageResult`.
A `noul_yes` of `≥ 0.2` triggers the full primitive batch.

- The freshness state is small and stable; the question is cheap; the savings compound across all polling-driven judgments, not just triage.

### Decision 5 — Routing is configurable, not hard-coded

Every current routing branch in `src/orchestrator/index.ts` that depends on a discrete judgment (e.g. "if verdict === REJECT, route to needs-info") is documented as a row in `decisions.yaml`:

```yaml
decisions:
  - action: triage.apply_label
    auto:        { confidence_min: 0.85 }
    confirm:     { confidence_min: 0.50, prompt: "Triage suggests: <state>. Apply?" }
    escalate:    { confidence_max: 0.50, target: needs-info }
  - action: review-pr.merge_pr
    auto:        { confidence_min: 0.90 }
    confirm:     { confidence_min: 0.65, prompt: "PR <n> has <n_blocking> blocking. Merge?" }
    escalate:    { confidence_max: 0.65, target: human }
```

- Code reads `decisions.yaml`; humans edit it; no source change required to retune a threshold.
- A schema migration is needed whenever a new `action` is introduced; this is intentionally stricter than today's behaviour.

### Decision 6 — Composite scoring drives the operator dashboard

Phase A documents a default composite rubric:

| Dimension | Weight | Source primitive | Score rubric |
| --- | --- | --- | --- |
| spec completeness | 0.30 | `spec.completeness` Score | `[broken, partial, complete, exemplar]` |
| implementation coverage | 0.25 | `implementation.coverage` Score | `[none, partial, full]` |
| review thoroughness | 0.20 | `review.thoroughness` Score | `[skipped, surface, deep]` |
| verify reliability | 0.25 | `verify.receipt_strength` Score | `[no_receipts, weak_receipts, strong_receipts]` |

The four Scores run in one `typesafe` batch; the orchestrator computes `health = 0.30·spec + 0.25·impl + 0.20·review + 0.25·verify` in code.
Operators see `health` next to per-issue status in the control panel (Phase D, out of scope for A).

### Decision 7 — CJK fallback is a hard constraint, not an option

`docs.typesafe.ai/concepts/state.md` explicitly warns that the Jev model is "primarily trained in English; other languages (including CJK) accepted but lower accuracy."
Factory accepts issues in both English and Chinese.

Phase A specifies the following non-negotiable behaviour:

- The `typesafe` adapter wraps every `POST /v1/systemone` call in a try/catch.
- On any of:
  (a) network / 4xx / 5xx failure,
  (b) `TYPESAFE_API_KEY` not configured,
  (c) `confidence < decisions.yaml[<action>].escalate.confidence_max`,
  the adapter returns a synthetic `StageRunResult` with `status: 'failed'`, `warnings: ['typesafe fallback to claude-code: <reason>']`, `retryable: false`.
- The orchestrator's existing per-action fallback rule (`FACTORY_AGENT_BACKEND_FALLBACK` opt-in, deferred to Phase 11 Slice F) is extended by Phase A's spec to cover this exact case.
- Until Slice F lands, Phase A's behaviour is "if typesafe fails, the calling stage surfaces the failure rather than re-running" — i.e. graceful degradation is documented but not auto-fallback. Auto-fallback is Phase B/C work.

The wording above is the contractual answer; implementation is deferred.

### Decision 8 — Deterministic classifiers stay deterministic

`failure-classifier.ts` and `verification-guard.ts` are NOT migrated to `typesafe` in any phase.
They are regex tables and they stay regex tables.
The discipline: any judgment whose ground truth can be expressed as a regex or a lookup table stays in code; only judgments that require semantic understanding go through `typesafe`.

---

## Decision Inventory

This is the **complete enumeration** of judgment points in factory as of 2026-09-20.
Each row carries: ID, category (A/B/C/D/E), current implementation site, target primitive, target backend, confidence surface, Phase B/C dependency.

### A — High-frequency polling judgments (per issue per polling cycle)

| ID | Judgment | Current site | Primitive | Backend | Confidence | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | State changed since last triage? | implicit (always re-run) | `Noul` | typesafe | yes | B |
| A2 | Triage readiness (4 states) | `src/agents/triage.ts:182` | `Choice` × 1 + `Noul` × 1 (author committed?) | typesafe | yes | B |
| A3 | Author binding decision in latest reply? | implicit in triage prompt | `Noul` | typesafe | yes | B |
| A4 | Lease staleness | `runtime/lease-manager.mjs` (regex) | **deterministic** | code | n/a | n/a |
| A5 | Issue priority among ready | none | `Score` 1–5 × K | typesafe | yes | C |

### B — Per-stage-run judgments

| ID | Judgment | Current site | Primitive | Backend | Confidence | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | Spec needs PRODUCT only or PRODUCT+TECH | `src/agents/spec.ts` (implicit) | `Choice` | typesafe | yes | C |
| B2 | Per-AC completeness (×N ACs) | `src/agents/spec.ts` | `Score` × N | typesafe | yes | C |
| B3 | Per-AC verifiability (×N ACs) | `src/agents/spec.ts` | `Noul` × N | typesafe | yes | C |
| B4 | Review-spec verdict | `src/agents/review-spec.ts` | `Choice` | typesafe | yes | C |
| B5 | Per-finding severity (×M findings) | `src/agents/review-spec.ts` | `Choice` × M | typesafe | yes | C |
| B6 | Implementation covers all ACs | none (relies on review-pr) | `Noul` × N | typesafe | yes | C |
| B7 | Review-pr verdict | `src/agents/review-pr.ts:90` | `Choice` | typesafe | yes | B |
| B8 | Per-finding severity (review-pr) | `src/agents/review-pr.ts` | `Choice` × M | typesafe | yes | B |
| B9 | Verify-behavior status | `src/agents/verify-behavior.ts:119` | `Choice` (5-way) | typesafe | yes | B |
| B10 | Verify-behavior channel | `src/agents/verify-behavior.ts` | `Choice` (3-way) | typesafe | yes | C |
| B11 | Per-AC check passed (×N) | `src/agents/verify-behavior.ts` | `Noul` × N (ground truth: receipt) | typesafe | yes | B |
| B12 | Supervisor action | `src/agents/triage.ts:254` | `Choice` (4-way) | typesafe | yes | B |
| B13 | Supervisor complexity | implicit | `Score` 1–3 | typesafe | yes | B |
| B14 | Needs-info wake-up needed? | `failureCounts` proxy | `Noul` | typesafe | yes | B |
| B15 | Failure class | `src/core/failure-classifier.ts` | **deterministic** | code | n/a | n/a |
| B16 | Verification guard severity | `src/core/verification-guard.ts` | **deterministic** | code | n/a | n/a |

### C — Cross-stage strategy judgments

| ID | Judgment | Current site | Primitive | Backend | Confidence | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | Spec vs implementation path | hard-coded in pipeline | `Choice` (dry-run only) | typesafe | yes | C |
| C2 | Auto-merge eligibility | single LLM call | composite of B4, B7, B9, B16 | typesafe (composite in code) | yes | C |
| C3 | Improve-review-pr needed? | threshold | `Noul` | typesafe | yes | C |
| C4 | Daily review ranking (×K PRs) | LLM scans all | `Score` × K | typesafe | yes | C |

### D — Operational judgments (daemon cycle)

| ID | Judgment | Current site | Primitive | Backend | Confidence | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | Pipeline bottleneck stage | panel aggregation | `Score` | typesafe | yes | C |
| D2 | Systemic-failure signal | log alerts | `Noul` | typesafe | yes | C |
| D3 | Operator escalation needed | implicit | `Noul` | typesafe | yes | C |
| D4 | Backpressure trigger | none | `Noul` × 3 | typesafe | yes | C |
| D5 | Skill suggestion | hard-coded | `Choice` (per `cookbooks/skill_suggestion.md`) | typesafe | yes | C |

### E — Meta-decisions (decisions about decisions)

| ID | Judgment | Current site | Primitive | Backend | Confidence | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | Cached judgment stale? | implicit | `Noul` | typesafe | yes | B |
| E2 | Two judgments internally consistent? | none | reverse `Noul` | typesafe | yes | C |
| E3 | Which backend for this judgment? | `FACTORY_AGENT_OVERRIDES` static | `Choice` (cheap_jev vs expensive_claude) | typesafe | yes | C |
| E4 | Composite weight selection | hard-coded in contract | config item | yaml | n/a | C |

Total judgment points: **37**, of which **5 are deterministic** (kept in code), **32 are migratable**, **9 target Phase B**, **23 target Phase C**.

---

## State Shape Contract

`JudgmentState` is the canonical state object every primitive question consumes.

```ts
interface JudgmentState {
  // Source: GitHub
  issue: {
    number: number;
    title: string;
    body: string;
    labels: string[];
    updatedAt: string;     // ISO-8601
    comments: ReadonlyArray<{
      author: string;
      body: string;
      createdAt: string;
      isFactoryComment: boolean;
    }>;
  };
  // Source: factory runtime
  factory: {
    lastTriageAt?: string;
    lastJudgmentHash?: string;     // hash of (issue.updatedAt, comments.length, lastReceiptSha)
    failureCounts: Record<string, Record<string, number>>;
    lastReceiptRegistry?: ReceiptRegistry;
    priorDecisions: ReadonlyArray<DecisionRecord>;
  };
  // Source: repo
  repoSignals: {
    primaryLanguage: string;
    hasOpenSpec: boolean;
    hasOpenPRs: number;
  };
  // Source: optional
  roadmap?: { missionText?: string; relevantSectionText?: string };
  // Source: optional per-judgment
  prDiff?: string;
  specBody?: string;
  implementationDiff?: string;
}
```

Rules:

- State is **read-only** for the primitive call; mutations happen in code after the call returns.
- Optional fields are populated lazily by `buildJudgmentState(issue, ctx, opts)`; the contract does not require all fields for every question.
- The same `JudgmentState` instance can be reused across many primitive questions in one batch call.
- For Phase A's documentation purpose, `JudgmentState` is specified here but not exported as TypeScript yet; Phase B adds `src/core/judgment-state.ts`.

---

## Freshness Protocol

The freshness `Noul` (E1) is the linchpin of the polling optimisation.

### Hash definition

```
stateHash = sha256(
  issue.updatedAt
  || '|' || comments.length
  || '|' || lastReceiptSha
  || '|' || factory.lastTriageAt
  || '|' || issue.labels.join(',')
)
```

`lastReceiptSha` is the SHA-256 of the most recent `receipts.json` (verify-behavior artifact); absence is encoded as `''`.
The hash is recomputed on every daemon poll; comparison is `stateHash === factory.lastJudgmentHash`.

### Staleness threshold

`freshness.noul_yes` is the model's probability that "anything has changed since last judgment".
A cached judgment is reused when `noul_yes < 0.2`; a full primitive batch is triggered otherwise.
The threshold is configurable in `decisions.yaml` under `decisions.freshness.threshold`.

### Skip rule

When the orchestrator decides to skip, it logs `judgment.skip` with the reason `state_unchanged`.
The decision is never silently elided; the panel's read model still records the no-op for traceability.

---

## `decisions.yaml` Schema

```yaml
# Spec is YAML 1.2; comments are #, lists are [], strings can be unquoted.
# This file lives at runtime/decisions.yaml and is loaded at startup.

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

# Composite scoring weights (Decision 6)
composite:
  spec:     0.30
  impl:     0.25
  review:   0.20
  verify:   0.25

# CJK fallback (Decision 7)
fallback:
  cjk:
    trigger: any_of
    conditions:
      - typesafe_unreachable
      - typesafe_confidence_below: { action: triage.apply_label, threshold: 0.85 }
      - typesafe_status_5xx
    fallback_backend: claude-code
    log_warning: typesafe_fallback_to_claude
```

### Schema validation rules

- Every `action` MUST appear in `READ_ONLY_ACTIONS` (a closed set defined by the orchestrator; new actions require a schema migration).
- `confidence_min` MUST be `<=` `confidence_max` for the same `action`.
- `composite.*` weights MUST sum to 1.0 within `±0.01`.
- Unknown keys fail startup pre-check (same severity as `load_skill` regression F01).

---

## Composite Scoring Rubric

Default weights for the system-health signal (see Decision 6):

| Dimension | Weight | Source primitive | Rubric (low → high) |
| --- | --- | --- | --- |
| spec | 0.30 | `B2` AC completeness × N → mean | broken / partial / complete / exemplar |
| impl | 0.25 | `B6` AC coverage × N → mean | none / partial / full |
| review | 0.20 | `B7`+`B8` derive | skipped / surface / deep |
| verify | 0.25 | `B11` × N → mean, weighted by receipt `passed` | no_receipts / weak_receipts / strong_receipts |

Composite value range: `[0.0, 1.0]`.
Composite `< 0.5` → operator alert; `0.5–0.7` → dashboard banner; `> 0.7` → log only.

The rubric is data in `decisions.yaml`; the formula is code in `src/orchestrator/composite.ts` (Phase B).
Operators can retune weights without code changes.

---

## CJK Fallback Contract

The CJK fallback is a hard constraint, restated as a contract:

1. **Trigger conditions** — any of:
   - `POST https://api.typesafe.ai/v1/systemone` returns 4xx/5xx or times out.
   - `TYPESAFE_API_KEY` is missing or invalid.
   - Per-action `confidence` falls below `decisions.yaml[<action>].escalate.confidence_max`.

2. **Behaviour**:
   - The `typesafe` adapter MUST return a `StageRunResult` with `status: 'failed'`, `warnings: ['typesafe_fallback_to_claude: <reason>']`, `retryable: false`.
   - The orchestrator MUST surface this as a graceful degradation event, NOT a hard abort of the pipeline.
   - Until Phase 11 Slice F (`FACTORY_AGENT_BACKEND_FALLBACK` opt-in) lands, the orchestrator does NOT auto-re-run on Claude; the calling stage reports the fallback in its summary.
   - The fallback event is logged with structured fields: `fallback.reason`, `fallback.from_backend=typesafe`, `fallback.to_backend=claude-code`.

3. **Observability**:
   - `panel-read-model.mjs` shows a per-stage fallback badge whenever the last run for that stage fell back.
   - The composite health signal downgrades any dimension whose source primitive ran on fallback.

4. **Test contract** (Phase B):
   - `src/__tests__/typesafe-fallback.test.ts` MUST cover all three trigger conditions.
   - `test/typesafe-fallback-cli.test.mjs` MUST confirm the `FACTORY_TYPESAFE_OFF=1` env var (or equivalent) forces fallback regardless of API health, for offline testing.

---

## Context

### Mission alignment

`specs/mission.md` calls out "deterministic, auditable pipeline", "versioned inputs", and "first-class seams between stages" as core values.
The decision architecture directly serves these:

- Deterministic — deterministic classifiers (B15, B16) stay deterministic.
- Auditable — every judgment carries a confidence surface and a freshness timestamp; the panel can replay the chain.
- First-class seams — judgment is no longer hidden inside LLM prose; it has its own primitive vocabulary.

### Phase 11 alignment

`specs/2026-09-16-unified-agent-runtime/requirements.md` Decision 3 enumerates Slices A–F.
Slice C (implementation + mutating roles) and Slice D (Codex / Pi adapters) are referenced as follow-on work and are not part of that spec.
The decision-architecture spec slots in as the natural next phase:

- Slice D pattern — "register a new backend under the same contract, with its own adapter module, without changing the dispatcher" — is exactly how `typesafe` is registered in Phase B.
- Slice E (cross-backend validation) — `decisions.yaml` schema validation, freshness protocol, and CJK fallback contract are the architectural primitives Slice E will rely on.
- Slice F (optional auto-fallback) — the CJK fallback contract is a special case of Slice F's general fallback; the spec preserves the special-case behaviour when the general case is opt-in.

The dispatcher is NOT modified by this phase. The `typesafe` backend registration in Phase B follows the Slice A.1 / D contract exactly: descriptor + adapter module + role allow-list membership.

### Constraints

`specs/tech-stack.md` Constraints & Non-Goals:

- Node.js `>=22.19.0` — preserved.
- Single daemon per repository — preserved (Phase A adds no new long-running components).
- Tool schemas registered alongside implementation — preserved (Phase B's `typesafe-backend.mjs` follows the same pattern as `claude-code-backend.mjs`).
- `FACTORY_AGENT_MODE=stub` removed — preserved; Phase A's spec assumes the LLM path is always live.
- Secrets in env / dotenv / settings only — `TYPESAFE_API_KEY` is added to this contract in Phase B; Phase A documents the requirement only.

### Non-Goals (from tech-stack.md)

- Replacing the model provider — preserved (Phase A adds a new backend, does not replace).
- Microservice / DAG orchestration platform — preserved (no new runtime topology).
- Automatic preemption / failover across machines — preserved (Phase A's CJK fallback is per-judgment, not cross-machine).

---

## Technical Risks (mirrored from constraints)

- **R1 — Calibration mismatch**: Jev's confidence may not be well-calibrated for factory's specific rubrics; the rubric may need re-anchoring before any Phase B code ships.
  *Mitigation*: Phase A specifies calibration measurement as a Phase B acceptance gate; the validation suite in `validation.md` L4 enforces "100 sample issues, Jev confidence P50/P90 stable within ±0.05 across re-runs".

- **R2 — Latency regression on cold path**: adding a `typesafe` HTTP call before each judgment may add 100–500 ms even on a warm path; for the polling loop that compounds.
  *Mitigation*: freshness `Noul` short-circuits ~90% of polling-cycle judgments; the per-batch primitive call is one HTTP request, not N.

- **R3 — CJK accuracy regression**: `docs.typesafe.ai` warns of lower accuracy on CJK inputs; the CJK fallback contract is the safety net but a fallback to `claude-code` defeats the cost/latency win.
  *Mitigation*: calibration measurement (R1) explicitly includes CJK samples; if CJK accuracy < 0.85 of English on the same rubric, the fallback fires automatically per the contract.

- **R4 — Spec drift between Phase A and Phase B**: a doc-only spec is easy to drift from later code; if Phase B lands without re-reading Phase A, the two can diverge.
  *Mitigation*: `decisions.yaml` schema validation (L1) is enforced at startup; any drift in the schema triggers a pre-check failure identical in severity to the F01 `load_skill` regression.

- **R5 — Cost ceiling**: a misconfigured `decisions.yaml` that defaults all judgments to `claude-code` would re-introduce today's behaviour without the savings.
  *Mitigation*: composite scoring dashboard exposes a "fallback rate" metric; if it climbs above a configurable ceiling (default 10% of judgments), an operator alert fires.

- **R6 — Routing table explosion**: as new `actions` are added, `decisions.yaml` grows; without discipline it becomes a maintenance burden.
  *Mitigation*: `READ_ONLY_ACTIONS` is a closed set in the orchestrator; new actions require a code change to register, and the change is gated by a test asserting the YAML key exists.

---

## Relationship to Other Specs

- `specs/2026-09-16-unified-agent-runtime/requirements.md` — the dispatcher contract this spec extends. Phase A does not modify it; Phase B adds `typesafe` to the `BACKEND_DESCRIPTORS` table following Slice A.1 / D patterns.
- `specs/2026-09-16-unified-agent-runtime/plan.md` — the Slice A/B execution plan; Phase A is independent of that plan and does not block / unblock any of its tasks.
- `docs/harness-architecture.md` — to be updated in Phase B with a "Decision Architecture" subsection once the `typesafe` adapter is wired.

---

## Changelog

- 2026-09-20: Initial Phase A draft. Covers Decisions 1–8, the A/B/C/D/E judgment inventory, the `JudgmentState` shape, the freshness protocol, the `decisions.yaml` schema, the composite scoring rubric, and the CJK fallback contract.
