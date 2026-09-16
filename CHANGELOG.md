# Changelog

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
