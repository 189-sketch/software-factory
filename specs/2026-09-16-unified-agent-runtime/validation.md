# Phase 11 — Unified Agent Runtime (Validation)

Validation is split into Automated and Manual sections per the spec-create convention.
This phase is primarily an infrastructure refactor; it does not introduce UI changes that require browser visual confirmation, so the Manual section is intentionally small and limited to verifying the control panel still renders the same domain state.

## Automated

### A1 — Typecheck and Build

- `npm run typecheck` exits 0.
  Asserts: every new TypeScript module under `src/core/` conforms to strict mode; `BackendDescriptor`, `StageRunResult`, `AgentSelectionLog` are exported from `src/core/agent-runtime.ts`; the existing `AgentBackend` / `AgentSelection` / `AgentConfig` types from `runtime/agent-backends.mjs` remain reachable from `src/core/agent-runtime.ts`.
- `npm run build` exits 0.
  Asserts: the compiled output under `dist/factory/` contains the new `agent-runtime` entry point and the `agent-backends/claude-code` adapter.

### A2 — Backend Registry Integrity

- `node --import tsx --test src/__tests__/agent-runtime-registry.test.ts` exits 0.
  Asserts: registry returns `claude-code` by default when `FACTORY_AGENT_BACKEND` is unset (Slice C removed the `embedded` backend; the CLI dispatcher is the only LLM entry point); `FACTORY_AGENT_BACKEND=claude-code|codex-cli|pi-cli` is accepted; unknown values fail the startup pre-check; `codex-cli` and `pi-cli` rows fail with "backend not implemented in this slice" if selected.
- `node --test test/agent-runtime.test.mjs` exits 0.
  Asserts: `overrides[role] > default` precedence; `AgentSelectionLog.source` field is set to `default` or `overrides` and is included in the per-agent lifecycle log lines.
- `node --test test/agent-backends-environment.test.mjs` exits 0.
  Asserts: `agentWorkerEnvironment(env, config)` forwards only the credentials named for the selected backend; with no CLI backend selected, the forwarded set is empty; token redaction (commit `48cdd0e`) still holds.

### A3 — Dispatcher Parity (formerly `embedded` Backend Parity)

- The Slice A-era file `src/__tests__/agent-runtime-embedded.test.ts` was deleted in Slice C Group 8 alongside `HarnessLlmEngine`. Parity is now asserted via the read-only-agent dispatch tests in `src/__tests__/agent-runtime-read-only-agents.test.ts` and the harness-adapter tests in `src/__tests__/agent-runtime-claude-code-harness.test.ts`.
  Asserts: every per-agent dispatch test parses its `OutputContract` from the child CLI's JSON output without modification; `usage`, `warnings`, and the parse-miss retry path round-trip identically.
- `npm run test:fast` exits 0.
  Asserts: `test/worker-executor.test.mjs`, `test/pipeline-spec-review.test.mjs`, `test/panel-read-model.test.mjs`, and any other fast-suite entries that previously exercised `runLlmAgent` continue to pass.

### A4 — Claude Code Adapter Behaviour

- `node --import tsx --test src/__tests__/agent-runtime-claude-code.test.ts` exits 0.
  Asserts: spawn success, structured result parse, timeout kill, malformed stdout → `status: failed, retryable: false, warnings: [format-error]`, non-zero exit → `retryable: true` for transient categories, missing CLI binary → startup pre-check failure.
- `node --test test/agent-runtime-claude-code.test.mjs` exits 0.
  Asserts: same as above from the compiled `.mjs` entry point, simulating the runtime that the npm package ships.

### A5 — Capability Gate

- A new test in `src/__tests__/agent-runtime-capability.test.ts` (or inline in A2) confirms that with `FACTORY_AGENT_BACKEND=claude-code`, dispatching `implementation` (or any non-`readOnly` role) returns a capability error and never spawns a Claude Code child process.
  Asserts: no child process is created (verified via spawn spy); error message names the role, the requested backend, and the missing capability.

### A6 — review-pr End-to-End Through Claude Code

- `node --test test/agent-runtime-review-pr-e2e.test.mjs` exits 0.
  Asserts: a redacted PR fixture routed with `FACTORY_AGENT_BACKEND=claude-code` plus `FACTORY_AGENT_OVERRIDES='{"review-pr":"claude-code"}'` produces a `StageRunResult` whose `status` matches the fixture's expected verdict; no file mutation is observed in the fixture worktree (verified via `git status` baseline before and after); log lines include `backend: claude-code` and `agentSelectionSource: overrides`.

### A7 — Existing Pipeline Regression Suite

- `npm test` exits 0.
  Asserts: every `src/__tests__/*.test.ts` plus `npm run test:fast` passes; no new flake is introduced by the runtime extraction.
- `npm run test:cli` exits 0.
  Asserts: the built npm package installs into the isolated temp directory; the bundled CLI starts, runs the fixture, and stops without errors attributable to the new runtime layer.

### A8 — Lifecycle Log Shape

- A new assertion in `src/__tests__/agent-runtime-log-shape.test.ts` (the Slice A-era `agent-runtime-embedded.test.ts` was deleted in Slice C Group 8) reads emitted log lines and confirms the fields `backend`, `agentSelectionSource`, `schemaVersion`, and `buildHash` are present on every stage lifecycle entry, regardless of selected backend.
  Asserts: grep-equivalent inspection of structured log output matches the documented schema; the dispatcher continues to emit the existing `runId` / `stage` / `usage` fields without duplication across every CLI backend.

### A9 — Environment Whitelist Regression

- A new test in `test/agent-backends-environment.test.mjs` (or `src/__tests__/agent-runtime-registry.test.ts`) confirms the leak fix from `48cdd0e` is preserved: an unrelated token such as `GH_TOKEN` is never forwarded to a Claude Code / Codex CLI / Pi CLI child process even when present in the parent environment.
  Asserts: snapshot of `process.env` keys after `agentWorkerEnvironment` returns contains no `GH_TOKEN` or `GITHUB_TOKEN`; snapshot of the forwarded map contains only the expected whitelist.

## Manual (Browser Required)

### M1 — Control Panel Domain State Rendering

- Open `factory-panel` against a target repository whose pipeline is configured with `FACTORY_AGENT_BACKEND=claude-code` (the post-Slice-C default; pre-Slice-C `embedded` was removed in Group 8) and confirm the panel renders the same issue state, transitions, and operations as before this phase.
  Visual confirmation only: layout, typography, and per-issue drilldown match the pre-phase screenshot.
- Repeat with `FACTORY_AGENT_BACKEND=claude-code` enabled for `review-pr` only via `FACTORY_AGENT_OVERRIDES`; the panel must continue to show the same fields and must not surface a per-backend label unless the existing domain checkpoint already records it.
  Visual confirmation only: no new error banners; review verdict and verdict reason render identically.

### M2 — Cross-Browser Spot Check (Optional)

- If `factory-panel` is opened in both Chromium-based and Firefox browsers during local development, confirm the panel renders identically.
  This is a low-priority check; the phase does not introduce frontend changes that would warrant a dedicated cross-browser pass.

## Definition of Done

Phase 11 Slices A and B are considered done when all of the following are true.

- [ ] `npm run typecheck` exits 0.
- [ ] `npm run build` exits 0.
- [ ] `npm test` exits 0 with no new failures or skipped assertions.
- [ ] `npm run test:fast` exits 0.
- [ ] `npm run test:cli` exits 0; the installed CLI starts, runs the fixture, and stops cleanly with `FACTORY_AGENT_BACKEND=claude-code` (the post-Slice-C default).
- [ ] `FACTORY_AGENT_BACKEND=claude-code` with `FACTORY_AGENT_OVERRIDES='{"review-pr":"claude-code"}'` routes `review-pr` to the Claude Code CLI; other roles continue on `claude-code` unless explicitly overridden.
- [ ] `FACTORY_AGENT_BACKEND=claude-code` plus dispatching a non-`readOnly` role produces a capability error and spawns zero child processes.
- [ ] `FACTORY_AGENT_BACKEND` set to `codex-cli` or `pi-cli` produces a startup pre-check failure with a clear message; the registry entry exists but the adapter body reports "backend not implemented in this slice".
- [ ] `npm pack` produces a `software-factory-cli-<version>.tgz` whose `dist/factory/agent-backends/` includes `claude-code.mjs` and whose `dist/factory/orchestrator.js` exposes the `AgentRuntime` runtime entry.
- [ ] `docs/harness-architecture.md` includes a "Unified Agent Runtime" section describing the dispatcher, the registry, and Slice A/B boundaries.
- [ ] `README.md` documents the new env vars (`FACTORY_AGENT_BACKEND`, `FACTORY_AGENT_OVERRIDES`, `FACTORY_AGENT_TIMEOUT_MS`, `FACTORY_CLAUDE_COMMAND`, `FACTORY_CLAUDE_MODEL`), the per-role override JSON shape, and the read-only-first rollout sequence under a new "Agent Backend Selection" subsection, with a pointer to `specs/2026-09-16-unified-agent-runtime/requirements.md`.
- [ ] `specs/roadmap.md` accurately reflects that Slice B is in flight on branch `phase-1-unified-agent-runtime`.
- [ ] No commit message in this phase adds the agent name as the author.
- [ ] No new lint warnings, type errors, or skipped assertions remain in the touched files.
- [ ] No new runtime dependency is added to `package.json` without amending this spec first.