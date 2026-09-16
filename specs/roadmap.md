# Roadmap

## Phases

### Phase 1: Factory CLI and Six-Agent Pipeline Foundation

- **Status**: ✅ Completed
- **Goal**: Ship a single npm package (`software-factory-cli`) that installs a daemon, runs triage → spec → implementation → review-spec → review-pr → verify-behavior → improve-review-pr, and publishes GitHub Actions workflow templates.
- **Deliverables**: `bin/factory.js` and `bin/factory-panel.js` CLIs, `scripts/factory-daemon.mjs`, six agents under `src/agents/`, skill manifests under `skills/`, GitHub Actions templates under `templates/github/workflows/`, npm tarball build via `npm run build` + `npm pack`.
- **Success Criteria**: `factory install --mode local` provisions a target repo without copying source; `npm test`, `npm run typecheck`, and `npm run test:cli` all pass; v0.1.x release tagged and published to npm as unscoped `software-factory-cli`.

### Phase 2: Harness Runtime Migration

- **Status**: ✅ Completed
- **Goal**: Replace per-stage `Agent` instantiation with a shared issue-scoped Harness session so every role runs inside the same session tree with lane isolation, hooks, compaction, and JSONL persistence.
- **Deliverables**: `src/core/harness.ts` harness factory, `src/core/llm-agent.ts` `HarnessLlmEngine` (legacy path deleted), `JsonlSessionRepo` per issue, model adapter unified via `ModelAdapter.buildRuntime()`, `scripts/poc-harness.mjs` for endpoint validation, `docs/harness-architecture.md`.
- **Success Criteria**: All LLM stages route through `AgentHarness.lane(...)`; typecheck and full test suite green; `BaseAgent` / legacy `Agent` removed from the tree; provider registry decoupled from harness construction.

### Phase 3: M0 — Baseline, Reproduction, and Test Wiring

- **Status**: ✅ Completed
- **Goal**: Convert issue #20 evidence into a stable, repeatable reproduction that the rest of the upgrade can be diffed against.
- **Deliverables**: Baseline snapshot (`factory-m0-baseline` memory), redacted checkpoint + session fixture under `fixtures/`, entry-point replay tool, test-inventory list of suite gaps, documented current worktree delta.
- **Success Criteria**: Same fixture run three times yields identical domain outcome; reproduction uses real CLI/daemon entry and isolated workspace; no production credentials or comments emitted.

### Phase 4: M1 — Execution Reliability Foundation

- **Status**: ✅ Completed
- **Goal**: Eliminate confirmed execution defects on the legacy state format before schema migration.
- **Deliverables**: Unified tool registration (`load_skill` schema + handler, missing-tool startup failure), required-rule preflight with content hash, fixed first-execution input manifest, lane observation (event filter / count / timeout / usage), separate content-result and lease-release-result records, TTL-based lease reclaim.
- **Success Criteria**: Regression tests for F01, F02, F03, F06, F07, F10 pass; second-round agent first tool call sees complete revisions; lease failures no longer mask content results or trigger busy-loop polling; old checkpoints still readable.

### Phase 5: M2 — Domain Model and Versioned Records

- **Status**: ✅ Completed
- **Goal**: Separate task lifecycle, stage execution, artifact versions, and external display into explicit domain entities on a `schemaVersion 2` checkpoint.
- **Deliverables**: `Task`, `StageRun`, `ArtifactRevision`, `RequirementBaseline`, `Decision`, `Finding`, `ExternalOperation` entities with run-bound versioning; serialized issue-level writes; read-only migration preview; controller lock + repository-level single-writer mode.
- **Success Criteria**: Task `active` and `StageRun` `succeeded/REJECT` can co-exist; every `waiting` carries a reason and `nextAttemptAt`; duplicate completion events do not advance state; missing review results are flagged, never auto-approved.

### Phase 6: M3 — Fixed Stage Input and Unified Artifact Handoff

- **Status**: ✅ Completed
- **Goal**: Replace free-form session history with explicit, hash-verified handoff contracts between stages.
- **Deliverables**: Per-`StageRun` input manifest (requirement versions, artifact refs, findings, decisions, rules, completion criteria); spec agent emits compact artifact manifest with body read by controller; reviewer and verification stages bind to specific artifact revisions; worker isolation across issues.
- **Success Criteria**: Two lanes without inherited history still hand off correctly; file-vs-summary mismatch fails fast; old hashes or missing artifacts cannot pass review or merge; output contract no longer requires returning full document body twice.

### Phase 7: M4 — Review Rules, Requirement Provenance, Convergence

- **Status**: ✅ Completed
- **Goal**: Stabilise the quality gate so every rejection cites a rule, an evidence path, and a baseline version, and so the loop terminates after bounded rounds.
- **Deliverables**: Versioned review rules loaded at startup; `RequirementBaseline` separation of user requirements, requirements, auto-comments, and accepted changes; finding lifecycle (`open`, `resolved`, `dismissed`, `superseded`); supervisor limited to genuine disputes and ambiguous requirements; bounded revision budget with explicit blocked state.
- **Success Criteria**: Issue #20's "已完整" cannot be promoted to CRITICAL on wording alone; same-account auto-comments never impersonate user decisions; resolved findings point to revision evidence; identical artifacts without new evidence trigger no-progress disposition instead of infinite rework.

### Phase 8: M5 — External Operation Recovery and Explicit Scheduling

- **Status**: ✅ Completed
- **Goal**: Make process interruption and network failure non-destructive to domain progress.
- **Deliverables**: Persistent `ExternalOperation` records persisted alongside the domain transition that caused them; reconciliation for `in-flight` and `unknown` states; comment/branch/PR/merge operations carry stable identity, expected remote state, query method, and receipt; lease release failures isolated from content success; explicit CLI continue/cancel/reassess commands.
- **Success Criteria**: Successful remote operation with lost response is reconciled by query, not by replaying content or creating duplicate PRs; display sync failure does not block local revision; unknown merge result cannot be reported `completed`; busy-loop polling on the same waiting task is eliminated.

### Phase 9: M6 — Observability, Migration Rehearsal, and Phased Rollout

- **Status**: ✅ Completed
- **Goal**: Ship a build that proves source-to-installed behaviour parity, exposes it through the control panel, and rolls out repository-by-repository.
- **Deliverables**: Panel and CLI read V2 domain state and show stage, run counts, revision versions, blocked reasons, next retry, and pending sync; uniform log fields (repository, issue, runId, stage, artifactId, operationId, event type); migration preview run on backups; staged release batches A/B/C/D with rollback rehearsal recorded; build identifier and supported schema range embedded in the published package.
- **Success Criteria**: Panel answers "why waiting / which artifact version / how to resume" without log stitching; isolated install of the built package matches source behaviour; rollback rehearsal recorded; stability thresholds met before any cache optimisation or fast-track experiment.

### Phase 10: Continuous Daemon Hardening

- **Status**: ✅ Completed
- **Goal**: Keep the daemon production-safe under crash, kill -9, and stale-lock scenarios after the reliability upgrade.
- **Deliverables**: Secret redaction for child `gh`/`git` processes, death-reason file (`daemon-death.json`), TTL-based lease reclaim (separate from PID probe), null-checkpoint and gh-non-JSON guards, sync/async retry contract bridge for `runCommandWithRetry`, drain-all-ready per poll, auto-cleanup of merged worktrees.
- **Success Criteria**: Repeated local runs do not leak tokens to subprocess environments; crashes leave recoverable evidence; force-clear respects ownership and TTL; merged worktrees are reclaimed without operator action.

### Phase 11: Unified Agent Runtime (Multi-CLI Backend)

- **Status**: ⬜ Pending
- **Goal**: Introduce a Unified Agent Runtime layer between the domain agents and the LLM execution backend so the factory can drive any of Claude Code, Codex CLI, or Pi CLI through the same task definition, contract, validation, and logging surface, instead of being locked to a single provider.
- **Deliverables**: `runtime/agent-backends.mjs` backend registry, `src/core/agent-runtime.ts` contract layer, per-backend adapters (`claude-code`, `codex`, `pi`), selection policy keyed off `FACTORY_AGENT_BACKEND` and per-stage overrides, harness-mode fallback rules, dedicated test suite under `src/__tests__/agent-runtime*.test.ts` and `test/agent-runtime*.test.mjs`.
- **Dependencies**: Phase 2 (Harness Runtime Migration) — runtime must preserve the existing `HarnessLlmEngine` contract for any stage that does not opt into a CLI backend.
- **Success Criteria**: A single domain agent stage can be executed by any of the three registered backends without source changes; missing backend or invalid selection produces a startup pre-check failure with the same severity as the current `load_skill` regression; per-stage usage, retries, and validation results are logged in a backend-agnostic shape; existing six-agent pipeline regression suite remains green.
- **Notes**: The working branch `phase-1-unified-agent-runtime` already contains exploratory files (`runtime/agent-backends.mjs`, `scripts/poc-harness.mjs`) for this work; the spec formalises scope, decisions, and validation, and supersedes that informal numbering.

---

**Last Updated**: 2026-09-16

> Pending phases, if any, are sourced exclusively from `TODO.md` at the project root.
> This run found no `TODO.md`, so the only pending phase was introduced by the active `/spec-create` invocation.
> Detailed phase intent for M0–M6 is preserved in `docs/factory-upgrade-implementation-plan.md` and should be treated as historical context, not as new work to schedule.