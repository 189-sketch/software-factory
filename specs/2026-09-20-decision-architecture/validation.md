# Validation: Decision Architecture (Phase A)
> 7-layer pyramid.
> Each layer: command / expect / block.
> spec-testing verifies each layer against this file.
> Phase A is documentation-only; the layers below validate the spec itself, not runtime behaviour.
>
> **Phases B–E extension (added by T11.0).**
> Every layer below gained Phase B/C/D/E commands and expectations once the implementation phases landed on this branch.
> Phase A lines are preserved verbatim; where a Phase A assertion was intentionally flipped by Phase B (e.g. `BACKEND_DESCRIPTORS` now contains `typesafe`), the original line is kept and annotated as superseded, and the current assertion lives in the Phase B–E subsection of the same layer.

## L1 单元 (Unit)

- command: `npm test`
- expect: line coverage on the spec-validation script (`scripts/spec-lineage-check.mjs`, introduced by T7.0) ≥ 80%; `npm run typecheck` exits 0; no new lint warnings introduced by the spec dir
- block: true

### Spec-lineage unit checks (executed by `scripts/spec-lineage-check.mjs`)

| Check | What it asserts |
| --- | --- |
| Required files exist | `requirements.md`, `plan.md`, `validation.md`, all present |
| Frontmatter present | `requirements.md` has `test_runner:` and `parent_phase:` fields |
| Sections present | `requirements.md` has every section listed in §0 of this file (Scope / Decisions / Decision Inventory / State Shape Contract / Freshness Protocol / `decisions.yaml` Schema / Composite Scoring Rubric / CJK Fallback Contract / Context / Technical Risks) |
| Inventory row count | All five tables A/B/C/D/E have the documented row count (A=5, B=16, C=4, D=5, E=4 = 34 migratable + 3 deterministic annotations; total 37 rows; non-deterministic rows: 32) |
| file:line resolve | Every `file_path:line` reference in the inventory resolves to an existing line in the current tree (T1.1) |
| YAML schema parses | The `decisions.yaml` example block in `requirements.md` parses as YAML 1.2 |
| Composite weights sum | `0.30 + 0.25 + 0.20 + 0.25 = 1.00` ± 0.01 |
| Required-rule count | The `requirements.md` lists 8 decisions (Decision 1 through Decision 8) |
| CJK fallback clauses | The CJK Fallback Contract section contains all four clauses: trigger conditions, behaviour, observability, test contract |
| Phase B boundary | The Out of Scope section lists at least seven deferred items with Phase B or Phase C tags |

### Phase B–E unit test files (added by T11.0)

`npm test` executes every row below (the TypeScript files via the `src/__tests__/*.test.ts` glob, the `.mjs` files via `test:fast` / direct `node --test`).
Each file is also runnable individually with the listed command.

| Test file | Individual command | Covers |
| --- | --- | --- |
| `src/__tests__/agent-runtime-typesafe.test.ts` | `node --import tsx --test src/__tests__/agent-runtime-typesafe.test.ts` | T8.0 `typesafe` registration in `BACKEND_DESCRIPTORS` + `agent-backends.mjs` env surface |
| `src/__tests__/typesafe-backend.test.ts` | `node --import tsx --test src/__tests__/typesafe-backend.test.ts` | T8.1 `runtime/typesafe-backend.mjs` HTTP adapter + fallback envelope |
| `src/__tests__/judgment-state.test.ts` | `node --import tsx --test src/__tests__/judgment-state.test.ts` | T8.2 `JudgmentState` / `buildJudgmentState` / `stateHashFor` |
| `src/__tests__/decisions-validate.test.ts` | `node --import tsx --test src/__tests__/decisions-validate.test.ts` | T8.3 `loadDecisions` / `validateDecisions` / `READ_ONLY_ACTIONS` / startup pre-check |
| `src/__tests__/freshness-poc.test.ts` | `node --import tsx --test src/__tests__/freshness-poc.test.ts` | T8.4 `freshnessCheck` + `judgment.skip` contract |
| `src/__tests__/typesafe-fallback.test.ts` | `node --import tsx --test src/__tests__/typesafe-fallback.test.ts` | T8.5 CJK fallback trigger conditions (network/4xx/5xx, missing key, low confidence) |
| `src/__tests__/triage-typesafe.test.ts` | `node --import tsx --test src/__tests__/triage-typesafe.test.ts` | T9.0 triage A1/A2/A3/B12/B13/B14 batch + cached-triage reuse |
| `src/__tests__/review-pr-typesafe.test.ts` | `node --import tsx --test src/__tests__/review-pr-typesafe.test.ts` | T9.1 review-pr B7/B8 migration |
| `src/__tests__/verify-behavior-typesafe.test.ts` | `node --import tsx --test src/__tests__/verify-behavior-typesafe.test.ts` | T9.1 verify-behavior B9/B10/B11 migration |
| `src/__tests__/spec-typesafe.test.ts` | `node --import tsx --test src/__tests__/spec-typesafe.test.ts` | T9.2 spec.ts B1/B2/B3 migration |
| `src/__tests__/review-spec-typesafe.test.ts` | `node --import tsx --test src/__tests__/review-spec-typesafe.test.ts` | T9.2 review-spec.ts B4/B5 migration |
| `test/typesafe-fallback-cli.test.mjs` | `node --test test/typesafe-fallback-cli.test.mjs` | T8.5 `FACTORY_TYPESAFE_OFF=1` offline escape hatch (CLI level) |
| `test/freshness-poc-cli.test.mjs` | `node --test test/freshness-poc-cli.test.mjs` | T8.4 freshness PoC at the daemon/CLI seam |
| `test/typesafe-calibration.test.mjs` | `node --test test/typesafe-calibration.test.mjs` | T9.3 calibration gate (frozen 100-issue fixture, PASS exit 0) |
| `test/decisions-loader.test.mjs` | `node --test test/decisions-loader.test.mjs` | T10.1 `runtime/decisions-loader.mjs` YAML parse + validate |
| `test/panel-api-decisions.test.mjs` | `node --test test/panel-api-decisions.test.mjs` | T10.1 `GET /api/decisions` in `runtime/panel-api.mjs` |

- expect: every file above exits 0; `npm run typecheck` exits 0
- block: true

### Spec-lineage Phase B/C/D/E tracks (added by T11.0)

- command: `node scripts/spec-lineage-check.mjs` (runs the 12 original Phase A checks plus the four new track checks)
- expect: all checks exit 0

| Track check | What it asserts |
| --- | --- |
| `phase-b` | `BACKEND_DESCRIPTORS` contains `typesafe`; `runtime/typesafe-backend.mjs` exports `runTypesafeStageFromConfig`; `runtime/decisions.yaml` exists and parses via `runtime/decisions-loader.mjs`; `scripts/freshness-poc.mjs` exports `freshnessCheck`; `src/core/judgment-state.ts` exports `JudgmentState` / `buildJudgmentState` / `stateHashFor` |
| `phase-c` | every code-migrated judgment ID appears in its agent file (triage.ts → A1/A2/A3/B12/B13/B14; review-pr.ts → B7/B8; verify-behavior.ts → B9/B10/B11; spec.ts → B1/B2/B3; review-spec.ts → B4/B5); `src/core/decision-router.ts` exports both `applyDecision` and `DecisionRouter`; `runtime/panel-read-model.mjs` exports `scoreOperationalJudgments`; `scripts/typesafe-calibration.mjs` exists |
| `phase-d` | control-panel components exist (`HealthBadge.tsx`, `ConfidenceSparkline.tsx`, `FallbackBadge.tsx`, `RoutingConfigView.tsx`); `runtime/panel-api.mjs` contains the `GET /api/decisions` route |
| `phase-e` | `docs/harness-architecture.md` has the Decision Architecture section; this `validation.md` contains L1–L7 with the new Phase B–E test file names; `CHANGELOG.md` has Phase B/C/D/E entries under `Unreleased / Decision Architecture` |

- block: true

## L2 接口 (API/Contract)

- command: `node --import tsx --test src/__tests__/spec-decision-architecture-contract.test.ts` *(Phase A line, superseded — see the Phase B–E contract surface below; the frozen `.draft` stub was replaced by the real module in T8.2)*
- expect: the `JudgmentState` interface excerpt in `requirements.md` matches a frozen TypeScript stub at `src/core/judgment-state.ts.draft` (introduced by T7.0 as a draft declaration; the contract test diffs the spec's TypeScript block against the stub); the `decisions.yaml` example parses against a JSON Schema derived from §"`decisions.yaml` Schema"
- block: true

### Contract test surface

- `JudgmentState` interface: every field in the spec's interface block exists in the stub; field types match exactly; optional fields use `?:`.
- `decisions.yaml` schema: every example row's keys are a subset of the documented schema's allowed keys; `confidence_min <= confidence_max` per action; `composite.*` weights sum to `1.0 ± 0.01`.
- `READ_ONLY_ACTIONS` closed set: the orchestrator's closed set in Phase B must contain every action referenced in the example rows (`freshness.skip`, `triage.apply_label`, `review-pr.merge_pr`, `supervisor.retry`, `operator.escalate`); the test fails if the spec names an action outside the closed set.

### Phase B–E contract surface (updated by T11.0)

- command: `node --import tsx --test src/__tests__/judgment-state.test.ts src/__tests__/decisions-validate.test.ts`
- expect:
  - the `JudgmentState` stub check now compares against the REAL `src/core/judgment-state.ts` (landed by T8.2), not the Phase A `.draft` stub — `judgment-state.test.ts` asserts `buildJudgmentState` population rules and `stateHashFor` determinism (64-char SHA-256 hex) against the spec's §"State Shape Contract" and §"Freshness Protocol";
  - the `decisions.yaml` schema test points at `src/__tests__/decisions-validate.test.ts`, which validates the shipped `runtime/decisions.yaml` end-to-end: `READ_ONLY_ACTIONS` lists the five example rows from `requirements.md`, `confidence_min <= confidence_max` per action, composite weights sum to `1.0 ± 0.01`, and every action is inside the `READ_ONLY_ACTIONS` closed set;
  - the adapter envelope contract (`runTypesafeStageFromConfig` request/result shape, CJK fallback warnings `typesafe_fallback_to_claude: <reason>`) is asserted by `src/__tests__/typesafe-backend.test.ts` and `src/__tests__/typesafe-fallback.test.ts`.
- block: true

## L3 冒烟 (Smoke)

- command: `npm run build`
- expect: build exits 0; the new `scripts/spec-lineage-check.mjs` is present; `dist/factory/` is unchanged (Phase A adds no compiled artifacts); the spec directory `specs/2026-09-20-decision-architecture/` is reachable from `tsconfig.json` include patterns if any TS draft files are added
- block: true

### Phase B–E smoke (added by T11.0)

- command: `npm run build:panel`
- expect: the control-panel build exits 0 with the new Phase D components (`HealthBadge`, `ConfidenceSparkline`, `FallbackBadge`, `RoutingConfigView`) compiled in; `npm run build` (which chains `build:factory` + `build:panel`) also exits 0
- block: true

### Markdown render smoke

- command: `node scripts/spec-render-smoke.mjs specs/2026-09-20-decision-architecture/`
- expect: every `*.md` file in the spec dir parses without markdown syntax errors that would break GitHub rendering; no unmatched code fences; no broken internal anchor links between files in the spec dir
- block: true

## L4 功能 (Feature)

- mapping: every task in `plan.md` §4 whose priority is P0 or P1 must have a corresponding test case below
- expect: all listed cases pass
- block: true

| Plan task | Test case | Command |
| --- | --- | --- |
| T1.0 | Inventory tables A/B/C/D/E present and complete | `node scripts/spec-lineage-check.mjs --check inventory` |
| T1.1 | file:line references resolve | `node scripts/spec-lineage-check.mjs --check lineage` |
| T2.0 | `JudgmentState` interface block matches stub | `node --import tsx --test src/__tests__/spec-decision-architecture-contract.test.ts` |
| T3.0 | Freshness protocol section complete | `node scripts/spec-lineage-check.mjs --check freshness` |
| T4.0 | `decisions.yaml` schema + examples | `node scripts/spec-lineage-check.mjs --check decisions-yaml` |
| T4.1 | Composite weights sum to 1.0 | `node scripts/spec-lineage-check.mjs --check composite-weights` |
| T5.0 | CJK fallback clauses complete | `node scripts/spec-lineage-check.mjs --check cjk-fallback` |
| T6.0 | Out of Scope lists ≥7 deferred items | `node scripts/spec-lineage-check.mjs --check out-of-scope` |
| T7.0 | validation.md L1–L7 present | `node scripts/spec-lineage-check.mjs --check validation-pyramid` |
| T7.1 | roadmap.md updated, CHANGELOG.md updated | `node scripts/spec-lineage-check.mjs --check roadmap-changelog` |
| T7.2 | `docs/decision-architecture.md` exists and renders | `node scripts/spec-render-smoke.mjs docs/decision-architecture.md` |

### Phase B–E feature map (added by T11.0)

| Plan task | Test case | Command |
| --- | --- | --- |
| T8.0 | `typesafe` registered in `BACKEND_DESCRIPTORS` + `agent-backends.mjs` env surface (`TYPESAFE_API_KEY`, `FACTORY_TYPESAFE_OFF`, `FACTORY_TYPESAFE_COMMAND`) | `node --import tsx --test src/__tests__/agent-runtime-typesafe.test.ts` |
| T8.1 | `runtime/typesafe-backend.mjs` HTTP adapter + CJK fallback envelope | `node --import tsx --test src/__tests__/typesafe-backend.test.ts` |
| T8.2 | `src/core/judgment-state.ts` (`JudgmentState` + `buildJudgmentState` + `stateHashFor`) | `node --import tsx --test src/__tests__/judgment-state.test.ts` |
| T8.3 | `runtime/decisions.yaml` + `loadDecisions`/`validateDecisions`/`READ_ONLY_ACTIONS` + startup pre-check + `computeHealth`/`healthBand` | `node --import tsx --test src/__tests__/decisions-validate.test.ts` |
| T8.4 | daemon `pollingLoop` freshnessCheck + `judgment.skip` log + daemon-tick health | `node --import tsx --test src/__tests__/freshness-poc.test.ts` and `node --test test/freshness-poc-cli.test.mjs` |
| T8.5 | CJK fallback triggers + `FACTORY_TYPESAFE_OFF=1` offline escape hatch + `docs/harness-architecture.md` §5 | `node --import tsx --test src/__tests__/typesafe-fallback.test.ts` and `node --test test/typesafe-fallback-cli.test.mjs` |
| T9.0 | triage.ts A1/A2/A3/B12/B13/B14 batch + `decision-router.ts` dual API (`applyDecision` fn + `DecisionRouter` class) | `node --import tsx --test src/__tests__/triage-typesafe.test.ts` |
| T9.1 | review-pr.ts B7/B8 + verify-behavior.ts B9/B10/B11 | `node --import tsx --test src/__tests__/review-pr-typesafe.test.ts src/__tests__/verify-behavior-typesafe.test.ts` |
| T9.2 | spec.ts B1/B2/B3 + review-spec.ts B4/B5 | `node --import tsx --test src/__tests__/spec-typesafe.test.ts src/__tests__/review-spec-typesafe.test.ts` |
| T9.3 | operational judgments D1–D5 (`scoreOperationalJudgments` seam) + calibration gate | `node scripts/spec-lineage-check.mjs --check phase-c` and `node --test test/typesafe-calibration.test.mjs` |
| T10.0 | HealthBadge / ConfidenceSparkline / FallbackBadge UI + strictly additive panel-read-model fields (`health`, `healthBand`, `stageConfidence`, `fallbackBadges`, 0.9× fallback downgrade) | `npm run build:panel` and `node --test test/panel-read-model.test.mjs` |
| T10.1 | `decisions-loader.mjs` + `GET /api/decisions` + RoutingConfigView page | `node --test test/decisions-loader.test.mjs test/panel-api-decisions.test.mjs` |
| T11.0 | validation.md L1–L7 extension + spec-lineage B/C/D/E tracks + CHANGELOG Phase B/C/D/E entries | `node scripts/spec-lineage-check.mjs` |
| T11.1 | production flip (`runtime/decisions.yaml` auto defaults, `FACTORY_DECISIONS_ENABLED=1`) + final regression gate | `npm run regression:b-e` (script created by T11.1; the L7 gate command) |

## L5 业务流程 (Business Flow)

- scenarios:
  - **BF1 — Phase A → Phase B handoff**: a fresh `spec-do` invocation that picks up `specs/2026-09-20-decision-architecture/plan.md` reports "all Phase A tasks complete; next action: spawn Phase B spec from §Out of Scope". The handoff does NOT trigger a code change; it produces a `worker_report.md` listing the spawn action.
  - **BF2 — Spec-lineage staleness check**: when any `file_path:line` reference in `requirements.md` inventory no longer resolves (e.g. a future refactor renames `src/agents/triage.ts:182` to a new location), `npm test` fails with a clear "spec-lineage-stale" message naming the offending reference. CI blocks merge.
  - **BF3 — freshness skip reuses cached triage end-to-end (added by T11.0)**: the daemon's `pollingLoop` runs `freshnessCheck(issue)` (A1 `Noul`) before enqueueing; when `noul_yes < threshold` it logs `judgment.skip` with `reason: "state_unchanged"` + `stateHash` and the issue is NOT re-triaged; on the triage side, `skip: true` returns the `cachedTriage` verbatim without a second A1 call. Verified by `src/__tests__/freshness-poc.test.ts`, `test/freshness-poc-cli.test.mjs`, and the cached-triage reuse tests in `src/__tests__/triage-typesafe.test.ts`.
  - **BF4 — CJK fallback surfaces gracefully without aborting the pipeline (added by T11.0)**: on network/4xx/5xx, missing `TYPESAFE_API_KEY`, or confidence below threshold, the typesafe adapter returns a `StageRunResult` with `warnings: ["typesafe_fallback_to_claude: <reason>"]` and the agent falls back to the preserved `parse()`/claude path; the pipeline never aborts and the fallback is observable (log + UI FallbackBadge with the 0.9× confidence downgrade). Verified by `src/__tests__/typesafe-fallback.test.ts` and `test/typesafe-fallback-cli.test.mjs`.
  - **BF5 — calibration gate blocks rollout on drift (added by T11.0)**: `scripts/typesafe-calibration.mjs` runs the frozen 100-issue fixture (`test/fixtures/calibration/issues-100.json`), computes per-dimension P50/P90 across two runs, and exits 1 with `CALIBRATION FAIL` + a per-issue report when stability exceeds ±0.05; the Phase E regression gate (`npm run regression:b-e`, T11.1) refuses to pass while calibration fails. Verified by `test/typesafe-calibration.test.mjs` (PASS path exit 0 + re-run determinism).
- command: `node scripts/spec-lineage-check.mjs --check end-to-end-handoff` (BF1/BF2); BF3–BF5 commands are the test files named in each scenario
- block: true

## L6 UI 交互 (UI/A11y)

- command: `node scripts/spec-render-smoke.mjs --ui` (renders `docs/decision-architecture.md` and any markdown excerpts that would surface in the control panel)
- expect: 0 critical markdown lint violations; 0 broken intra-doc anchor links; mermaid blocks in `plan.md` §1 parse without syntax errors
- block: false (auto-promoted to block if critical > 0)

### Phase B–E UI evidence (added by T11.0)

- command: the T10.0 headless Playwright visual check (seeded `FACTORY_STATE_DIR` + `vite` dev server on 127.0.0.1), evidence screenshots checked in at `specs/2026-09-20-decision-architecture/worker_reports/shots/t10-issue-list.png`, `shots/t10-issue-101-detail.png`, `shots/t10-issue-102-detail.png`
- expect: the shots show all three health colour bands (`< 0.5` red / `0.5–0.7` amber / `> 0.7` green) next to per-issue status, per-stage `ConfidenceSparkline` histograms keyed on run id, and the dashed `⇄ FALLBACK` badge on any stage whose last run was `typesafe_fallback_to_claude`; the `RoutingConfigView` page renders the parsed `decisions.yaml` (auto/confirm/escalate thresholds, read-only) behind the nav entry in `App.tsx`; `npm run build:panel` exits 0
- block: false (auto-promoted to block if critical > 0)

## L7 集成 (Integration)

- command: `npm run test:cli`
- expect: all external deps (mock + sandbox) pass; no P0 regression in the Phase 11 test surface; the new spec files are NOT included in the npm package's `files` field (Phase A is documentation-only)
- block: true

### Phase B–E integration gate (added by T11.0)

- command: `npm run regression:b-e` (created by T11.1; runs `npm test` + `npm run test:cli` + `npm run build:panel` + spec-check + the calibration script on a synthetic fixture and must exit 0)
- expect: exit 0; the calibration gate reports `CALIBRATION PASS`; this is the merge gate for Phases B–E
- block: true

### Cross-spec consistency checks (run as part of L7)

Phase A list (historical — preserved verbatim; annotations mark the lines Phase B intentionally flipped):

- The dispatcher in `src/core/agent-runtime.ts` is unchanged at HEAD. *(Phase A historical: Phase B added the `typesafe` descriptor + branch without disturbing the `claude-code` dispatch path — see the Phase B–E list below.)*
- `runtime/agent-backends.mjs::agentWorkerEnvironment` is unchanged at HEAD. *(Phase A historical: Phase B extended it to forward `TYPESAFE_API_KEY` only when typesafe is selected.)*
- `runtime/agent-backends.mjs::selectAgentBackend` is unchanged at HEAD. *(Phase A historical: unchanged selection precedence; `typesafe` simply joined the `BACKENDS` set.)*
- `BACKEND_DESCRIPTORS` in `agent-runtime.ts` does NOT yet contain a `typesafe` entry (that is Phase B's work). *(Superseded by Phase B — the assertion is flipped in the Phase B–E list below.)*
- `READ_ONLY_ROLES` in `agent-runtime.ts` is unchanged. *(Still true at Phase E.)*
- `package.json` `engines.node` is unchanged at `>=22.19.0`. *(Still true at Phase E.)*
- `specs/2026-09-16-unified-agent-runtime/requirements.md` Decision 3 reference to Slices C–F is unchanged. *(Still true at Phase E.)*

Any change to one of the above after this spec merges is a Phase B / Phase 11 slice change, NOT a Phase A regression.

Phase B–E list (added by T11.0 — current assertions):

- `BACKEND_DESCRIPTORS` in `src/core/agent-runtime.ts` NOW CONTAINS a `typesafe` entry (`displayName: "typesafe.ai Jev"`, `capabilities: { readOnly: true }`, `schemaVersion: 1`) — the Phase A assertion above is flipped.
- The `AgentBackend` union in `runtime/agent-backends.d.mts` includes `'typesafe'` (`'claude-code' | 'codex-cli' | 'pi-cli' | 'typesafe'`), and the `BACKENDS` set in `runtime/agent-backends.mjs` matches.
- `READ_ONLY_ROLES` in `agent-runtime.ts` is unchanged from Phase A (typesafe is read-only; no role widening).
- The agent-runtime dispatcher still preserves the Slice C single-path contract: `dispatchAgentStage` remains the only LLM entry point, the `claude-code` path is untouched, and every migrated agent keeps its existing `OutputContract` parser as the fallback path.
- `runtime/panel-read-model.mjs` changes are strictly additive: new `health` / `healthBand` / `stageConfidence` / `fallbackBadges` / `operationalJudgments` fields only; existing consumers and field semantics are unchanged (asserted by `test/panel-read-model.test.mjs`).
- New: `FACTORY_TYPESAFE_OFF=1` offline escape hatch forces the fallback regardless of API health and is verified by `test/typesafe-fallback-cli.test.mjs`.
- `package.json` `engines.node` remains `>=22.19.0`.
- `specs/2026-09-16-unified-agent-runtime/requirements.md` Decision 3 reference to Slices C–F remains unchanged.

## Definition of Done (DoD)

Phase A checklist (preserved):

- [ ] L1, L2, L3, L4, L5, L7 all block=true pass
- [ ] L6 has 0 critical violations
- [ ] All P0 tasks in `plan.md` §4 marked [x]
- [ ] `CHANGELOG.md` updated under `Unreleased / Decision Architecture`
- [ ] `specs/roadmap.md` updated with Phase 12 entry
- [ ] Phase A branch merged to `main`; spec dir deleted only after Phase B's spec replaces it
- [ ] No uncommitted changes
- [ ] No commit message in this phase adds the agent name as the author
- [ ] `docs/decision-architecture.md` exists and links to the spec

Phase B–E checklist (added by T11.0):

- [ ] All Phase B–E unit test files in L1 pass individually and via `npm test`
- [ ] `node scripts/spec-lineage-check.mjs` passes all Phase A checks plus the `phase-b` / `phase-c` / `phase-d` / `phase-e` tracks (exit 0)
- [ ] `npm run build:panel` exits 0 (L3 Phase B–E smoke)
- [ ] Every P0/P1 task T8.0–T11.1 is mapped in the L4 Phase B–E feature table and its command passes
- [ ] BF3 / BF4 / BF5 scenarios pass via their named test files
- [ ] L6 Phase D UI evidence screenshots present under `worker_reports/shots/` and RoutingConfigView renders
- [ ] Calibration gate: `node scripts/typesafe-calibration.mjs` reports `CALIBRATION PASS` and exits 0
- [ ] L7 gate: `npm run regression:b-e` exits 0 (script created by T11.1)
- [ ] `CHANGELOG.md` has Phase B / C / D / E entries under `Unreleased / Decision Architecture` with all Phase A content preserved
- [ ] No commit message in these phases adds the agent name as the author
