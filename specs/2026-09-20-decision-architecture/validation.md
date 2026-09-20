# Validation: Decision Architecture (Phase A)
> 7-layer pyramid.
> Each layer: command / expect / block.
> spec-testing verifies each layer against this file.
> Phase A is documentation-only; the layers below validate the spec itself, not runtime behaviour.

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

## L2 接口 (API/Contract)

- command: `node --import tsx --test src/__tests__/spec-decision-architecture-contract.test.ts`
- expect: the `JudgmentState` interface excerpt in `requirements.md` matches a frozen TypeScript stub at `src/core/judgment-state.ts.draft` (introduced by T7.0 as a draft declaration; the contract test diffs the spec's TypeScript block against the stub); the `decisions.yaml` example parses against a JSON Schema derived from §"`decisions.yaml` Schema"
- block: true

### Contract test surface

- `JudgmentState` interface: every field in the spec's interface block exists in the stub; field types match exactly; optional fields use `?:`.
- `decisions.yaml` schema: every example row's keys are a subset of the documented schema's allowed keys; `confidence_min <= confidence_max` per action; `composite.*` weights sum to `1.0 ± 0.01`.
- `READ_ONLY_ACTIONS` closed set: the orchestrator's closed set in Phase B must contain every action referenced in the example rows (`freshness.skip`, `triage.apply_label`, `review-pr.merge_pr`, `supervisor.retry`, `operator.escalate`); the test fails if the spec names an action outside the closed set.

## L3 冒烟 (Smoke)

- command: `npm run build`
- expect: build exits 0; the new `scripts/spec-lineage-check.mjs` is present; `dist/factory/` is unchanged (Phase A adds no compiled artifacts); the spec directory `specs/2026-09-20-decision-architecture/` is reachable from `tsconfig.json` include patterns if any TS draft files are added
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

## L5 业务流程 (Business Flow)

- scenarios:
  - **BF1 — Phase A → Phase B handoff**: a fresh `spec-do` invocation that picks up `specs/2026-09-20-decision-architecture/plan.md` reports "all Phase A tasks complete; next action: spawn Phase B spec from §Out of Scope". The handoff does NOT trigger a code change; it produces a `worker_report.md` listing the spawn action.
  - **BF2 — Spec-lineage staleness check**: when any `file_path:line` reference in `requirements.md` inventory no longer resolves (e.g. a future refactor renames `src/agents/triage.ts:182` to a new location), `npm test` fails with a clear "spec-lineage-stale" message naming the offending reference. CI blocks merge.
- command: `node scripts/spec-lineage-check.mjs --check end-to-end-handoff`
- block: true

## L6 UI 交互 (UI/A11y)

- command: `node scripts/spec-render-smoke.mjs --ui` (renders `docs/decision-architecture.md` and any markdown excerpts that would surface in the control panel)
- expect: 0 critical markdown lint violations; 0 broken intra-doc anchor links; mermaid blocks in `plan.md` §1 parse without syntax errors
- block: false (auto-promoted to block if critical > 0)

## L7 集成 (Integration)

- command: `npm run test:cli`
- expect: all external deps (mock + sandbox) pass; no P0 regression in the Phase 11 test surface; the new spec files are NOT included in the npm package's `files` field (Phase A is documentation-only)
- block: true

### Cross-spec consistency checks (run as part of L7)

- The dispatcher in `src/core/agent-runtime.ts` is unchanged at HEAD.
- `runtime/agent-backends.mjs::agentWorkerEnvironment` is unchanged at HEAD.
- `runtime/agent-backends.mjs::selectAgentBackend` is unchanged at HEAD.
- `BACKEND_DESCRIPTORS` in `agent-runtime.ts` does NOT yet contain a `typesafe` entry (that is Phase B's work).
- `READ_ONLY_ROLES` in `agent-runtime.ts` is unchanged.
- `package.json` `engines.node` is unchanged at `>=22.19.0`.
- `specs/2026-09-16-unified-agent-runtime/requirements.md` Decision 3 reference to Slices C–F is unchanged.

Any change to one of the above after this spec merges is a Phase B / Phase 11 slice change, NOT a Phase A regression.

## Definition of Done (DoD)

- [ ] L1, L2, L3, L4, L5, L7 all block=true pass
- [ ] L6 has 0 critical violations
- [ ] All P0 tasks in `plan.md` §4 marked [x]
- [ ] `CHANGELOG.md` updated under `Unreleased / Decision Architecture`
- [ ] `specs/roadmap.md` updated with Phase 12 entry
- [ ] Phase A branch merged to `main`; spec dir deleted only after Phase B's spec replaces it
- [ ] No uncommitted changes
- [ ] No commit message in this phase adds the agent name as the author
- [ ] `docs/decision-architecture.md` exists and links to the spec
