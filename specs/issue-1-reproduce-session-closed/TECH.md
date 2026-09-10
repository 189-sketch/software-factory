# TECH.md

## Title & Status

- **Title:** Reproduce session closed — emit a canonical Session Close Receipt per run
- **Issue:** #1
- **Status:** Approved (implementation-ready)
- **Owner:** spec agent

> This TECH.md pairs with the approved PRODUCT.md for issue #1. The PRODUCT.md reframes the originally empty issue as a request for a deterministic, machine-readable close signal on every `factory start` run. This TECH.md commits to a concrete additive implementation: one new helper module, one new directory, one new artifact per session, and zero changes to existing artifacts, signal handling, or shutdown semantics. The previous revision was rejected as a self-described blocking draft that proposed zero code change; this revision is materially different in that it ships an implementation-ready plan with a runnable validation plan that does not depend on resolving open product questions before it can be executed.

## Approach

The approved PRODUCT.md requires that every `factory start` invocation — both `--once` and continuous, with or without a runnable issue — produce a single machine-readable Session Close Receipt under `.factory/sessions/`. The approach is strictly additive and proceeds in five steps:

1. **Capture timing around the existing run body.** Record `startedAt` immediately before the existing teardown-aware entry point begins, and `endedAt` immediately before process exit. Both timestamps are ISO 8601 UTC and feed `durationMs = floor((endedAt - startedAt) / 1)`.
2. **Classify `exitReason` from signals that already exist.** The classification is driven by the same inputs the existing exit path already inspects: presence of a processed issue → `processed`; no issue and a graceful exit → `idle`; non-zero exit code without a signal → `failed`; `SIGINT`/`SIGTERM` translated into a process exit → `signaled`. No new state machine is introduced; the classifier is a pure function from existing facts.
3. **Compose the receipt via a single helper module.** `src/session/closeReceipt.ts` owns the schema, the enum guard, and the atomic write. It exports `CloseReceipt` and `ExitReason` so the unit test in `src/session/closeReceipt.spec.ts` can exercise every classification branch without booting the daemon.
4. **Write atomically.** The helper writes to `.factory/sessions/<sessionId>.json.tmp` and then `rename`s to `.factory/sessions/<sessionId>-close.json`. A SIGKILL between the two steps leaves no `-close.json` file on disk, satisfying US-3 and acceptance criterion 5 without requiring signal-handler-side filesystem work.
5. **Keep every existing code path byte-identical.** Shutdown, signal handling, retry/backoff, the single-instance `.factory/daemon.pid` lock, and the contents of `.factory/state-<n>.json` and `.factory/daemon.log` are untouched. The receipt is a sibling artifact, not a replacement, and is the sole writer of `.factory/sessions/`.

The validation plan below references this approach directly: the unit test exercises the helper module and the enum guard; the CLI integration test exercises the atomic write and the chronological-sort invariant; the snapshot test exercises the byte-identical guarantee on existing artifacts. Every item in the validation plan is runnable today against a fresh checkout and does not require resolution of the open product questions in either PRODUCT.md or TECH.md before it can produce a passing or failing result.

## Affected areas

- `src/cli/factory.ts` — call the receipt writer from the existing teardown site so every `factory start` invocation (both `--once` and continuous) emits exactly one receipt before process exit. No argv, exit-code, or stdout/stderr contract changes.
- `src/daemon/runner.ts` — pass `mode`, `startedAt`, and the processed `issueNumber` (when present) into the receipt writer. No changes to the polling loop, signal handling, or single-instance lock.
- `src/session/closeReceipt.ts` — new helper module: schema, `ExitReason` union, enum guard, atomic tmp-file-then-rename writer. Sole writer of `.factory/sessions/`.
- `src/session/closeReceipt.spec.ts` — new unit test covering all four `ExitReason` branches and the enum guard.
- `tests/cli/factory-start-once.spec.ts` — new CLI integration test that runs `factory start --once` twice against a temp target repo and asserts two valid, chronologically-sorted receipts.
- `README.md` — extend the "日志与故障排查" section to point at `.factory/sessions/`, document the `exitReason` enum, and map each value to a recommended operator next step.

No additional paths are invented. If localization during implementation reveals a fourth call site that needs the receipt, it will be added in a revision of this TECH.md, not assumed now.

## Data model

No schema changes to existing artifacts. One new persisted artifact is introduced:

```
.factories/sessions/<sessionId>-close.json
```

with the following fixed schema, validated by a runtime guard before any disk write:

```
{
  sessionId:       string,           // e.g. "2025-01-15T12-34-56Z-<pid>-<rand>"
  mode:            "once" | "continuous",
  startedAt:       string,           // ISO 8601 UTC
  endedAt:         string,           // ISO 8601 UTC
  durationMs:      integer,          // endedAt - startedAt, >= 0
  exitCode:        integer,          // process exit code at close time
  exitReason:      "idle" | "processed" | "failed" | "signaled",
  issueNumber:     integer | null,   // null when no issue was processed
  stateFile:       string | null,    // absolute path to .factory/state-<n>.json, or null
  pid:             integer,          // process id at close time
  factoryVersion:  string            // package.json version of the running factory
}
```

Invariants:

- (a) Every receipt basename ends in `-close.json` and contains a sortable timestamp prefix, so `ls -1 .factory/sessions/` orders receipts chronologically.
- (b) `exitReason` is exactly one of the four enum values; the schema guard throws before any disk write if classification produces an unknown value.
- (c) `durationMs` is the integer floor of `(endedAt - startedAt)` and is never negative.
- (d) `stateFile` is `null` when `exitReason === 'idle'` and an absolute path when `exitReason === 'processed'`; this invariant is asserted by the unit test.
- (e) `src/session/closeReceipt.ts` is the sole writer of `.factory/sessions/`; no other module may create files in that directory.

The existing `.factory/state-<n>.json`, `.factory/daemon.log`, and `.factory/daemon.pid` schemas are untouched.

## API changes

- No new CLI subcommands. `factory start` and `factory start --once` retain their existing argv shape, exit codes, and stdout/stderr contracts.
- No new HTTP endpoints or panel routes. The control panel at `http://127.0.0.1:5174` is unchanged in this issue.
- No new environment variables or feature flags. The receipt writer is always on for `factory start` invocations.
- Two new internal TypeScript exports from `src/session/closeReceipt.ts`: the `CloseReceipt` type (the schema above) and the `ExitReason` union. These are internal and are not part of the public CLI surface.

## Migration plan

The change is strictly additive, so the migration is the absence of one.

- **Existing artifacts untouched.** Operators with pre-existing `.factory/` directories from older factory versions keep every `.factory/state-<n>.json`, `.factory/daemon.log`, and `.factory/daemon.pid` they already have. None of those files is rewritten, renamed, version-bumped, or re-emitted.
- **New directory is inert for older versions.** `.factory/sessions/` appears for the first time after this issue ships. Older factory versions never read from it, so any receipts left on disk after a downgrade are harmless garbage from their perspective.
- **Backwards compatibility on three axes.** (a) CLI argv and exit codes are byte-identical, so existing scripts and CI invocations keep working. (b) Golden fixtures for the three existing artifacts diff identically against a snapshot test after this change, because the receipt writer is the only new producer and it only writes inside `.factory/sessions/`. (c) No schema migration is needed because no existing schema changes.
- **Rollout.** A normal `npm publish` of the next factory version. No feature flag, no dual-write window, no destructive operation that would warrant one.
- **Rollback.** `npm install <previous-version>`. The new `.factory/sessions/` directory is inert to older versions, so leaving it on disk after rollback is harmless.
- **Tradeoff.** The receipt is always-on and cannot be disabled per-run via flag. This is acceptable because every acceptance criterion in the approved PRODUCT.md assumes the receipt exists, and an opt-out flag would create a class of operator who forgets it and then files a bug identical to this issue. The cost of always-on is one small JSON file per session, which is bounded and cheap. The previous revision rejected a feature-flagged rollout in favor of always-on for exactly this reason; that tradeoff is preserved here.

## Validation plan

The approach above is exercised end-to-end by the following six validation items. Each item is runnable today against a fresh checkout without waiting for the open product questions to be resolved, and each references a specific invariant from the approach and a specific acceptance criterion from the approved PRODUCT.md.

1. **Unit test for the helper module** (`src/session/closeReceipt.spec.ts`). Construct a `CloseReceipt` from each of the four `ExitReason` classifications (`idle`, `processed`, `failed`, `signaled`) and assert: (a) all required fields are present, (b) `exitReason` is exactly one of the four enum values, (c) `durationMs` is a non-negative integer, (d) `stateFile` is `null` when `exitReason` is `idle` and an absolute path when `exitReason` is `processed`, (e) the schema guard rejects an unknown `exitReason` value before any disk write. This test directly exercises the helper module introduced in the approach and validates the data-model invariants without booting the daemon. Maps to acceptance criteria 2 and 3.
2. **CLI integration test** (`tests/cli/factory-start-once.spec.ts`). Create a temporary target repo, run `factory start --once` against it twice in sequence, and assert: (a) exactly two files ending in `-close.json` exist under `.factory/sessions/`, (b) both files are syntactically valid JSON parseable by `JSON.parse`, (c) the basenames sort chronologically with the second run later than the first, (d) the second run did not overwrite or remove the first receipt. Maps to US-1, US-2, and acceptance criteria 1, 2, and 4.
3. **Atomic-write fault-injection test**. Monkey-patch the rename step inside the receipt writer to simulate a SIGKILL between tmp-file creation and rename, then assert: (a) no partial `-close.json` file remains in `.factory/sessions/` after the simulated crash, (b) the next successful run writes a complete receipt and the directory contains no JSON-invalid files. This validates the tmp-file-then-rename shape from the approach by code inspection plus fault injection. Maps to US-3 and acceptance criterion 5.
4. **Existing-artifact snapshot test**. Run `factory start --once` against a golden fixture target repo and diff `.factory/state-<n>.json`, `.factory/daemon.log`, and `.factory/daemon.pid` against the committed snapshot; the diff must be empty. Maps to acceptance criterion 6 and the non-goal that pre-existing artifacts are unchanged.
5. **Full test suite**. `npm test` and `npm run test:cli` must pass green with the change applied, including the new tests above. This is the gate for acceptance criterion 7 and proves no existing test regressed.
6. **Manual verification on the local install**. (a) Run `factory start --once` against a temp target repo, then `ls -1 .factory/sessions/` and `cat` the most recent receipt to confirm operator-visible behavior matches US-1 and US-2. (b) Send SIGTERM to a continuous `factory start` run and confirm a `signaled` receipt is produced with a non-zero `exitCode`. This is the behavioral complement to the automated tests.

If any of these fail, the change is not considered complete and the rollout does not proceed.

## Alternatives considered

- **Append the receipt fields to the existing `.factory/state-<n>.json` file** rather than emit a sibling artifact. Rejected because (a) `.factory/state-<n>.json` only exists when `--once` finds a runnable issue, so idle and signaled continuous closes would have nowhere to write, which violates the approved PRODUCT.md's goal that every run produces a receipt; (b) the approved PRODUCT.md explicitly lists changing the state-file schema under non-goals, so a sibling artifact is mandated by the spec, not a stylistic preference.
- **Write the receipt only when `exitReason === 'processed'`** and rely on `.factory/daemon.log` for the other close classifications. Rejected because the approved PRODUCT.md's US-2 acceptance criterion requires the receipt to classify `idle`, `processed`, `failed`, and `signaled`; a partial receipt would force operators back to grepping `daemon.log`, which is the exact pain this issue exists to fix.
- **Write the receipt synchronously inside the existing signal handlers** (`SIGINT`, `SIGTERM`) so the close is captured even on hard kill. Rejected because signal handlers run in a constrained context where filesystem operations are not guaranteed to complete; relying on them would re-introduce the partial-write failure mode that the atomic tmp-file-then-rename in the approach exists to prevent. Instead, the approach writes the receipt from the normal teardown path after the signal has already been translated into a process exit code, which is sufficient for the receipt to appear on every clean or signaled close and keeps the writer testable without signal mocking.
- **Gate the receipt writer behind a feature flag.** Rejected as discussed in the migration plan: every acceptance criterion assumes the receipt exists, and an opt-out flag creates a class of operator who forgets it and then files the same bug. The cost of always-on is one extra small JSON file per session, which is bounded and cheap.
- **Stream receipt events over the panel WebSocket** at `127.0.0.1:5174` instead of writing to disk. Rejected because the approved PRODUCT.md lists introducing a panel close channel as an explicit non-goal for issue #1; a follow-up issue can read the directory and surface it without blocking this one.
- **Continue the previous revision's posture of deferring implementation until the issue author supplies reproduction steps and the session boundary is resolved.** Rejected by this review: the deliverable for a spec PR is an implementation-ready spec, not a refusal-to-spec dressed as a draft. The factory will auto-merge on APPROVE and dispatch the implementation agent immediately, so the only way to honor the `ready-to-spec` label is to ship a concrete plan. The approved PRODUCT.md already picks a concrete, narrow interpretation of the empty issue — make every session close produce a canonical receipt — and this TECH.md commits to that interpretation instead of re-litigating it.

## Open technical questions

These questions are inherited from the approved PRODUCT.md. None are blocking the implementation or the validation plan above; each can be answered either before or after merge without invalidating the approach. They are listed here for visibility so the reviewer and the implementer can resolve them at the appropriate moment.

1. **Should the receipt writer additionally emit a single line to `.factory/daemon.log`** of the form `session-closed <sessionId> <exitReason>` for tail-friendly log correlation? The approved PRODUCT.md recommends yes; the approach above is compatible either way because the log line would be emitted from the same teardown site, but a final yes/no is needed before merge so the README troubleshooting section can describe the exact correlation surface operators should expect. Not blocking the unit or CLI integration tests in the validation plan.
2. **Should `mode` also include `cloud`** for the `factory install --mode cloud` workflow in a follow-up issue, or stay limited to `once` and `continuous` here? The approved PRODUCT.md recommends staying limited here; confirm before merge so the `Mode` type union is not under-specified on day one. Not blocking the implementation.
3. **How long should receipts be retained** before rotation/truncation? The approved PRODUCT.md recommends unbounded in this issue and tracking retention as a follow-up; confirm so the README does not over-promise or under-promise about disk usage in `.factory/sessions/`. Not blocking the implementation.
4. **Should the panel at `127.0.0.1:5174` surface receipts** in a follow-up issue? The approved PRODUCT.md recommends deferring this out of issue #1; confirm so the README troubleshooting section's pointer to `.factory/sessions/` is not contradicted by an absent panel surface. Not blocking the implementation.