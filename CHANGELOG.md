# Changelog

## Unreleased - Production GitHub state integration (2026-09-30)

- Route orchestrator, daemon, panel, freshness and reconciler through authoritative GitHub issue state and trusted recovery comments.
- Require GitHub-ref leases in production, pass fencing receipts to workers, and remove file lease and lease-wait backends.
- Keep known external outcomes in recovery comments; reserve local receipts for unknown results.
- Stop blind replays of interrupted operations, observe comments/labels/merges remotely, and publish actionable operator instructions with a leased confirmation command.
- Remove production polling dependence on fetched and author-wake files; retain explicit offline fixtures.
- Fix Claude child execution inheriting the factory launcher directory instead of the target issue checkout, discovered by real spec generation against the demo repository.
- Bind private provider sessions to the checkout and refuse legacy or foreign-checkout resume contexts.

## Unreleased - Business freshness and legacy preflight (2026-09-30)

- Share business-input hashing and factory-comment classification between daemon polling and the TypeScript orchestrator.
- Exclude factory comments and runtime timestamps from freshness, while detecting human comment edits, deletions, and issue content changes.
- Keep freshness polling read-only so an input is not marked consumed before worker completion.
- Add explicit read-only legacy checkpoint inspection that reports authoritative GitHub state and rejects conflicting or unconfirmed progress.

## Unreleased - GitHub recovery storage foundation (2026-09-30)

- Add versioned, compressed GitHub recovery records with trusted-writer validation, revision-chain checks, secret/session exclusion, and explicit size budgets.
- Add private session storage, lease-checked writes, and durable upload journals that block later side effects until recovery is confirmed.
- Read all issue comment pages and reconcile lost POST responses without duplicate writes.
- Validate abrupt post-write process exit and recovery against a closed real-project test issue.
- Keep the production storage default unchanged until daemon, panel, freshness, and orchestrator readers are migrated together.


## Unreleased - Original workspace integration (2026-09-30)

- Preserve and merge the original workspace source changes without reverting the completed decision router and orchestrator refactors.
- Include the picture-book production manifests, original-audio timeline derivation, batch generation, scene assembly, and final media-path validation.
- Exclude build caches, package archives, Python bytecode, scratch scripts, and the separate harnessrouter checkout from source commits.


## Unreleased - Orchestrator responsibility modules (2026-09-30)

- Split the orchestrator into nine responsibility modules while preserving the existing bundle exports and private spec-phase entry point.
- Keep the spec revision loop, deterministic failure routing, operator waits, and external-operation publication behavior unchanged.
- Update pipeline contract tests for canonical labels, configured merge gates, unified failure budgets, and the extracted module locations.


## Unreleased - Factory decision and execution baseline (2026-09-30)

- Preserve the completed TypeSafe judgment contract, freshness routing, structured review gates, and spec rubric convergence fixes before the architecture refactors.
- Publish actionable operator instructions when the pipeline waits, and retain external-operation receipts for recovery.
- Keep the supported CLI backend contract and make fatal daemon failures exit visibly.


## Unreleased — TypeSafe Official Contract Migration (2026-09-21)

### Fixed

- **`runtime/typesafe-backend.mjs` + `.d.mts` now speak the OFFICIAL System One API** (https://docs.typesafe.ai/api). The previous `{model, state_hash, primitives:[{id,type,question,state}]}` envelope was a project-local invention that the real endpoint rejects with HTTP 400 — every production Jev judgment had been silently falling back to `typesafe_fallback_to_claude` since Phase B. Requests are now `{model, state, questions:{<id>:{type,instructions,criteria}}}` with one shared top-level `state` (removing the N-fold per-primitive state duplication); responses `{model, answers, usage}` are mapped back into the internal `structuredOutput: [{id, value, confidence}]` contract in request order, so all per-agent parsers, the spec-verdict veto layer, decision-router gates, and the control-panel read model are unchanged. Noul probabilities travel on the confidence channel (official noul answers carry no confidence), matching the existing triage/freshness readers. `usage.input_tokens/output_tokens` now populate `StageRunResult.usage` (previously hard-coded null).
- **Model alias defence**: the Phase B default `jev-fast` never existed upstream (400 "Unknown model"). All builders now default to `jev-latest`, and the adapter normalises legacy aliases (`jev-fast`, `jev` → `jev-latest`) with a `model_alias_normalised: <old> -> <new>` warning so a stale `FACTORY_TYPESAFE_MODEL` in an operator `.env` cannot take the judgment layer down.
- **`TYPESAFE_API_KEY` is forwarded to every worker unconditionally** (`runtime/agent-backends.mjs`). The per-role `selected.has('typesafe')` gate was wrong: the typesafe verdict layer is an independent judgment bypass, not a runtime backend, so under the default claude-code deployment the key was never forwarded and every triage freshness/batch call fell through to `TYPESAFE_API_KEY missing`.

### Changed

- All six request builders migrated to official `questions`/`instructions`/`criteria` shapes with per-stage judgment IDs unchanged (A1–A3/B1–B14): `src/agents/{triage,spec,review-spec,review-pr,verify-behavior}.ts`, `scripts/freshness-poc.mjs`. `state_hash` is no longer sent on the wire; local `stateHashFor` freshness caching and orchestrator stamping are unaffected.
- `scripts/typesafe-calibration.mjs`: official score questions with 4-level criteria; mock key bumped to `calibration-mock-v2` — **old `--record` files are invalid and must be regenerated**.
- `requirements.md` §"Decision 2" gains an Erratum documenting the wire-contract correction; historical worker reports are left unamended.

### Removed

- `src/core/jev-primitives.ts` (untracked, zero references): a parallel per-stage primitive design (B/C/D/E/F numbering) built on the fake envelope, conflicting with the live A1–A3/B1–B14 inventory.
- Stray untracked root copies `agent-backends.mjs` / `pipeline-definition.mjs` (the former's key-forwarding fix is now ported into `runtime/`).

## Unreleased — Decision Architecture (Phase A)

### Added (Phase A — architecture spec only)

- New spec `specs/2026-09-20-decision-architecture/` defines a "judgment / generation" layered architecture for the factory.
  - `requirements.md`: 8 decisions; full A/B/C/D/E judgment inventory (37 points; 32 migratable; 5 deterministic kept in code); `JudgmentState` shape contract; freshness protocol; `decisions.yaml` schema; composite scoring rubric; CJK fallback hard constraint.
  - `plan.md`: 7 groups / 11 tasks / DAG + task table dual-source.
  - `validation.md`: 7-layer pyramid (L1 unit via `npm test` + new `scripts/spec-lineage-check.mjs`; L2 contract via TypeScript stub vs spec diff; L3 smoke via build + markdown render; L4 feature mapping; L5 handoff + lineage staleness; L6 markdown lint; L7 cross-spec consistency against Phase 11).
- `scripts/spec-lineage-check.mjs`: 12 named checks (Node.js built-ins only) that verify the spec dir's structural completeness and cross-reference each `file:line` inventory entry against the current tree.
- `specs/roadmap.md` records Phase 12 (this phase) as `⏳ In Flight (Phase A — architecture spec only)`.

### Added (Phase B — typesafe backend + freshness Noul PoC)

- `runtime/agent-backends.mjs` (`TYPESAFE_API_KEY` credential forwarding, `FACTORY_TYPESAFE_OFF` offline toggle); `READ_ONLY_ROLES` unchanged.
  - *Erratum 2026-09-22:* `typesafe` is **not** registered in `BACKEND_DESCRIPTORS` (`src/core/agent-runtime.ts:303-311` only carries `claude-code`).
  - The Phase B narrative claim "`typesafe` registered in `BACKEND_DESCRIPTORS`" was incorrect — `typesafe` runs as an independent verdict adapter and is never dispatched as a generation backend.
  - The Phase B narrative claim "`FACTORY_TYPESAFE_COMMAND` validation" was imprecise. `runtime/agent-backends.mjs::agentWorkerEnvironment` 仍然把 `FACTORY_TYPESAFE_COMMAND` 转发给 worker 子进程,但 typesafe 走 HTTP(无 CLI subprocess),所以这是一个 dead forward:占用白名单一条但无消费方。config-time 没有任何代码读 `FACTORY_TYPESAFE_COMMAND`;设置它不会影响运行行为,不会报 warning,也不会导致启动失败。
  - The Phase B narrative claim "`READ_ONLY_ROLES` unchanged" still holds.
- `runtime/typesafe-backend.mjs` + `.d.mts`: HTTP adapter for `api.typesafe.ai/v1/systemone` implementing the CJK fallback envelope (`status: "failed"`, `warnings: ["typesafe_fallback_to_claude: <reason>"]`, `retryable: false`).
- `src/core/judgment-state.ts`: the real `JudgmentState` interface from the spec's State Shape Contract, plus `buildJudgmentState` (lazy population) and `stateHashFor` (SHA-256 freshness hash).
- `runtime/decisions.yaml` + `src/core/decisions.ts` (`loadDecisions` / `validateDecisions` / `READ_ONLY_ACTIONS` closed set, startup pre-check wired into the `FactoryOrchestrator` constructor) + `src/orchestrator/composite.ts` (`computeHealth` / `healthBand`).
- Freshness Noul PoC on the daemon polling path: `scripts/freshness-poc.mjs` (`freshnessCheck`), `judgment.skip` log event with `stateHash` + `noul_yes`, composite `health` attached to the `daemon-tick` log.
- Tests: `src/__tests__/{agent-runtime-typesafe,typesafe-backend,judgment-state,decisions-validate,freshness-poc,typesafe-fallback}.test.ts`; `test/{typesafe-fallback-cli,freshness-poc-cli}.test.mjs`.
- `docs/harness-architecture.md` gains §5 "Decision Architecture".

### Added (Phase C — per-agent judgment migration)

- `src/agents/triage.ts`: A1/A2/A3/B12/B13/B14 single `typesafe` batch over a shared `JudgmentState`; the freshness `Noul` (A1) runs first and a skip reuses the cached `TriageResult`.
- `src/core/decision-router.ts`: single function API with the former class's `blocking_findings_max` gate absorbed into `applyDecision`; `decisionRouter.apply` remains an alias.
- `src/agents/review-pr.ts` + `src/agents/verify-behavior.ts`: B7–B11 migration; existing `OutputContract` parsers preserved as the fallback path.
- `src/agents/spec.ts` + `src/agents/review-spec.ts`: B1–B5 migration, one HTTP batch per stage (not N).
- `runtime/panel-read-model.mjs`: `scoreOperationalJudgments` — the single seam aggregating operational judgments D1–D5.
- `scripts/typesafe-calibration.mjs` + frozen fixture `test/fixtures/calibration/issues-100.json`: acceptance gate computing per-dimension P50/P90 stability within ±0.05 across re-runs (exit 0 `CALIBRATION PASS` / exit 1 `CALIBRATION FAIL` with per-issue report).
- `src/core/typesafe-selection.ts` shared selection helper.
- Tests: `src/__tests__/{triage-typesafe,review-pr-typesafe,verify-behavior-typesafe,spec-typesafe,review-spec-typesafe}.test.ts`; `test/typesafe-calibration.test.mjs`.

### Added (Phase D — control-panel UI)

- `HealthBadge` / `ConfidenceSparkline` / `FallbackBadge` components wired into the issue list and issue detail views (Decision 6 colour bands `< 0.5 / 0.5–0.7 / > 0.7`; per-run confidence histograms; dashed fallback badge).
- `runtime/panel-read-model.mjs` extended strictly additively: `health`, `healthBand`, `stageConfidence`, `fallbackBadges` fields with the 0.9× confidence downgrade rule for fallback runs; existing consumers untouched.
- `runtime/decisions-loader.mjs` (dependency-free YAML 1.2 subset parser + validator) and `GET /api/decisions` in `runtime/panel-api.mjs`.
- Read-only "Routing Configuration" page: `control-panel/src/views/RoutingConfigView.tsx` + nav entry in `App.tsx`.
- Tests: `test/{decisions-loader,panel-api-decisions}.test.mjs`; extended `test/panel-read-model.test.mjs`.
- Playwright visual evidence: `specs/2026-09-20-decision-architecture/worker_reports/shots/t10-issue-list.png`, `t10-issue-101-detail.png`, `t10-issue-102-detail.png`.

### Added (Phase E — production rollout, in flight)

- T11.0: `validation.md` L1–L7 extended for Phases B–E (new unit test commands, `npm run build:panel` smoke, L4 feature map for T8.0–T11.1, BF3–BF5 business flows, flipped L7 cross-spec assertions); `scripts/spec-lineage-check.mjs` gains the `phase-b` / `phase-c` / `phase-d` / `phase-e` tracks (12 → 16 named checks); these Phase B/C/D/E CHANGELOG entries.
- T11.1 (pending): production flip of `runtime/decisions.yaml` defaults to `auto`, `FACTORY_DECISIONS_ENABLED=1` gate on the daemon enqueue path, and `npm run regression:b-e` as the L7 merge gate.

### Fixed

- **Author-voice override on the polling `state_unchanged` fast path** (`scripts/freshness-poc.mjs`, `scripts/factory-daemon.mjs`). Issue #46 (2026-09-24, title `"login"`) was picked up by the daemon, hit `state_unchanged` (none of the 5 freshness hash fields had moved), and was silently parked at `wait` via `decideResumeStage` even though the operator had just posted a comment. The fix has two parts: (1) `scripts/freshness-poc.mjs::freshnessCheck` now checks `latestVoiceIsAuthor(issue.comments)` before consulting the typesafe `resume_stage` primitive — when the most recent comment is non-factory voice the issue is enqueued with `skip:false, reason:"author_voice_override"` and the new hash is persisted before returning (no busy-loop). (2) `scripts/factory-daemon.mjs::fetchNextFromGitHub` now spreads the locally-fetched `comments` array into the returned issue object — the REST `/issues` list endpoint only returns a comment count (`runtime/github-rest.mjs` normalises it to `comments: []`), and the per-issue comment fetch was being stored in a local variable but not propagated back into `issue.comments`, so `freshnessCheck` always saw an empty array and the override could never fire in production. Mirrors the orchestrator's `latestVoiceIsAuthor` arm at `src/orchestrator/index.ts:766-769`. The daemon emits a dedicated `judgment.author-voice-override` log line so operators can grep override firings.

### Out of Scope (Phase A → Phase B / C)

- Phase B: `runtime/typesafe-backend.mjs` implementation; freshness `Noul` PoC on the daemon polling path; first single-agent migration (`triage-supervisor` is the candidate).
- Phase C: full per-agent judgment migration for all ~22 migratable points; spec testing; production rollout.
- Phase D: `control-panel/` UI changes to visualise confidence distributions and composite health.

### Notes

- Phase A is documentation-only. No file under `src/`, `runtime/`, `dist/`, `control-panel/`, `bin/`, `templates/`, or the published `software-factory-cli` package's `files` list was modified.
- `BACKEND_DESCRIPTORS`, `READ_ONLY_ROLES`, `runtime/agent-backends.mjs`, and `package.json` `engines.node` are unchanged at HEAD `7019dc6` / `4446cf3`.

## 0.3.0 — 2026-09-17

### Changed (Slice C — wire `runLlmAgent` to the dispatcher)

- The dispatcher is now the only LLM entry point. The
  `HarnessLlmEngine` / `embedded` backend is removed from
  `AgentBackend`, `BACKENDS`, and the dispatcher; the
  `FACTORY_AGENT_BACKEND` default is now `claude-code`.
- `runLlmAgent` is now a thin shim: when the resolved backend is
  `claude-code`, the call goes through `agentRuntime.runStage`,
  with the harness path kept as a no-op fallback for any future
  `codex-cli` / `pi-cli` adapter that wants it.
- New `claudeCodeHarnessAdapter` assembles the final system
  prompt through `composeSystemPrompt(role, skills, contract,
  requiredRules)`, spawns the Claude Code CLI, and detects a
  JSON parse miss (empty output, non-JSON, or top-level non-object
  value) to send one corrective retry whose prompt is
  `contractShapeHint(contract)`. `usage` is round-tripped across
  the retry so the orchestrator sees a single
  `StageRunResult.usage` covering both attempts.
- New `dispatchAgentStage` helper in `agent-runtime.ts` is the
  public entry point every read-only agent now calls in place of
  `runLlmAgent`. Each agent assembles its own
  `StageRunRequest` (with the `OutputContract` and
  `requiredRules` it needs) and passes the role-specific parse
  function.
- `StageRunRequest` extended with `outputContract?`,
  `requiredRules?`, and `tools?: AgentTool[]` so the adapter has
  everything `composeSystemPrompt` and the CLI tool surface
  need.
- `READ_ONLY_ROLES` widened to every pipeline role (read-only +
  mutating) so the dispatcher can route mutating agents in the
  next iteration. The capability gate stays — only unknown role
  names fail fast.
- `package.json`: removed `@earendil-works/pi-agent-core` from
  `dependencies` and `@earendil-works/pi-ai` from
  `peerDependencies`. The factory no longer depends on the
  Harness runtime.

### Removed

- `src/core/harness.ts` (HarnessLlmEngine + JsonlSessionRepo).
- `src/core/llm-agent.ts` (runLlmAgent + driveEngine).
- `src/core/agent-runtime-embedded.ts` (embeddedAdapter).
- `src/__tests__/harness-engine.test.ts`,
  `harness-lifecycle.test.ts`, `harness-tool-schema.test.ts`,
  `llm-agent-empty-retry.test.ts`,
  `agent-runtime-embedded.test.ts`.

### Tests

- 292/292 passing in `npm test` (180 TypeScript + 105 .mjs +
  7 implementation-contract).
- New `src/__tests__/agent-runtime-claude-code-harness.test.ts`
  (4 scenarios) covers prompt assembly, parse-miss retry,
  usage merge, and format-error fallback for
  `claudeCodeHarnessAdapter`.
- New `src/__tests__/agent-runtime-read-only-agents.test.ts`
  (6 scenarios) covers every read-only agent routed through
  `dispatchAgentStage`: triage, triage-supervisor,
  spec-product, review-pr, review-spec, verify-behavior.

## 0.2.0 — 2026-09-16

### Fixed

- `runtime/claude-code-backend.mjs`: `runClaudeCodeStageFromConfig`
  now defaults `extra.env` to `agentWorkerEnvironment(process.env,
  config)` so the Claude Code spawn path applies the credential
  whitelist (H-1 from
  `specs/2026-09-16-unified-agent-runtime/CODE_QUALITY_REVIEW.md`).
  Before this fix the wrapper silently fell back to `process.env`,
  regressing the commit 48cdd0e secret-leak protection for the
  `claude` child process.
- `runtime/claude-code-backend.mjs`: stdout / stderr buffers are
  now capped at 1 MiB each, with a `[truncated]` marker in
  `logTail` when a misbehaving CLI exceeds the cap (M-5).
- `runtime/claude-code-backend.mjs`: timeout now escalates to
  `SIGKILL` 5 s after `SIGTERM` so child processes that ignore
  graceful shutdown do not leave zombies (M-6).
- `runtime/claude-code-backend.mjs`: the wrapper now takes the
  model from the caller-resolved `request.model` instead of
  re-parsing `config.overrides[role]` (M-3) so the dispatch and
  the spawn path cannot drift.
- `specs/2026-09-16-unified-agent-runtime/`: Phase 11 Slice A/B
  spec-review applied the four validation-review fixes (build
  copies the Claude Code adapter to `dist/factory/agent-backends/`,
  `package.json` exports map exposes `./agent-runtime`,
  `test/cli-package.test.mjs` asserts the new packaging paths,
  `specs/roadmap.md` records Phase 11 as in-flight).

### Tests

- `test/agent-backends-environment.test.mjs` adds a real-spawn
  regression that drives `runClaudeCodeStageFromConfig` end-to-end
  with a polluted parent `process.env` and asserts the child
  process sees only the credential whitelist (no `GH_TOKEN`,
  `GITHUB_TOKEN`, or unrelated operator secrets).

### Changed (tech-debt cleanup from spec-review follow-up)

- `runtime/agent-backends.mjs`: AGENT_ROLES is now derived from
  `pipeline-definition.mjs`'s authoritative list (single source
  of truth, M-4). Stale `spec-product` / `spec-tech` entries that
  no caller references have been removed. `triage-supervisor` is
  now in a separate `INTERNAL_AGENT_ROLES` constant so
  `FACTORY_AGENT_OVERRIDES` rejects it explicitly (L-6).
- `runtime/claude-code-backend.mjs`: dropped 8 explicit
  `structuredOutput: undefined` assignments in error / cancel
  branches (L-2); the `.d.mts` and JSDoc now declare the field
  optional to match the runtime shape.
- `src/orchestrator/index.ts`: extracted `writeReviewBundle` so
  `prepareReviewArtifacts` and `prepareSpecReviewArtifacts`
  share the `git diff` / reviewDir mkdir / extra-file emission
  (L-4). Replaced `while (true)` in `runSpecPhase` with a
  `for`-bounded `MAX_SPEC_PHASE_ITERATIONS` guard so a future
  refactor cannot accidentally introduce an unbounded loop (L-3).
  Removed three stale refactor comments (M-1) and the `void
  changed;` no-op (M-2).
- `src/core/agent-runtime-embedded.ts`: `classifyError` and
  `classifyRetryable` are now exported (with documentation
  explaining why) so the harness error classification can be
  unit-tested without spinning up a full lane.
- `src/__tests__/agent-runtime-embedded.test.ts`: two new tests
  cover the `interrupted` / `format-error` / `failed` split and
  the retryable boundary (L-5).
- `runtime/lease-wait-state.d.mts`,
  `runtime/operation-receipts.mjs`, and
  `test/agent-backends-environment.test.mjs` now end with a
  trailing newline (L-1).

## 2026-09-16
- feat(spec): Group 6 — full validation + changelog
- feat(agent-runtime): Group 4 Slice B.2 — review-pr end-to-end + docs
- feat(agent-runtime): Group 3 Slice B.1 — Claude Code CLI backend wired
- feat(agent-runtime): Group 2 Slice A.2 — embedded adapter wired through HarnessLlmEngine
- docs(spec): record Group 2 not-started status and design decision
- feat(spec): complete group 1 - Backend Registry and Contract
- feat(agent-runtime): Group 1 Slice A.1 — dispatcher + registry + lifecycle bindings
- feat(agent-runtime): Task 1.2 — re-export backend type surface from runtime
- wip: pre-Phase-11 baseline — in-flight M0-M6 changes and unified-agent-runtime scaffolding

## 2026-09-15
- fix(daemon): stop leaking unrelated secrets to gh / git child processes
- feat(daemon): record death reason in daemon-death.json for diagnostics
- fix(daemon): reclaim stale lock by TTL, not just by process.kill probe
- fix(orchestrator): unstick issues previously marked failed by supervisor abort
- fix(implementation): auto-clean stale untracked files at worktree start
- fix(lease): reclaim orphaned leases whose holder pid is dead
- refactor(factory-comments): share isFactoryComment + author-voice override
- fix(triage): re-triage after author reply to needs-info
- fix(daemon): bridge runCommandWithRetry sync/async contract drift

## 2026-09-14
- feat(daemon): M2-M6 domain entities, manifest, findings, receipts, observability
- fix(daemon): M1 execution reliability (F01/F06/F07/F10)
- fix(daemon): add short-timeout budget for force-clear gh calls
- fix(daemon): skip fetchIssueFromGitHub for synthetic issues + bound force-clear retries
- fix(orchestrator): isolate review publish failures from stage verdict

## 2026-09-13
- feat(daemon): drain all ready issues per poll + auto-cleanup worktree after merge
- feat(daemon): worker pool + spec agent writes spec files
- fix(orchestrator): write spec bodies to worktree before commit
- fix(harness): force fresh lane per stage + jittered retry policies
- feat(orchestrator): commit implementation changes and open PR after agent exits
- feat(orchestrator): implementation acceptance contract + checkpoint source of truth
- fix(orchestrator): stop leaking review artefacts into implementation checkout
- fix(daemon): apply 30s default timeout to gh execFileSync + tee child output
- feat(observability): emit per-agent lifecycle logs
- fix(daemon): guard against null checkpoint and gh non-JSON payloads
- fix(triage): unblock needs-info loop on issues whose authors answer in comments

## 2026-09-09
- feat(cli): add --version / -v flag and bump to 0.1.2
- release: prepare v0.1.1 — package metadata, panel/agent updates, new tests

## 2026-09-04
- revert: publish under 'software-factory-cli' (unscoped), not @mustangai
- refactor(install): ship the factory as an npm package, not a source copy
- chore: bring along daemon + CLI test coverage and bin/scripts drift
- rename: pi-software-factory → software-factory
- Merge pull request #4 from 189-sketch/fix/p0-p1-factory-exclude-and-slug-naming
- fix(model-adapter): use dynamic import() for pi-ai (ESM), make buildModel async
- feat: ship pi-software-factory-cli package, ModelAdapter, and bundled control panel

## 2026-09-03
- Merge pull request #3 from 189-sketch/fix/p0-p1-factory-exclude-and-slug-naming
- fix(orchestrator): make verify-behavior advisory, not a merge gate
- Merge pull request #2 from 189-sketch/fix/p0-p1-factory-exclude-and-slug-naming
- fix: exclude factory/ from target commits and adopt slug-based file naming
- fix: harden factory end-to-end workflow

## 2026-09-02
- Drop stale fetched-N markers on daemon startup
- Wire the local daemon end-to-end through the factory pipeline
- Read FACTORY_* env vars (interval/webhook/local/workdir/state)
- Skip installer REPLACE_ME placeholders in .env loader
- Resolve npm.cmd from PATH; drop shell:true to silence Node 22+ deprecation
- Load .env + env fallbacks inside the daemon
- Fix bootstrap trap: WORK variable was being reset to empty
- Fix installer: copy src/ → factory/src (standalone project has no factory/ subdir)
- Document two-mode install (cloud + local daemon) and verified end-to-end demo

## 2026-09-01
- Add Windows daemon support (start.cmd + install-windows-service.ps1)
- Add factory-daemon + install wizard with cloud/local/both modes
- Add objective benchmark script (12/12 checks pass)
- Move workflows to templates/ for initial push (needs workflow scope to push directly)
- Real Chromium screenshots via Playwright in verify-behavior
- Check in PNG evidence fixtures + real-GitHub setup doc
- Stabilize tests + repo synth URLs + verify-behavior materialize
- Initial commit: multi-agent software factory
- Initial empty repo

All notable changes to the software factory are recorded in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased — 2026-09-16

### Added

Phase 11 — Unified Agent Runtime (Multi-CLI Backend).

Spec: `specs/2026-09-16-unified-agent-runtime/requirements.md` and
`plan.md`.

- `src/core/agent-runtime.ts` declares the `AgentRuntime` facade plus
  the `StageRunRequest` / `StageRunResult` / `BackendDescriptor` /
  `BackendCapabilities` / `AgentSelectionLog` / `ResolvedBackend`
  types. Selection precedence is `overrides[role] > default` and is
  read once at startup from `runtime/agent-backends.mjs`.
- `src/core/agent-runtime-embedded.ts` implements the `embedded`
  adapter: constructs `HarnessLlmEngine` from `ctx + request`, runs
  the user prompt + context turns, and translates harness errors
  into the documented `StageRunStatus` union.
- `runtime/claude-code-backend.mjs` (and its `.d.mts` declaration)
  implements the `claude-code` adapter: spawns the external CLI as a
  child process, pipes the request as JSON over stdin, parses the
  structured stdout, and enforces `timeoutMs` via `AbortSignal`.
  Windows spawn uses `shell: true` so `.cmd` wrappers are accepted.
- `AgentRuntimeImpl.runStage(request, ctx)` routes the `claude-code`
  selection through `claudeCodeAdapter`, which enforces a
  `READ_ONLY_ROLES` whitelist (currently only `review-pr`) so
  mutating roles fail fast without spawning. Capability flag
  `readOnly: true` on the descriptor remains the upstream guard.
- `backendBindingsFor(role)` and `bindingsForRuntime(rt, role)`
  emit the four documented lifecycle log fields
  (`backend`, `agentSelectionSource`, `backendSchemaVersion`,
  `backendBuildHash`) so downstream log enrichment stays uniform
  across `embedded` and the CLI backends.
- `scripts/build-factory.mjs` registers a new `agent-runtime` bundle
  entry alongside `orchestrator` and `run-issue`.
- `tsconfig.json` `include` extends to cover `runtime/**/*.d.mts` so
  TypeScript consumers can import the type surface from a single
  entry point.
- `docs/harness-architecture.md` adds a "Unified Agent Runtime
  (Slice A/B)" section documenting the contract, selection
  precedence, current landing status, and the relationship with the
  `commit 48cdd0e` leak fix.
- `README.md` adds an "Agent Backend Selection" subsection covering
  the new env vars (`FACTORY_AGENT_BACKEND`, `FACTORY_AGENT_OVERRIDES`,
  `FACTORY_AGENT_TIMEOUT_MS`, `FACTORY_<NAME>_COMMAND`,
  `FACTORY_<NAME>_MODEL`), the read-only-first rollout sequence, and
  the credential non-leak guard.
- `specs/roadmap.md` records Phase 11 (Unified Agent Runtime) as the
  pending phase on branch `phase-1-unified-agent-runtime`.

### Tests

- `src/__tests__/agent-runtime-registry.test.ts` (15 tests) — default
  backend, override precedence, startup pre-check failures, descriptor
  stability, stub runStage responses, log bindings shape.
- `src/__tests__/agent-runtime-embedded.test.ts` (3 tests) — multi-turn
  text in `output`, aborted signal → `cancelled`, override provenance.
- `src/__tests__/agent-runtime-claude-code.test.ts` (6 tests) — happy
  path, format-error, exit 1 retryable, readOnly capability gate,
  missing executable, `FACTORY_AGENT_OVERRIDES` routing.
- `src/__tests__/agent-runtime-review-pr-e2e.test.ts` (2 tests) —
  review-pr verdict shape, worktree `git status` unchanged before and
  after, lifecycle log bindings reflect overrides provenance.
- `src/__tests__/agent-runtime-log-shape.test.ts` (3 tests) —
  `backendBindingsFor` returns the four documented fields, override
  source honoured, `ConsoleLogger.child()` round-trip preserves them.
- `test/agent-backends-environment.test.mjs` (5 tests) — no-CLI
  baseline, claude-code whitelist, codex-cli whitelist, pi-cli
  whitelist, GH_TOKEN / GITHUB_TOKEN leak guard from `commit 48cdd0e`
  across all four backends. Wired into `npm run test:fast`.

### Notes

- Existing six-agent pipeline is not modified: `runLlmAgent` still
  drives `HarnessLlmEngine` directly. The `AgentRuntime` is a new
  entry point that the dispatcher surfaces; the `runLlmAgent` →
  dispatcher rewrite is intentionally deferred to a follow-on slice
  (Slice C prerequisite) to avoid changing the hot path of every
  pipeline run.
- Auto-fallback from a CLI backend to `embedded` is explicitly
  deferred to Slice F (post-Slice E), per the user's decision to
  avoid failed retries overwriting still-unprocessed modifications.
- Per-task-branch flow from `/spec-do` was not used: the repository
  had ~108 files of dirty WIP at Group 1 start, and the task-branch
  flow does not survive that state. Per-task commits remain in
  place; the deviations are recorded in `plan.md`.
