# Phase 11 — Unified Agent Runtime (Requirements)

This spec is the reconciliation of `specs/2026-09-16-unified-agent-runtime` with the work already in flight on branch `phase-1-unified-agent-runtime`.
It keeps the same Slice A → B → C → D → E → F rollout sequence and the same read-only-first sequencing decision, but rebases the contract, naming, and selection mechanism on the existing WIP.

## Scope

This phase extracts a Unified Agent Runtime layer between the domain agents (`src/agents/*`) and the LLM execution backend, so the factory can drive Claude Code, Codex CLI, and Pi CLI through one task contract, validation surface, and logging shape.
The current single-backend execution path (`HarnessLlmEngine` on `@earendil-works/pi-agent-core`) keeps working unchanged for every role that does not opt into a CLI backend.

### In Scope

1. A backend registry and selection policy inside `src/core/agent-runtime.ts` (TypeScript surface) backed by `runtime/agent-backends.mjs` (compiled entry point) — implemented as the public contract every stage funnels through.
2. The existing `HarnessLlmEngine` registered as the `embedded` backend through the same contract, with no behavioural change for roles that stay on it.
3. A Claude Code CLI backend (`claude-code`) wired through the same contract for at least one read-only role (`review-pr`), validating startup, structured result emission, logging, timeout, and crash recovery before any publishing role is migrated.
4. A selection mechanism based on `FACTORY_AGENT_BACKEND` (global default) plus `FACTORY_AGENT_OVERRIDES` (JSON object, per-role override), already implemented in `runtime/agent-backends.mjs` and now surfaced through the dispatcher.
5. Backend-agnostic logging fields (`backend`, `role`, `runId`, `issue`, `artifactId`, `attempt`, `usage`, `abortReason`) emitted from the unified runtime layer, so the existing `runtime/panel-read-model.mjs` does not need to special-case per backend.
6. A dedicated test surface (`src/__tests__/agent-runtime*.test.ts` plus `test/agent-runtime*.test.mjs`) covering registry integrity, selection precedence, and structured result validation.
7. Existing `HarnessLlmEngine` regression suite (`test/worker-executor.test.mjs`, `src/__tests__/harness-engine.test.ts`, `test/pipeline-spec-review.test.mjs`) must remain green throughout.

### Out of Scope

1. Auto-fallback from a CLI backend to `embedded` on transient failure.
   The user's brief explicitly defers this until cross-backend semantics are stable, to avoid a failed retry covering modifications from a still-unprocessed previous attempt.
2. Wiring the `implementation` role, tool services, or the Factory publish flow to a CLI backend.
   These belong to the next slice, sequenced after `review-pr` is validated end-to-end on Claude Code.
3. Codex CLI and Pi CLI real adapters.
   They share the contract and may be slotted in later, but no real adapter implementation is required in this slice.
4. Per-issue label / comment-driven backend selection.
   Only the global env plus `FACTORY_AGENT_OVERRIDES` path is supported.
5. Replacing the JSONL session storage backend, the harness hook pipeline, or the existing compaction settings.
6. Any change to `docs/factory-upgrade-implementation-plan.md`'s M0–M6 reliability migration scope; the Unified Agent Runtime sits downstream of that contract.
7. Skill-manifest-level backend override.
   The WIP chose `FACTORY_AGENT_OVERRIDES` as the per-role override surface; this spec respects that decision and does not introduce a parallel manifest-level override.

### Data and Contract Surface

| Entity | Field | Purpose |
| --- | --- | --- |
| `AgentBackend` | string literal in `{embedded, claude-code, codex-cli, pi-cli}` | Stable identifier referenced by `FACTORY_AGENT_BACKEND`, `FACTORY_AGENT_OVERRIDES`, and log fields. |
| `AgentSelection` | `{ backend: AgentBackend, model?: string }` | Per-role override entry parsed from `FACTORY_AGENT_OVERRIDES` JSON; the `model` field is optional and falls back to the backend-level default. |
| `StageRunRequest` | `{ role, issue, runId, artifactId, inputManifest, rules, skills, model, timeoutMs, abortSignal }` | Backend-agnostic input handed to every backend. |
| `StageRunResult` | `{ status, output, structuredOutput, usage, logTail, backend, warnings, retryable }` | Backend-agnostic output. `status` is one of `succeeded`, `failed`, `interrupted`, `cancelled`, `format-error`. |
| `BackendDescriptor` | `{ id, displayName, capabilities, schemaVersion, buildHash }` | Registry entry; `capabilities` enumerates which role categories (`readOnly`, `mutating`, `publishing`) the backend supports in this slice. |
| `AgentSelectionLog` | `{ backend, source }` (`source` ∈ `{default, overrides, executable-env}`) | Traceable selection provenance for log lines. |

## Decisions

### Decision 1 — Backend selection precedence is `overrides[role] > default`

`FACTORY_AGENT_BACKEND` is read once at startup and stored as the global default in the process-wide registry.
`FACTORY_AGENT_OVERRIDES` is parsed once at startup as a JSON object mapping each `AgentRole` to either a backend id string or `{ backend, model }` entry.
A role with no entry in `FACTORY_AGENT_OVERRIDES` inherits the global default.
Invalid `FACTORY_AGENT_BACKEND`, malformed `FACTORY_AGENT_OVERRIDES`, or unknown role keys fail the startup pre-check with the same severity as the existing `load_skill` regression (F01).
The selection decision is logged as `AgentSelectionLog` so log readers can see whether `default` or `overrides` was used.

### Decision 2 — `HarnessLlmEngine` was the original `embedded` backend; Slice C removed it

Originally (Slices A and B) the `src/core/harness.ts` + `src/core/llm-agent.ts` path was registered as the `embedded` backend through the same `BackendDescriptor` shape as every other backend, with no opt-in branch and no fallback branch in the dispatcher — selection was uniform.
Slice C (Group 8) removed `HarnessLlmEngine`, `src/core/llm.ts`, and `src/core/model-adapter.ts`, and dropped `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` from `package.json`.
The dispatcher is now the only LLM entry point; there is no `embedded` backend in the registry.
The default `FACTORY_AGENT_BACKEND` (when the env var is unset) is therefore `claude-code`, not `embedded`.
The capability flag `capabilities.readOnly` is still honoured by the dispatcher so `review-pr` (and the other read-only roles) can be wired first without exposing mutating stages to an under-validated backend; in Slice C this gate widens to every pipeline role because the dispatcher is the only path.

### Decision 3 — Stage rollout sequence is enforced, not policy

1. **Slice A — Abstraction extraction**: extract the unified runtime entry; register `embedded` and a stub `claude-code` placeholder; existing six-agent pipeline still on `embedded` only.
2. **Slice B — Claude Code on `review-pr` (read-only)**: enable `claude-code` for `review-pr` via `FACTORY_AGENT_OVERRIDES`; verify external CLI process lifecycle, structured result, logging, timeout, and crash recovery; do not touch any publishing stage.
3. **Slice C — Implementation + tool services**: enable `claude-code` for `implementation` and any role that performs file mutation or Factory publish; verify real file changes, verification receipts, failure correction, and the publish commit/PR flow.
4. **Slice D — Codex CLI + Pi CLI**: register both under the same contract, with their own adapter modules, without changing the dispatcher.
5. **Slice E — Cross-backend & failure validation**: concurrent session isolation, no leftover processes after `cancel` / timeout / `kill`, inter-stage backend switches, authentication failure, format-error retry, recovery when an in-progress worktree already has uncommitted changes.
6. **Slice F — Optional auto-fallback**: gated on Slice E green, explicit `FACTORY_AGENT_BACKEND_FALLBACK` opt-in, and an audit trail that surfaces fallback events.

The user's brief explicitly defers Slice F until Slices B–E are stable, to prevent failed retries from overwriting still-unprocessed modifications.
This spec only commits to Slices A and B.
Slices D–F are referenced for context and named in `plan.md` as follow-on work, but are not part of this deliverable.

### Decision 4 — Read-only roles are wired before mutating roles

The first non-`embedded` backend goes live on a stage that produces no file mutation, no commit, no PR.
This means: no overwrite risk to in-progress worktrees, no publish risk, and the only side effect under test is log/result fidelity.
A backend that misbehaves on a read-only role cannot corrupt the issue's domain state, only its review verdict, which the existing review loop already handles.
This decision is the operational embodiment of CLAUDE.md's "复现 bug → 单元回归 → 集成验证 → 端到端验证" sequence applied to a new dependency.

### Decision 5 — Credential forwarding is centralised in `agentWorkerEnvironment`

The existing `agentWorkerEnvironment(env, config)` whitelist in `runtime/agent-backends.mjs` is the single place that decides which upstream credentials (`CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `CODEX_HOME`, `OPENAI_API_KEY`, `PI_CODING_AGENT_DIR`, etc.) are forwarded to a child worker for the selected backend.
This keeps the leak fix from commit `48cdd0e` enforceable through the same code path that selects the backend, instead of being duplicated at every CLI spawn site.

### Decision 6 — Logging fields are uniform across `embedded` and CLI backends

`StageRunRequest` and `StageRunResult` are the only surfaces downstream code observes.
Any backend-specific telemetry must be carried inside `logTail` and `warnings`, not in bespoke log shapes.
The factory's existing `panel-read-model.mjs` continues to consume the domain checkpoint; it does not need to learn per-backend log formats.

## Context

### Tone and Stack Constraints

- All new TypeScript modules conform to the existing `src/core/*.ts` strict-mode style and are picked up by `npm run typecheck`.
- No new runtime dependency is introduced — except `undici` (^8.10.2) for the GitHub REST client in `runtime/github-rest.mjs`.
  The Claude Code, Codex, and Pi CLIs are reached through their existing CLI surface (`@anthropic-ai/claude-code`, `codex`, `pi`) that are already mentioned in `docs/harness-architecture.md` and the `MEMORY.md` `pi-mono-scope-rename` entry.
  The undici exception is the GitHub REST write/read path (`runtime/github-rest.mjs` + `runtime/github-rest.d.mts`) that replaced the `gh` shell-outs in `src/github/git.ts` and `src/orchestrator/index.ts`; `undici` is the lowest-overhead HTTP client that ships with the Node.js 22 runtime contract (`engines.node >= 22.19.0`).
  If any other new dependency is required, this spec must be amended before code lands.
- Markdown content follows CLAUDE.md: one sentence per physical line in any `*.md` file under `specs/`.
- `FACTORY_AGENT_BACKEND` and `FACTORY_AGENT_OVERRIDES` follow the validation rules in `runtime/agent-backends.mjs`; invalid values must produce a startup pre-check failure, never silent defaults.

### Existing Patterns to Follow

- Tool registration pattern from `src/core/harness.ts` and the `load_skill` (F01) regression lessons: schema, implementation, and preflight share one registry row, and missing entries fail startup rather than degrading to no-op calls.
- Lane-isolated session model from `docs/harness-architecture.md`: the unified runtime must not break the `Session` + `Lane` boundaries; CLI backends run inside the same session, with their own lane configuration.
- Two-track testing used by `npm run typecheck` + `npm test` + `npm run test:cli`: new tests must slot into the existing runner without manual wiring.
- Lease and external operation handling from `scripts/factory-daemon.mjs` + `runtime/lease-manager.mjs`: a CLI backend must respect the existing lease lifecycle and must not silently inherit the lease of an `embedded` process.

### Open Questions to Reconfirm Before Slice C

1. Should `StageRunResult.status` distinguish `format-error` from `failed`, or stay a single `failed` with a `format-error` flag in `warnings`?
   The default in this spec is the former, matching the M3 contract decision, but Slice B may surface reasons to consolidate.
2. Does `FACTORY_AGENT_BACKEND` accept a comma-separated list for round-robin, or only a single value?
   This spec fixes on single-value; multi-value is deferred.
3. Does `FACTORY_AGENT_OVERRIDES` need a hot-reload API for daemon-mode overrides, or is per-process restart sufficient?
   Default in this spec: per-process restart sufficient; hot-reload is a future consideration.
4. Should `agentWorkerEnvironment` also forward `FACTORY_AGENT_OVERRIDES` itself (so a child worker spawned by a CLI backend inherits overrides), or strip it?
   Default in this spec: forward it; this keeps nested-overrides behaviour consistent with the parent factory.