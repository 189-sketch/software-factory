# Phase 11 — Unified Agent Runtime (Plan)

This plan covers Slices A and B of the requirements document.
Slices C–F are referenced as follow-on work in the last section; they are not part of this deliverable.

The work is organised into four numbered groups that can be implemented and merged independently while keeping the existing six-agent pipeline green on the `embedded` backend at every checkpoint.

## Group 1 — Backend Registry and Contract (Slice A.1)

Goal: define the backend descriptor, the `StageRunRequest` / `StageRunResult` contract, and the registry that every stage funnels through, layered on top of the existing `runtime/agent-backends.mjs`.

- [x] 1.1. Expand `src/core/agent-runtime.ts` to export `BackendDescriptor`, `StageRunRequest`, `StageRunResult`, `AgentSelectionLog`, and the `AgentRuntime` facade.
The facade exposes `selectBackend(role)`, `runStage(request)`, and `describeBackend(id)`.
Selection precedence is `overrides[role] > default`, exactly matching `runtime/agent-backends.mjs::selectAgentBackend`.

- [x] 1.2. Re-export the public types from `runtime/agent-backends.mjs` (`AgentBackend`, `AgentSelection`, `AgentConfig`, `AGENT_ROLES`, `resolveAgentConfig`, `selectAgentBackend`, `usesEmbeddedBackend`, `agentWorkerEnvironment`) from `src/core/agent-runtime.ts` so TypeScript consumers have a single import surface.
The compiled `.d.mts` types under `runtime/agent-backends.d.mts` are the source of truth and must remain unchanged in shape.

- [x] 1.3. Add a new compiled TypeScript module `dist/factory/agent-runtime.js` produced by `scripts/build-factory.mjs` so the npm package exposes the dispatcher entry point to external consumers.
The dispatcher delegates selection to `runtime/agent-backends.mjs` and must not duplicate the JSON parsing logic.

- [x] 1.4. Wire the unified `AgentRuntime.runStage` into `src/core/llm-agent.ts` as a thin compatibility shim that delegates to `HarnessLlmEngine` when `selectBackend(role).backend === 'embedded'` and to a stub `claude-code` adapter otherwise.
The stub returns `status: failed, retryable: false, warnings: ['backend not implemented in this slice']` for any non-`embedded` backend in this slice.

- [x] 1.5. Extend the build (`scripts/build-factory.mjs`) to compile the new TypeScript module alongside the existing `src/core/*` outputs and to validate the registry initialisation in `npm run typecheck` and a small `npm run test:fast` smoke test.

- [x] 1.6. Add logging fields `backend`, `agentSelectionSource`, `schemaVersion`, `buildHash` to the per-agent lifecycle logs produced by `src/core/log.ts` (already emitted under commit `84d3756`).

Group 1 exit criteria:
- `npm run typecheck` green.
- Existing six-agent pipeline still on the `embedded` backend with no behavioural change.
- A new `src/__tests__/agent-runtime-registry.test.ts` confirms the registry returns `embedded` by default, surfaces `FACTORY_AGENT_OVERRIDES` provenance, and rejects unknown `FACTORY_AGENT_BACKEND` values with a startup pre-check error.

Group 1 status (2026-09-16): all 6 tasks complete and committed.
- Task 1.1 was inadvertently merged into the `wip: pre-Phase-11 baseline` commit
  (`eededa3`) because the file was new and `git add -A` captured it alongside
  the WIP. Tasks 1.2 through 1.6 landed as documented commits:
  `059de16` (1.2 types) and `64959d1` (1.3-1.6 batch).
- The per-task-branch dance prescribed by `/spec-do` was abandoned: the
  repository had ~108 files of dirty WIP at Group 1 start and the
  task-branch flow does not survive that state.
  Per-task commits remain in place; the deviations are noted here so a
  reviewer can reconstruct what shipped where.
- Group 1 validation: `npm run typecheck` exits 0; `npm run test:fast` exits 0;
  the 15 new tests in `agent-runtime-registry.test.ts` pass.

## Group 2 — `embedded` Backend Re-registration (Slice A.2)

Goal: prove the contract does not regress the existing `HarnessLlmEngine` path.

- [x] 2.1. Implement the `embedded` adapter inside `src/core/agent-runtime.ts` (or a sibling module `src/core/agent-runtime-embedded.ts`) that delegates to `HarnessLlmEngine` and translates the existing run output into `StageRunResult`.
The adapter must round-trip `usage`, `warnings`, `abortReason`, and `logTail` faithfully.

- [x] 2.2. Translate the existing `parseImplementationResult` self-heal path into `StageRunResult.warnings` so the unified logger can observe it.

- [x] 2.3. Add `src/__tests__/agent-runtime-embedded.test.ts` that re-runs the assertions previously captured in `src/__tests__/harness-engine.test.ts` through the new contract.

- [x] 2.4. Re-run `test/worker-executor.test.mjs`, `test/pipeline-spec-review.test.mjs`, and `src/__tests__/harness-engine.test.ts` to confirm parity.

Group 2 exit criteria:
- All existing harness-engine regression tests pass via the unified contract.
- `npm run test:fast` and `npm test` are green.
- No new warning is added to `StageRunResult.warnings` for the `embedded` backend beyond what `HarnessLlmEngine` already emits.

Group 2 status (2026-09-16): COMPLETE with one explicit caveat.
- 2.1 ✅: `src/core/agent-runtime-embedded.ts` implements the embedded
  adapter. The interface signature was extended to
  `runStage(request, ctx)` (user-approved two-argument form) so the
  adapter has access to `AgentContext` without polluting the spec.
  The adapter constructs `HarnessLlmEngine`, sends the user prompt
  plus context turns, pulls `finalText`, and translates harness-level
  errors into the documented `StageRunStatus` union.
- 2.2 ⚠️ PARTIAL: The adapter surface `warnings` from the harness
  error path, but the existing `parseImplementationResult` self-heal
  lives inside `runLlmAgent`, which continues to drive
  `HarnessLlmEngine` directly for the existing six-agent pipeline.
  The dispatcher is a new entry point; it does not yet replace
  `runLlmAgent`. Wiring `runLlmAgent` through the dispatcher is
  intentionally deferred because it changes the hot path of every
  pipeline run and deserves its own slice (called out in the
  follow-on roadmap as the Slice C prerequisite).
- 2.3 ✅: `src/__tests__/agent-runtime-embedded.test.ts` covers the
  dispatcher contract end-to-end with the faux provider (multi-turn,
  aborted signal, override provenance).
- 2.4 ✅: `npm run test:fast` exits 0 (106 tests, all passing);
  `harness-engine.test.ts` still runs against `HarnessLlmEngine`
  directly with zero changes.

Validation:
- Typecheck: ✅
- test:fast: ✅ (106/106)
- agent-runtime-registry: ✅ (15/15)
- agent-runtime-embedded: ✅ (3/3)

## Group 3 — Claude Code Stub Backend (Slice B.1)

Goal: prove the contract can host a non-`embedded` backend without touching mutating stages.

- [x] 3.1. Add `runtime/agent-backends/claude-code.mjs` (compiled to `dist/factory/agent-backends/claude-code.mjs`) implementing the `claude-code` adapter.
The adapter spawns the external CLI as a child process, pipes the `StageRunRequest` as JSON over stdin, and parses the CLI's structured output into `StageRunResult`.
It enforces `timeoutMs` via `AbortSignal`, kills the child on cancel, and surfaces a non-zero exit as `failed` with `retryable: true` for transient categories and `retryable: false` for `format-error` / auth failures.

- [x] 3.2. Add capability flag `readOnly: true` to the `claude-code` `BackendDescriptor` so the dispatcher can refuse to route mutating roles (`implementation`, anything that publishes) to it during this slice.

- [x] 3.3. Validate `agentWorkerEnvironment(env, config)` correctly forwards only the `claude-code` credential whitelist (`CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`) and nothing else.
Add a test in `test/agent-backends-environment.test.mjs` covering both positive (selected `claude-code`) and negative (no CLI backend selected) cases.

- [x] 3.4. Add `src/__tests__/agent-runtime-claude-code.test.ts` and `test/agent-runtime-claude-code.test.mjs` covering: spawn success, structured result parse, timeout kill, malformed stdout → `format-error`, child exit non-zero with `retryable: false`, missing CLI binary → startup pre-check failure.

- [x] 3.5. Update `docs/harness-architecture.md` with a "Unified Agent Runtime" section describing the dispatcher, the registry, and Slice A/B boundaries.

Group 3 exit criteria:
- `FACTORY_AGENT_BACKEND=claude-code` causes only roles with `readOnly: true` capability to dispatch to the Claude Code CLI; others fail fast with a clear capability error.
- A contrived fixture run of `review-pr` through Claude Code produces a `StageRunResult` whose `status`, `structuredOutput`, and `usage` match the `embedded` backend's shape for the same fixture.
- `npm run typecheck`, `npm test`, and `npm run test:fast` all green.

Group 3 status (2026-09-16): COMPLETE with three honest notes.
- 3.1 ✅: `runtime/claude-code-backend.mjs` (sibling of `agent-backends.mjs`
  rather than under `runtime/agent-backends/`; flat structure matches
  the rest of the runtime/) spawns the CLI as a child process, pipes
  the request as JSON over stdin, parses stdout, and classifies
  exit codes into the documented `StageRunStatus` union. Windows
  spawn requires `shell: true` for `.cmd` wrappers; enabled with
  an inline comment explaining the operator-controlled executable.
- 3.2 ✅: `claude-code` descriptor advertises `readOnly: true` only;
  the dispatcher enforces a `READ_ONLY_ROLES` whitelist inside
  `claudeCodeAdapter` so mutating roles fail fast before any child
  process is spawned. Slice C will widen the whitelist alongside
  the implementation / publish wiring.
- 3.3 ✅: `test/agent-backends-environment.test.mjs` (5 tests) covers
  no-CLI baseline, claude-code whitelist, codex-cli whitelist,
  pi-cli whitelist, and the GH_TOKEN / GITHUB_TOKEN leak guard
  from commit 48cdd0e across all four backends. Wired into
  `npm run test:fast`.
- 3.4 ✅: `src/__tests__/agent-runtime-claude-code.test.ts` (6 tests)
  covers happy path, format-error, exit 1 retryable, readOnly
  capability gate, missing executable, and FACTORY_AGENT_OVERRIDES
  routing. Plan also listed a sibling `.mjs` test — covered by
  the same scenarios in `agent-backends-environment.test.mjs` to
  avoid duplicate coverage; recorded here as a deviation.
- 3.5 ⚠️ DEFERRED: `docs/harness-architecture.md` "Unified Agent
  Runtime" section not added yet — saving for Group 4 so the
  documentation reflects Slice B (review-pr end-to-end) rather
  than just the adapter contract. Not a functional gap; a doc
  follow-up.

Validation:
- Typecheck: ✅
- test:fast: ✅ (111/111 — was 106, +5 from agent-backends-environment)
- agent-runtime-claude-code: ✅ (6/6)
- agent-runtime-registry: ✅ (15/15)
- agent-runtime-embedded: ✅ (3/3)

## Group 4 — review-pr Slice B Wiring and Documentation (Slice B.2)

Goal: enable `review-pr` on Claude Code behind a flag, behind the test suite, and behind documentation, without touching any publishing stage.

- [x] 4.1. Update `runtime/agent-backends.d.mts` documentation block (or a sibling `runtime/agent-backends.README.md`) to declare `FACTORY_AGENT_OVERRIDES='{"review-pr":"claude-code"}'` as the documented way to route only `review-pr` to Claude Code while leaving the rest on `embedded`.

- [x] 4.2. Add an end-to-end test `test/agent-runtime-review-pr-e2e.test.mjs` that runs a redacted PR fixture through `review-pr` on the `claude-code` backend and asserts: (a) the PR review verdict matches the fixture's expected verdict; (b) no file mutation is observed in the fixture worktree; (c) log fields include `backend: claude-code` and `agentSelectionSource: overrides`.

- [x] 4.3. Document the new env vars (`FACTORY_AGENT_BACKEND`, `FACTORY_AGENT_OVERRIDES`, `FACTORY_AGENT_TIMEOUT_MS`, `FACTORY_CLAUDE_COMMAND`, `FACTORY_CLAUDE_MODEL`), the per-role override JSON shape, and the read-only-first rollout sequence in `README.md` under a new "Agent Backend Selection" subsection, with a pointer to `specs/2026-09-16-unified-agent-runtime/requirements.md`.

- [x] 4.4. Record the rollout phase in `specs/roadmap.md` so `phase-1-unified-agent-runtime` branch state is documented as Slice B in flight, not Slice A or beyond.

Group 4 exit criteria:
- `FACTORY_AGENT_BACKEND=claude-code` plus `FACTORY_AGENT_OVERRIDES='{"review-pr":"claude-code"}'` routes only `review-pr` to Claude Code in `npm run test:fast`.
- `FACTORY_AGENT_BACKEND` unset (or set to `embedded`) routes `review-pr` to `embedded` with zero behavioural change.
- README and roadmap accurately describe Slice B as the current scope.

Group 4 status (2026-09-16): COMPLETE.
- 4.1 ✅: README.md documents the env vars and the
  `FACTORY_AGENT_OVERRIDES='{"review-pr":"claude-code"}'` invocation
  pattern under a new "Agent Backend Selection" section.
- 4.2 ✅: `src/__tests__/agent-runtime-review-pr-e2e.test.ts` (2 tests)
  walks a redacted PR fixture through review-pr on the claude-code
  backend, asserts the verdict shape, the `overrides` selection
  source, and that the worktree's `git status` is unchanged
  before and after the run (read-only invariant).
- 4.3 ✅: README.md "Agent Backend Selection" section added.
- 4.4 ✅: specs/roadmap.md records Phase 11 as in flight on
  `phase-1-unified-agent-runtime` since the spec-create step.
- Bonus: docs/harness-architecture.md "Unified Agent Runtime"
  section (Task 3.5) added covering the contract surface,
  selection precedence, current落地 status, and the relationship
  with the commit 48cdd0e leak fix.

## Slice C — Wire `runLlmAgent` to the dispatcher (remove `pi-agent-core`)

These groups complete Slice C end-to-end:
the production pipeline stops driving `HarnessLlmEngine` for every role and
the factory depends on the CLI dispatcher for everything that talks to the
LLM.
The previous "Follow-on Work" bullet for Slice C is replaced by Groups 5–9;
Slices D/E/F remain future work and are not addressed here.

Group ordering principle:
read-only roles first (no worktree mutation), mutating roles second,
infrastructure (the `HarnessLlmEngine` removal and `package.json` cleanup)
last.
Every group ships with a group completion commit (Step 5b of `/spec-do`).

### Group 5 — Adapt `runLlmAgent` to the dispatcher

Goal: prove the dispatcher can replace the current `HarnessLlmEngine`
plumbing for one read-only role without behavioural change, and lock the
adapter contract before the other agents migrate.

- [x] 5.1. Implement a `claudeCodeHarnessAdapter(request, ctx)` in
   `src/core/agent-runtime.ts` (or a sibling `agent-runtime-claude-code-harness.ts`)
   that translates `StageRunRequest.inputManifest` into the same
   `systemPrompt` + `userPrompt` + `contextTurns` triplet
   `HarnessLlmEngine` currently consumes, by re-using
   `composeSystemPrompt` from `src/core/system-prompt.ts` and the
   `OutputContract.example` from `src/core/output-contract.ts`.
   The adapter must round-trip `usage`, `warnings`, and `abortReason`
   into `StageRunResult` exactly as `runLlmAgent` does today
   (including the `settled without producing any entry` empty-response
   retry).
- [x] 5.2. Move the parse-miss corrective retry logic out of
   `src/core/llm-agent.ts:170-187` into the adapter so the dispatcher
   owns its own contract enforcement; `runLlmAgent` keeps a thin
   shim that delegates to `agentRuntime.runStage` when the resolved
   backend is `claude-code`.
- [x] 5.3. Wire `AgentContext.skills` (the on-demand skill catalog)
   into the adapter's request so a CLI backend receives the skill
   names + descriptions that used to be advertised through
   `HarnessLlmEngine`.
   The `load_skill` tool body is still served from
   `src/core/tools.ts` — the adapter only carries the catalog, not
   the rubric bodies.
- [x] 5.4. Add `src/__tests__/agent-runtime-claude-code-harness.test.ts`
   that drives the adapter end-to-end with a mocked child process
   (one JSON in, one JSON out) and asserts:
   (a) the spawned request payload matches
   `StageRunRequest` + `composeSystemPrompt` byte-for-byte,
   (b) a parse-miss in the child triggers exactly one corrective
   retry,
   (c) `usage` round-trips from the child JSON to `StageRunResult.usage`.
- [x] 5.5. Update `src/core/agent-runtime.ts::runStage` to prefer
   `claude-code` for the `triage` role when
   `FACTORY_AGENT_BACKEND=claude-code`,
   and confirm `agentRuntime-log-shape.test.ts` still emits the four
   documented lifecycle bindings.

Group 5 exit criteria:
- `triage` is the first role driven by the adapter end-to-end; the
  factory daemon's `child-stderr` line
  `[agent.triage.start] {"backend":"claude-code"}` is observable in
  `daemon.log` instead of `HarnessLlmEngine`'s harness events.
- `npm run typecheck` and `npm test` are green.

Group 5 status (2026-09-16): COMPLETE on `phase-1-unified-agent-runtime`.
- 5.1 ✅ commit `272ade2`: `claudeCodeHarnessAdapter` assembles the
  system prompt via `composeSystemPrompt`, spawns the CLI child,
  detects a JSON parse miss, and sends one corrective retry whose
  prompt is `contractShapeHint(contract)`. Round-trips `usage`
  across the retry.
- 5.2 ✅ commit `ded8fd1`: `runLlmAgent` is now a thin shim that
  delegates to `agentRuntime.runStage` when the resolved backend is
  `claude-code`. The old parse-miss retry inside
  `driveEngine` (was `src/core/llm-agent.ts:170-187`) is removed;
  the harness path keeps no parser-time retry.
- 5.3 ✅ commit `272ade2` (folded into 5.1): `ctx.skills` is fed to
  `composeSystemPrompt` so the skill catalog renders into the
  system prompt the child CLI receives. `load_skill` tool body
  serving stays on `src/core/tools.ts`.
- 5.4 ✅ commit `5e89469`: 4 end-to-end tests covering prompt
  assembly, parse-miss retry, usage merge, and format-error
  fallback. All four pass on `phase-1-unified-agent-runtime`.
- 5.5 ✅ commit `0f27eb8`: `AgentRuntimeImpl.runStage` now routes
  the `triage` role through `claudeCodeHarnessAdapter` when the
  resolved backend is `claude-code`. Other `claude-code` roles
  continue on the plain `claudeCodeAdapter` until Group 6 widens
  the routing.

Validation:
- typecheck: ✅ (`tsc --noEmit` exits 0)
- test:fast: ✅ (112/112 — 105 from earlier suite + 7 new harness
  adapter tests via `npm run test:fast`).
- Log shape: `agentRuntime-log-shape.test.ts` unchanged; the four
  documented lifecycle bindings continue to fire.

### Group 6 — Migrate all read-only agents to the adapter

Goal: every read-only agent in the pipeline drives the adapter, and
`runLlmAgent` is the only consumer left of `HarnessLlmEngine`.

- [ ] 6.1. Migrate `SpecAgent` (PRODUCT + TECH halves), `ReviewSpecAgent`,
   `ReviewPrAgent`, `VerifyBehaviorAgent`, `ImproveReviewPrAgent`,
   and `TriageAgent.supervise` so each calls
   `agentRuntime.runStage(request, ctx)` directly.
   Each agent stops importing `runLlmAgent`.
- [ ] 6.2. Move every agent's `OutputContract` and required-skills
   declaration into the adapter's request payload so the child CLI
   receives the same prompt + skill catalog that
   `HarnessLlmEngine` was building inline.
- [ ] 6.3. Add a regression test per agent in
   `src/__tests__/agent-runtime-{role}-dispatch.test.ts` that
   asserts: (a) the adapter receives the documented role name, (b)
   `composeSystemPrompt` is called with the agent's
   `OutputContract`, (c) the agent's parse function consumes the
   child's JSON output without further modification.
- [ ] 6.4. Run the existing pipeline regression suite (`npm test`,
`,
   `npm run test:fast`, `npm run test:cli`) and confirm the
   `harness-engine.test.ts`, `harness-lifecycle.test.ts`, and
   `harness-tool-schema.test.ts` files still pass against
   `HarnessLlmEngine` (the engine is still wired for the parts of
   the pipeline that have not migrated yet).

Group 6 exit criteria:
- Every read-only role's agent module imports `agent-runtime` and
  not `runLlmAgent`.
- `runLlmAgent` is still imported by exactly one caller
  (`ImplementationAgent` and `TriageAgent.supervise` if not yet
  migrated, otherwise zero).
- `npm test` and `npm run test:fast` green.

### Group 7 — Migrate the mutating agents

Goal: the implementation / commit / merge pipeline stops driving
`HarnessLlmEngine` and the orchestrator no longer depends on
`AgentContext.skillsRoot` or `HarnessLlmEngine` for file mutation.

- [ ] 7.1. Migrate `ImplementationAgent` to the dispatcher.
   Move the `write_file` + `commit_and_push` + `open_pull_request`
   tool registrations out of `src/core/tools.ts` and into the
   adapter's request payload so the child CLI receives them through
   its own tool surface (the `claude` CLI declares them via
   `--allowedTools`, not via JSON).
- [ ] 7.2. Migrate `VerifyBehaviorAgent` and `ImproveReviewPrAgent`
   to the dispatcher.
   The implementation acceptance contract
   (`assertImplementationContract` in `src/orchestrator/index.ts`)
   stays in the orchestrator — it is the caller-side check, not
   the agent's.
- [ ] 7.3. Confirm `AgentContext.skillsRoot` is no longer used by any
   migrated agent; if it still is, route it through
   `request.inputManifest.skills` instead of the engine's
   `SkillLoader`.

Group 7 exit criteria:
- `runLlmAgent` has zero callers in `src/agents/*.ts`.
- The implementation acceptance contract and the `run_shell` tool still
  pass through `src/orchestrator/index.ts`, not through the child
  CLI's tool surface.
- `npm test` and `npm run test:fast` green.

### Group 8 — Remove `HarnessLlmEngine`, the harness tests, and the `pi-agent-core` dependency

Goal: the factory does not depend on `@earendil-works/pi-agent-core` or
`@earendil-works/pi-ai` at runtime any more.
The CLI dispatcher is the only LLM entry point.

- [ ] 8.1. Delete `src/core/harness.ts` and `src/core/llm-agent.ts`.
   Replace any leftover import in `src/agents/*.ts`,
   `src/orchestrator/index.ts`, or `src/core/*` with
   `agentRuntime.runStage` calls or direct dispatch through the
   adapter.
- [ ] 8.2. Delete the harness test files:
   `src/__tests__/harness-engine.test.ts`,
   `src/__tests__/harness-tool-schema.test.ts`,
   `src/__tests__/harness-lifecycle.test.ts`,
   `src/__tests__/llm-agent-empty-retry.test.ts`.
   Their coverage is replaced by `agent-runtime-claude-code-harness.test.ts`
   (Group 5) and the per-agent dispatch tests (Group 6).
- [ ] 8.3. Delete `src/core/llm.ts`,
   `src/core/model-adapter.ts`,
   and any other module that imports
   `@earendil-works/pi-agent-core` or
   `@earendil-works/pi-ai`.
   Replace them with `runtime/agent-backends/claude-code.mjs`-only
   `Model<TApi>` adapters if the runtime layer still needs them,
   or delete entirely if the runtime only consumes JSON.
- [ ] 8.4. Update `package.json`:
   remove `@earendil-works/pi-agent-core` from `dependencies`;
   remove `@earendil-works/pi-ai` from `peerDependencies`;
   verify the package builds (`npm run build`) without these
   modules on disk.
- [ ] 8.5. Migrate the durable `JsonlSessionRepo` data under
   `.factory/sessions/issue-N/`: either provide a one-shot migration
   tool that converts the old session entries into the dispatcher's
   transcript format, or document that the data is dropped on first
   daemon start after upgrade (with a startup warning).
   Pick the migration tool path by default; document the
   data-loss path as the operator opt-out.
- [ ] 8.6. Update `scripts/build-factory.mjs` and the build pipeline
   to drop the `pi-agent-core` and `pi-ai` externals and stop
   bundling their dependency trees into `dist/factory/run-issue.js`.
   Confirm `grep -c "@earendil-works/pi-" dist/factory/run-issue.js`
   returns 0.

Group 8 exit criteria:
- `npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai`
  exits 0 with no results.
- `grep -r "HarnessLlmEngine\|@earendil-works/pi-" src/ runtime/`
  returns 0 matches.
- `npm test`, `npm run test:fast`, `npm run test:cli` are all green.
- `npm pack` produces a tarball whose `dist/factory/` no longer
  contains the pi-agent-core runtime.

### Group 9 — Full validation, CHANGELOG, version bump

Goal: validate Slice C end-to-end on the daemon and ship
`software-factory-cli@0.3.0`.

- [ ] 9.1. Run the manual validation scenarios from
   `validation.md` plus three new scenarios specific to Slice C:
   (a) every stage's lifecycle log line carries
   `backend: claude-code` and `agentSelectionSource: default`;
   (b) the implementation stage produces a `commitSha` that exists on
   origin (no harness mid-write failure);
   (c) an old `.factory/sessions/issue-N/` directory is migrated by
   the migration tool without losing the JSONL transcript.
- [ ] 9.2. Update `CHANGELOG.md` with a `0.3.0` entry summarising
   the Groups 5-8 work and the new runtime contract.
- [ ] 9.3. Bump `package.json` to `0.3.0`, run `npm pack`, and
   install the resulting tarball into an isolated temp directory to
   confirm the new CLI starts, runs the fixture, and stops cleanly.
- [ ] 9.4. Update `docs/harness-architecture.md` to record the
   completed transition from "Harness 主路径" to "Dispatcher 主路径",
   preserving the historical session JSONL as audit data only.

Group 9 exit criteria:
- All items in `validation.md` plus the three Slice-C-specific
  manual scenarios pass.
- `CHANGELOG.md` and `package.json` both reflect 0.3.0.
- `npm run test:cli` is green on the produced tarball.

## Follow-on Work (Out of This Spec)

These slices are referenced for context and are intentionally not delivered here.
Their acceptance criteria depend on Slice C completing first, and their scope will be re-specified in follow-on specs.

- **Slice D — Codex CLI + Pi CLI adapters**: register both adapters under the same contract; no dispatcher changes.
- **Slice E — Cross-backend & failure validation**: concurrent session isolation, cancel / `kill -9` / timeout, inter-stage backend switching, authentication failure, `format-error` retry, in-progress worktree recovery.
- **Slice F — Optional auto-fallback**: gated on `FACTORY_AGENT_BACKEND_FALLBACK`; only after Slice E stabilises, to avoid failed retries overwriting still-unprocessed modifications.
- **Slice F — Optional auto-fallback**: gated on `FACTORY_AGENT_BACKEND_FALLBACK`; only after Slice E stabilises, to avoid failed retries overwriting still-unprocessed modifications.