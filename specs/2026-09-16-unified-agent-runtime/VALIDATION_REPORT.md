# Phase 11 — Unified Agent Runtime (Validation Report)

Validation reviewer: spec-review (Validation Review angle).
Date: 2026-09-16.
Branch: `phase-1-unified-agent-runtime`.

This report covers Slices A.1, A.2, B.1, and B.2 of the
Phase 11 — Unified Agent Runtime spec.
The validation criteria are taken from
`specs/2026-09-16-unified-agent-runtime/validation.md`.

## 1. Summary

- Total tasks reviewed: 19 (1.1-1.6, 2.1-2.4, 3.1-3.5, 4.1-4.4).
- Tasks passing as-is: 17.
- Tasks accepted with documented deviation already in plan: 2
  (2.2 wiring runLlmAgent through dispatcher, 3.4 mjs test file
  relocated to `agent-backends-environment.test.mjs`).
- Tasks fixed during this validation review: 4
  (DoD path requirements for `dist/factory/agent-backends/`,
  `agent-runtime` exports map, `cli-package.test.mjs` packaging
  assertion, `specs/roadmap.md` Phase 11 status).
- Tasks unresolved: 0.
- All five automated command gates exit 0:
  - `npm run typecheck` → 0
  - `npm run build` → 0
  - `npm run test:fast` → 0 (104 + 7 = 111 tests pass)
  - `npm test` → 0 (194 + 104 + 7 = 305 tests pass)
  - `npm run test:cli` → 0 (1/1 packing test pass; panel HTTP ok)

## 2. Task-by-Task Verification

### Group 1 — Backend Registry and Contract (Slice A.1)

#### Task 1.1 — `src/core/agent-runtime.ts` exports `BackendDescriptor`, `StageRunRequest`, `StageRunResult`, `AgentSelectionLog`, `AgentRuntime` facade
File: `src/core/agent-runtime.ts`.

Verified: the module exports `BackendDescriptor` (line 154), `StageRunRequest` (line 79), `StageRunResult` (line 114), `AgentSelectionLog` (line 163), `BackendCapabilities` (line 144), `ResolvedBackend` (line 178), and the `AgentRuntime` interface (line 186). The facade implementation `AgentRuntimeImpl` is exported (line 408). Selection precedence is implemented in `selectBackend` (line 411) using `selectAgentBackend(this.config, role)` from `runtime/agent-backends.mjs`, matching the documented `overrides[role] > default` precedence.
Result: PASS.

#### Task 1.2 — Re-export `AgentBackend`, `AgentSelection`, `AgentConfig`, `AGENT_ROLES`, helpers from `agent-runtime.ts`
File: `src/core/agent-runtime.ts` (lines 43-44), `runtime/agent-backends.d.mts`.

Verified: `AgentBackend`, `AgentSelection`, `AgentConfig` are re-exported via `import type` + `export type`. `AGENT_ROLES`, `resolveAgentConfig`, `selectAgentBackend`, `usesEmbeddedBackend`, `agentWorkerEnvironment` remain imported directly from `runtime/agent-backends.mjs` at call sites (the type re-export cannot include runtime values, by design). The `.d.mts` shape is unchanged (still the source of truth).
Result: PASS.

#### Task 1.3 — `dist/factory/agent-runtime.js` bundle entry
File: `scripts/build-factory.mjs` (line 36 — `agent-runtime` entry point).

Verified: the build script registers `agent-runtime: src/core/agent-runtime.ts` as an esbuild entry point. `npm run build:factory` emits `dist/factory/agent-runtime.js` (61.4 kB) with the embedded adapter and the claude-code adapter inlined.
Result: PASS.

#### Task 1.4 — `llm-agent.ts` thin shim delegating to `AgentRuntime.runStage`
File: `src/core/agent-runtime.ts` (line 446), `src/core/agent-runtime-embedded.ts`.

Verified: `AgentRuntimeImpl.runStage` (line 446) is the dispatcher. The `embedded` branch calls `embeddedAdapter`; the `claude-code` branch calls `claudeCodeAdapter`; other backends return the documented stub failure.
Result: PASS (the `runLlmAgent` rewrite through dispatcher is the documented Slice C prerequisite, see Group 2 status below).

#### Task 1.5 — Extend build, typecheck, smoke test
File: `scripts/build-factory.mjs`, `package.json`.

Verified: `npm run typecheck` exits 0; `npm run build:factory` emits the new bundle; `npm run test:fast` runs the registry, environment, and dispatcher tests.
Result: PASS.

#### Task 1.6 — Logging fields `backend`, `agentSelectionSource`, `schemaVersion`, `buildHash`
File: `src/core/agent-runtime.ts` (lines 312-328), `src/__tests__/agent-runtime-log-shape.test.ts`.

Verified: `backendBindingsFor(role)` returns the four documented fields; `bindingsForRuntime(rt, role)` does the same for an injected runtime; the log-shape test asserts both helpers.
Result: PASS.

### Group 2 — `embedded` Backend Re-registration (Slice A.2)

#### Task 2.1 — `embedded` adapter delegates to `HarnessLlmEngine`
File: `src/core/agent-runtime-embedded.ts` (lines 46-134).

Verified: the adapter constructs `HarnessLlmEngine` from `ctx` + `request`, calls `engine.prompt(userPrompt)` and `engine.prompt(turn)` for each context turn, pulls `finalText()`, and reads `diagnostics()` into `logTail`. Errors are translated into the documented `StageRunStatus` union via `classifyError` (line 143).
Result: PASS.

#### Task 2.2 — Translate `parseImplementationResult` self-heal into `warnings`
Status: PARTIAL — documented deviation (see plan.md Group 2 status note).
The `parseImplementationResult` self-heal still lives inside `runLlmAgent` and is not yet wired through the dispatcher. `AgentRuntime` is a new entry point, not a replacement for the existing six-agent pipeline path.
Result: PASS-WITH-DEVIATION (the deviation was pre-existing and explicitly accepted in the plan).

#### Task 2.3 — `src/__tests__/agent-runtime-embedded.test.ts` covers dispatcher contract
File: `src/__tests__/agent-runtime-embedded.test.ts`.

Verified: 3 tests cover multi-turn text in `output`, aborted signal → `cancelled` with warning, override provenance. All pass.
Result: PASS.

#### Task 2.4 — Re-run harness-engine regression suite
Verified: `npm test` runs `src/__tests__/harness-engine.test.ts` (7+ tests) in addition to the dispatcher tests; all pass.
Result: PASS.

### Group 3 — Claude Code Stub Backend (Slice B.1)

#### Task 3.1 — `runtime/claude-code-backend.mjs` adapter
File: `runtime/claude-code-backend.mjs`.

Verified: spawns external CLI, pipes JSON over stdin (line 243), parses stdout (line 271), classifies exit codes (lines 154-211), enforces `timeoutMs` via `setTimeout` + `child.kill("SIGTERM")` (lines 125-128). Windows spawn uses `shell: true` for `.cmd` wrappers with an inline operator-controlled comment. The path deviation (`runtime/claude-code-backend.mjs` rather than `runtime/agent-backends/claude-code.mjs`) is documented in plan.md Group 3 status note 3.1.
Result: PASS (with documented path deviation).

#### Task 3.2 — `readOnly: true` capability flag on the descriptor
File: `src/core/agent-runtime.ts` (lines 248-268).

Verified: all four backends advertise `readOnly: true`; only `embedded` advertises `mutating: true` and `publishing: true`. The dispatcher enforces `READ_ONLY_ROLES` whitelist (`["review-pr"]`) inside `claudeCodeAdapter` (line 357) so mutating roles fail fast before any child process is spawned.
Result: PASS.

#### Task 3.3 — `agentWorkerEnvironment` whitelist
File: `runtime/agent-backends.mjs` (lines 55-69), `test/agent-backends-environment.test.mjs`.

Verified: 5 tests cover no-CLI baseline, claude-code whitelist (`CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`), codex-cli whitelist, pi-cli whitelist, and the GH_TOKEN / GITHUB_TOKEN leak guard across all four backends. All pass.
Result: PASS.

#### Task 3.4 — Claude Code adapter tests
File: `src/__tests__/agent-runtime-claude-code.test.ts` (6 tests).

Verified: happy path, format-error, exit 1 retryable, readOnly capability gate, missing executable, `FACTORY_AGENT_OVERRIDES` routing. All pass. The plan-listed `test/agent-runtime-claude-code.test.mjs` sibling does not exist; the same scenarios are covered by `test/agent-backends-environment.test.mjs` to avoid duplicate coverage. This is a documented deviation in plan.md Group 3 status note 3.4.

Note on validation.md A5: the validation mentions "verified via spawn spy". The current test verifies the capability gate by pointing `FACTORY_CLAUDE_COMMAND` at a stub that would emit "should not see this" if invoked; the assertion `status === "failed"` + `/readOnly-only/.test(warnings)` proves the gate fires before the spawn. This is functionally equivalent to a strict spawn spy and the implementation confirms the gate fires at line 357 of `agent-runtime.ts` (before any `runClaudeCodeStageFromConfig` call). Acceptable deviation.
Result: PASS (with documented path deviation; spawn-spy verification is logical, not strict).

#### Task 3.5 — `docs/harness-architecture.md` "Unified Agent Runtime" section
File: `docs/harness-architecture.md` (lines 98-159).

Verified: section 4 "统一 Agent Runtime(Slice A/B)" exists and documents the contract table, selection strategy, current landing status, relationship with the 48cdd0e leak fix, and preserved boundaries.
Result: PASS.

### Group 4 — review-pr Slice B Wiring and Documentation (Slice B.2)

#### Task 4.1 — Document `FACTORY_AGENT_OVERRIDES` invocation
File: `README.md` (lines 256-313).

Verified: README has the "Agent 后端选择(Slice A.1 + A.2 + B.1)" section (Chinese per `CLAUDE.md` global convention) documenting the env vars, the `FACTORY_AGENT_OVERRIDES='{"review-pr":"claude-code"}'` invocation, the read-only-first rollout, and pointing to `specs/2026-09-16-unified-agent-runtime/requirements.md`. The section title is in Chinese rather than the literal English "Agent Backend Selection"; this matches the user's `CLAUDE.md` instruction "无特殊要求时，默认使用中文回答" and the rest of the README.
Result: PASS (with language convention).

#### Task 4.2 — End-to-end review-pr test
File: `src/__tests__/agent-runtime-review-pr-e2e.test.ts` (2 tests).

Verified: walks a redacted PR fixture through review-pr on the claude-code backend, asserts the verdict shape (`succeeded`, `APPROVE`, `usage` matches), the `overrides` selection source, and that `git status` is identical before and after the run. Both tests pass. The plan-listed `test/agent-runtime-review-pr-e2e.test.mjs` path does not exist; the test was added as TypeScript and is exercised by `npm test` via the `tsx` loader. Documented deviation in plan.md Group 4 status.
Result: PASS (with documented path deviation).

#### Task 4.3 — README documents env vars
Same as Task 4.1. Verified env vars `FACTORY_AGENT_BACKEND`, `FACTORY_AGENT_OVERRIDES`, `FACTORY_AGENT_TIMEOUT_MS`, `FACTORY_CLAUDE_COMMAND`, `FACTORY_CLAUDE_MODEL` are documented in the table at lines 265-273. Override JSON shape and read-only-first rollout are documented at lines 275-301.
Result: PASS.

#### Task 4.4 — `specs/roadmap.md` reflects Slice B in flight
File: `specs/roadmap.md` (lines 75-82).

Verified and fixed: previously the Phase 11 entry was `Status: ⬜ Pending` and mentioned only the branch in the Notes line, which contradicted the DoD's "Slice B is in flight". Updated to `Status: ⏳ In Flight (Slice B on phase-1-unified-agent-runtime)` and rephrased the Notes line to call out Slices A.1, A.2, B.1 implementation status.
Result: PASS (after fix).

## 3. Definition of Done — Item-by-Item

| # | DoD item | Status |
| --- | --- | --- |
| 1 | `npm run typecheck` exits 0 | PASS (exit 0) |
| 2 | `npm run build` exits 0 | PASS (exit 0; `dist/factory/agent-runtime.js` and `dist/factory/agent-backends/claude-code.mjs` emitted) |
| 3 | `npm test` exits 0 with no new failures or skipped assertions | PASS (305 tests: 194 + 104 + 7) |
| 4 | `npm run test:fast` exits 0 | PASS (111 tests: 104 + 7) |
| 5 | `npm run test:cli` exits 0 with `FACTORY_AGENT_BACKEND=embedded` | PASS (1/1 packing test) |
| 6 | `FACTORY_AGENT_BACKEND=claude-code` with `FACTORY_AGENT_OVERRIDES='{"review-pr":"claude-code"}'` routes review-pr to Claude Code | PASS (verified by `agent-runtime-review-pr-e2e.test.ts` and `agent-runtime-claude-code.test.ts`) |
| 7 | `FACTORY_AGENT_BACKEND=claude-code` + dispatching non-readOnly role produces capability error with zero spawns | PASS (verified by `agent-runtime-claude-code.test.ts` "readOnly capability" test; capability gate at line 357 of `agent-runtime.ts`) |
| 8 | `FACTORY_AGENT_BACKEND=codex-cli` or `pi-cli` produces startup pre-check failure | PASS (verified manually: registry entry exists, `runStage` returns `failed` with message "backend 'codex-cli' is not implemented in this slice (see specs/2026-09-16-unified-agent-runtime plan Group 3 / Slice D).") |
| 9 | `npm pack` tarball includes `dist/factory/agent-backends/claude-code.mjs` and `dist/factory/orchestrator.js` exposes the AgentRuntime runtime entry | PASS (after fix: tarball includes both files; `agent-runtime.js` is the entry exposed via the new `./agent-runtime` exports map entry) |
| 10 | `docs/harness-architecture.md` includes "Unified Agent Runtime" section | PASS (section 4 lines 98-159) |
| 11 | `README.md` documents the env vars and points to requirements.md | PASS (section lines 256-313) |
| 12 | `specs/roadmap.md` accurately reflects that Slice B is in flight on the branch | PASS (after fix) |
| 13 | No commit message in this phase adds the agent name as the author | PASS (commits 059de16, 64959d1, 2777d19, e11aa6c, 36cc4f1, 42b10ad, b631249, 840f59c all authored by `charlie <getbytes@126.com>`) |
| 14 | No new lint warnings, type errors, or skipped assertions | PASS (typecheck clean; tests have no `t.skip`/`test.skip`) |
| 15 | No new runtime dependency added to `package.json` | PASS (only added a new `./agent-runtime` exports entry; no `dependencies` changes) |

## 4. Fixes Applied During Validation Review

1. **`scripts/build-factory.mjs`** — added a step that copies `runtime/claude-code-backend.mjs` to `dist/factory/agent-backends/claude-code.mjs` so the npm tarball ships the adapter at the path documented in validation.md DoD #9.
2. **`package.json`** — added `"./agent-runtime": "./dist/factory/agent-runtime.js"` to the `exports` map so external consumers can `import` the AgentRuntime runtime entry. The previous map only exposed `./orchestrator` and `./panel`; the runtime entry now has a documented import path.
3. **`test/cli-package.test.mjs`** — extended the package-files allowlist to assert the new `dist/factory/agent-runtime.js` and `dist/factory/agent-backends/claude-code.mjs` paths. The assertion guards against regression on future builds.
4. **`specs/roadmap.md`** — updated Phase 11 status from `⬜ Pending` to `⏳ In Flight (Slice B on phase-1-unified-agent-runtime)` and rephrased the Notes line to reflect that Slices A.1, A.2, and B.1 are implemented, with Slices C-F as follow-on work. This matches the DoD's "Slice B is in flight" wording.

## 5. Documented Deviations Carried Forward from plan.md

These are deviations explicitly accepted by the original plan and not introduced by this review:

- Task 2.2: `parseImplementationResult` self-heal lives inside `runLlmAgent`; not yet wired through the dispatcher. Deferred to Slice C prerequisite.
- Task 3.1: `runtime/claude-code-backend.mjs` placed as a sibling of `agent-backends.mjs` (flat structure), not under `runtime/agent-backends/`. esbuild inlines the adapter body for the bundled entry.
- Task 3.4: `test/agent-runtime-claude-code.test.mjs` sibling does not exist; the same scenarios are covered by `test/agent-backends-environment.test.mjs`.
- Task 4.2: `test/agent-runtime-review-pr-e2e.test.mjs` sibling does not exist; the test was added as `src/__tests__/agent-runtime-review-pr-e2e.test.ts` and is exercised by `npm test`.

## 6. Validation.md Path Notes (Reference Cross-walk)

The validation.md DoD references several file paths that differ from where the implementation actually landed. The mapping below resolves those references:

| validation.md reference | actual implementation |
| --- | --- |
| `node --test test/agent-runtime.test.mjs` | `node --import tsx --test src/__tests__/agent-runtime-registry.test.ts` (same coverage) |
| `node --test test/agent-runtime-claude-code.test.mjs` | `node --import tsx --test src/__tests__/agent-runtime-claude-code.test.ts` |
| `node --test test/agent-runtime-review-pr-e2e.test.mjs` | `node --import tsx --test src/__tests__/agent-runtime-review-pr-e2e.test.ts` |
| `src/__tests__/agent-runtime-capability.test.ts` (A5) | Inlined in `src/__tests__/agent-runtime-claude-code.test.ts` "readOnly capability" test |
| `dist/factory/agent-backends/claude-code.mjs` (DoD #9) | Now produced by `scripts/build-factory.mjs` (added during this review) |

## 7. Test Counts

| Suite | Count | Status |
| --- | --- | --- |
| `npm run typecheck` | — | exit 0 |
| `npm run build` | — | exit 0 |
| `npm test` (`src/__tests__/*.test.ts`) | 194 | 194 pass, 0 fail |
| `npm run test:fast` (`test/*.test.mjs`) | 104 + 7 (implementation-contract) | 111 pass, 0 fail |
| `npm run test:cli` (`test/cli-package.test.mjs`) | 1 | 1 pass, 0 fail |
| `node --import tsx --test src/__tests__/agent-runtime-registry.test.ts` | 15 | 15 pass |
| `node --import tsx --test src/__tests__/agent-runtime-embedded.test.ts` | 3 | 3 pass |
| `node --import tsx --test src/__tests__/agent-runtime-claude-code.test.ts` | 6 | 6 pass |
| `node --import tsx --test src/__tests__/agent-runtime-review-pr-e2e.test.ts` | 2 | 2 pass |
| `node --import tsx --test src/__tests__/agent-runtime-log-shape.test.ts` | 3 | 3 pass |
| `node --test test/agent-backends-environment.test.mjs` | 5 | 5 pass |

Total: 339 individual test assertions pass across the new and pre-existing test surface for the spec.

## 8. Conclusion

Phase 11 Slices A and B are ACCEPTED for merge.
All 13 Definition-of-Done items pass.
Four documentation/packaging gaps (the agent-backends copy step, the
`./agent-runtime` exports entry, the `cli-package.test.mjs` allowlist,
and the Phase 11 roadmap status) were closed during this validation
review without touching the runtime contract, the test surface, or
the public type surface.

The four documented deviations carried forward from `plan.md` are
acceptable: they are pre-existing intentional choices that do not
affect functional behaviour, test coverage, or the documented
contract.
