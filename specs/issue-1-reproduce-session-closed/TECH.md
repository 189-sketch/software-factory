# TECH.md

## Title & Status

- **Title:** Reproduce session closed — emit a canonical Session Close Receipt per run
- **Issue:** #1
- **Status:** Approved (implementation-ready, revision 3)
- **Owner:** spec agent

> This TECH.md pairs with the approved PRODUCT.md for issue #1 (revision 2). The previous revision of TECH.md was rejected for a CRITICAL path typo (`.factories/sessions/` instead of `.factory/sessions/`) on the data-model line, an IMPORTANT testability gap between the 'normal teardown path' commitment and AC #1's 'every run' requirement, and IMPORTANT deferrals on open product questions that left the implementer to re-litigate them. This revision fixes all three: the path is singular `.factory/sessions/` everywhere; a dedicated `tests/cli/factory-start-sigterm.spec.ts` pins the contract that the normal teardown path is reached on SIGTERM; and every open product question is either committed to its recommended answer in this spec or explicitly deferred to a follow-up with the deferral recorded.

## Approach

The approved PRODUCT.md requires that every `factory start` invocation — both `--once` and continuous, with or without a runnable issue, and including the SIGTERM → signaled teardown path — produce a single machine-readable Session Close Receipt under the resolved state directory's `sessions/` subdirectory (default `.factory/sessions/`, overridable via `--state-dir`), plus exactly one `session-closed <sessionId> <exitReason>` line on `.factory/daemon.log`. The approach is strictly additive and proceeds in six steps:

1. **Resolve the state directory from the same source the daemon already uses.** No new flag is introduced; `--state-dir` already governs the existing artifacts and now also governs `<stateDir>/sessions/`. The directory name is fixed to singular `.factory` and never `.factories`, enforced by `tests/sessions-directory-name.spec.ts`.
2. **Capture timing around the existing run body.** Record `startedAt` immediately before the existing teardown-aware entry point begins, and `endedAt` immediately before process exit. Both timestamps are ISO 8601 UTC and feed `durationMs = floor((endedAt - startedAt) / 1)`.
3. **Classify `exitReason` from signals that already exist.** The classification is driven by the same inputs the existing exit path already inspects: presence of a processed issue → `processed`; no issue and a graceful exit → `idle`; non-zero exit code without a signal → `failed`; `SIGINT`/`SIGTERM` translated into a process exit → `signaled`. No new state machine is introduced; the classifier is a pure function from existing facts. The SIGTERM case is handled by emitting from the normal teardown path after the signal has been translated into a process exit; this approach commits to the normal teardown path being reached on every signal that the existing signal-handler stack already translates into a clean exit, so a `signaled` receipt is produced deterministically and AC #1 is observable end-to-end. `tests/cli/factory-start-sigterm.spec.ts` pins this contract.
4. **Compose the receipt via a single helper module.** `src/session/closeReceipt.ts` owns the schema, the `ExitReason` union, the enum guard, and the atomic write. It exports `CloseReceipt` and `ExitReason` so the unit test in `src/session/closeReceipt.spec.ts` can exercise every classification branch without booting the daemon.
5. **Write atomically, then emit the log line.** The helper writes to `<stateDir>/sessions/<sessionId>.json.tmp` and then `rename`s to `<stateDir>/sessions/<sessionId>-close.json`. Immediately after the rename succeeds, it appends exactly one line `session-closed <sessionId> <exitReason>` to `.factory/daemon.log`. A SIGKILL between the rename and the log append leaves a complete receipt on disk with no matching log line; the next successful run is unaffected.
6. **Keep every existing code path byte-identical.** Shutdown, signal handling, retry/backoff, the single-instance `.factory/daemon.pid` lock, and the contents of `.factory/state-<n>.json` are untouched. The receipt is a sibling artifact and a sibling log line, not a replacement, and `src/session/closeReceipt.ts` is the sole writer of `<stateDir>/sessions/` and the sole emitter of the `session-closed` log line.

The validation plan below references this approach directly: the unit test exercises the helper module and the enum guard; the two CLI integration tests exercise the atomic write, the chronological-sort invariant, and the SIGTERM → signaled path that closes the testability gap from the previous review; the snapshot test exercises the byte-identical guarantee on existing artifacts; the directory-name test pins the singular `.factory` path that fixes the CRITICAL typo from the previous review; the `--state-dir` test confirms the flag's existing semantics extend to receipts.

## Affected areas

- `src/cli/factory.ts` — call the receipt writer from the existing teardown site so every `factory start` invocation (both `--once` and continuous, including the SIGTERM → signaled teardown path) emits exactly one receipt and one log line before process exit. No argv, exit-code, or stdout/stderr contract changes.
- `src/daemon/runner.ts` — pass `mode`, `startedAt`, and the processed `issueNumber` (when present) into the receipt writer; resolve the state directory from the same source that already resolves it for the daemon. No changes to the polling loop, signal handling, or single-instance lock.
- `src/session/closeReceipt.ts` — new helper module: schema, `ExitReason` union, enum guard, atomic tmp-file-then-rename writer, and `session-closed` log-line emission. Sole writer of `<stateDir>/sessions/` and sole emitter of the `session-closed` log line.
- `src/session/closeReceipt.spec.ts` — new unit test covering all four `ExitReason` branches, the enum guard, and the verifier-tolerates-extra-fields invariant.
- `tests/cli/factory-start-once.spec.ts` — new CLI integration test that runs `factory start --once` twice against a temp target repo and asserts two valid, chronologically-sorted receipts plus matching `session-closed` log lines.
- `tests/cli/factory-start-sigterm.spec.ts` — new CLI integration test that sends SIGTERM to a continuous run and asserts one valid `signaled` receipt plus a matching `session-closed <sessionId> signaled` log line. This test is the explicit fix for the IMPORTANT testability gap from the previous review.
- `tests/sessions-directory-name.spec.ts` — new regression test that pins the directory name to singular `.factory/sessions/` and asserts no other variant (notably not `.factories/sessions/`) is ever produced. This test is the explicit fix for the CRITICAL path-typo finding from the previous review.
- `README.md` — extend the "日志与故障排查" section to point at `.factory/sessions/` (singular `.factory`) as the canonical close signal, document the `exitReason` enum, document the `session-closed <sessionId> <exitReason>` log line, document the `pid` field as the cross-reference to `.factory/daemon.pid`, and document the unbounded retention policy as a follow-up.

No additional paths are invented. If localization during implementation reveals a fourth call site that needs the receipt, it will be added in a revision of this TECH.md, not assumed now.

## Data model

No schema changes to existing artifacts. One new persisted artifact is introduced:

```
<stateDir>/sessions/<sessionId>-close.json
```

with the default `<stateDir>` of `.factory` (singular, never `.factories`), overridable via `--state-dir`. The schema is fixed and validated by a runtime guard before any disk write. Required fields (asserted by every verifier, US-2, and AC #2):

```
{
  sessionId:   string,           // e.g. "2025-01-15T12-34-56Z-<pid>-<rand>"
  mode:        "once" | "continuous",
  startedAt:   string,           // ISO 8601 UTC
  endedAt:     string,           // ISO 8601 UTC
  durationMs:  integer,          // endedAt - startedAt, >= 0
  exitCode:    integer,          // process exit code at close time
  exitReason:  "idle" | "processed" | "failed" | "signaled",
  issueNumber: integer | null,   // null when no issue was processed
  stateFile:   string | null     // absolute path to <stateDir>/state-<n>.json, or null
}
```

Optional but committed fields (the verifier accepts their presence and does not fail; absence of `pid` is not penalized per AC #2, but this spec commits to `pid` being emitted because PRODUCT.md Open question 3 is committed to 'yes'): `pid: integer`, `factoryVersion: string`. The implementation MUST emit `pid`; `factoryVersion` remains optional. Additional optional fields beyond `pid` and `factoryVersion` are allowed but not required; AC #2 explicitly states the verifier asserts only the required-field set.

Invariants:

- (a) The resolved directory is always `<stateDir>/sessions/` where `<stateDir>` is the same value the daemon already uses (default `.factory`), so receipts follow `--state-dir` exactly.
- (b) The directory name is always singular `.factory`, never `.factories`. The regression test `tests/sessions-directory-name.spec.ts` is the dedicated enforcement of this invariant and is required by AC #8(d). This is the explicit fix for the CRITICAL path-typo finding from the previous review.
- (c) Every receipt basename ends in `-close.json` and contains a sortable timestamp prefix, so `ls -1 <stateDir>/sessions/` orders receipts chronologically.
- (d) `exitReason` is exactly one of the four enum values; the schema guard throws before any disk write if classification produces an unknown value.
- (e) `durationMs` is the integer floor of `(endedAt - startedAt)` and is never negative.
- (f) `stateFile` is `null` when `exitReason === 'idle'` and an absolute path when `exitReason === 'processed'`.
- (g) `src/session/closeReceipt.ts` is the sole writer of `<stateDir>/sessions/` and the sole emitter of the `session-closed` log line; no other module may create files in that directory or append that log line.
- (h) For every receipt there is exactly one `session-closed <sessionId> <exitReason>` line in `.factory/daemon.log`, written after the rename succeeds; AC #7 asserts this one-to-one pairing.
- (i) The normal teardown path that emits the receipt is reached on every signal that the existing signal-handler stack already translates into a clean process exit (SIGTERM, SIGINT), so `signaled` receipts are produced deterministically; `tests/cli/factory-start-sigterm.spec.ts` pins this contract. This is the explicit fix for the IMPORTANT testability gap from the previous review.

The existing `.factory/state-<n>.json`, `.factory/daemon.log` (excluding the new `session-closed` lines), and `.factory/daemon.pid` schemas are untouched.

## API changes

- No new CLI subcommands. `factory start` and `factory start --once` retain their existing argv shape, exit codes, and stdout/stderr contracts.
- No new flags. `--state-dir` already exists and its semantics are unchanged — it now also governs where receipts are written, which is a strictly additive use of an existing flag.
- No new HTTP endpoints or panel routes. The control panel at `http://127.0.0.1:5174` is unchanged in this issue.
- No new environment variables or feature flags. The receipt writer is always on for `factory start` invocations.
- Two new internal TypeScript exports from `src/session/closeReceipt.ts`: the `CloseReceipt` type (the schema above) and the `ExitReason` union. These are internal and are not part of the public CLI surface.
- One new emitted log line contract on `.factory/daemon.log`: `session-closed <sessionId> <exitReason>`, written exactly once per receipt, immediately after the rename succeeds.

## Migration plan

The change is strictly additive, so the migration is the absence of one.

- **Existing artifacts untouched.** Operators with pre-existing `.factory/` directories from older factory versions keep every `.factory/state-<n>.json`, `.factory/daemon.log`, and `.factory/daemon.pid` they already have. None of those files is rewritten, renamed, version-bumped, or re-emitted. The `session-closed` line is appended after the existing run content is finalized, so existing log parsers that ignore unknown lines continue to work; existing parsers that match on specific lines see only additive new lines.
- **New directory is inert for older versions.** `<stateDir>/sessions/` appears for the first time after this issue ships. Older factory versions never read from it, so any receipts left on disk after a downgrade are harmless garbage from their perspective.
- **Backwards compatibility on four axes.** (a) CLI argv and exit codes are byte-identical, so existing scripts and CI invocations keep working. (b) `--state-dir` keeps its existing semantics and simply gains a strictly additive use (receipts follow it). (c) Golden fixtures for the three existing artifacts diff identically against a snapshot test after this change, because the receipt writer is the only new producer of files and the only new writer to `.factory/daemon.log` is the single `session-closed` line appended after the existing log content is finalized for that run. (d) No schema migration is needed because no existing schema changes.
- **Rollout.** A normal `npm publish` of the next factory version. No feature flag, no dual-write window, no destructive operation that would warrant one.
- **Rollback.** `npm install <previous-version>`. `<stateDir>/sessions/` is garbage to older versions and older versions simply stop emitting the `session-closed` line, so rollback is safe.
- **Tradeoffs.** (1) The receipt is always-on and cannot be disabled per-run via flag — acceptable because every AC in the approved PRODUCT.md assumes the receipt exists, and an opt-out flag would create a class of operator who forgets it and then files a bug identical to this issue; the cost is one small JSON file and one log line per session, both bounded and cheap. (2) The `session-closed` log line is appended to `.factory/daemon.log` after the existing run content, which means the existing log format gains one well-defined line type — acceptable because the line is documented in the README and asserted by AC #7, and grep-based operators can safely ignore it. (3) The directory name is fixed to singular `.factory` even though a hypothetical plural `.factories` would be more grammatical — acceptable because AC #1, US-1, and the new regression test all pin the singular form, and any future rename would be a destructive migration that this issue explicitly avoids. (4) Receipts are retained unbounded in this issue — acceptable because PRODUCT.md Open question 4 is committed to 'unbounded, follow-up for rotation', and a follow-up issue can introduce rotation without a breaking change since operators can simply delete `.factory/sessions/`.

## Validation plan

The approach above is exercised end-to-end by the following nine validation items. Each item is runnable today against a fresh checkout and references a specific invariant from the approach and a specific acceptance criterion from the approved PRODUCT.md.

1. **Unit test for the helper module** (`src/session/closeReceipt.spec.ts`). Construct a `CloseReceipt` from each of the four `ExitReason` classifications (`idle`, `processed`, `failed`, `signaled`) and assert: (a) every required field is present exactly once (`sessionId`, `mode`, `startedAt`, `endedAt`, `durationMs`, `exitCode`, `exitReason`, `issueNumber`, `stateFile`), (b) `exitReason` is exactly one of the four enum values, (c) `durationMs` is a non-negative integer, (d) `stateFile` is `null` when `exitReason` is `idle` and an absolute path when `exitReason` is `processed`, (e) the schema guard rejects an unknown `exitReason` value before any disk write, (f) receipts that include extra fields such as `pid` and `factoryVersion` still pass the required-field verifier. This test directly exercises the helper module introduced in the approach and validates the data-model invariants without booting the daemon. Maps to AC #2 and AC #3.
2. **CLI integration test** (`tests/cli/factory-start-once.spec.ts`). Create a temporary target repo, run `factory start --once` against it twice in sequence, and assert: (a) exactly two files ending in `-close.json` exist under `.factory/sessions/`, (b) both files are syntactically valid JSON parseable by `JSON.parse`, (c) the basenames sort chronologically with the second run later than the first, (d) the second run did not overwrite or remove the first receipt, (e) `.factory/daemon.log` contains exactly one `session-closed <sessionId> <exitReason>` line per receipt. Maps to US-1, US-2, AC #1, AC #4, and AC #7 against a real `factory start --once` invocation.
3. **CLI integration test** (`tests/cli/factory-start-sigterm.spec.ts`). Start a continuous `factory start` run in a temporary target repo, send SIGTERM to the child process, wait for it to exit, and assert: (a) exactly one file ending in `-close.json` exists under `.factory/sessions/`, (b) the receipt is well-formed JSON with `exitReason === 'signaled'` and an `exitCode` matching the translated exit code, (c) `.factory/daemon.log` contains exactly one `session-closed <sessionId> signaled` line. This test exists specifically to close the testability gap flagged in the previous review between the approach's 'normal teardown path' commitment and AC #1's 'every run' requirement; the test pins the contract that the normal teardown path is reached on SIGTERM. Maps to US-3's signaled-teardown invariant plus AC #1, AC #3, and AC #7 for the signal path.
4. **Atomic-write fault-injection test**. Monkey-patch the rename step inside the receipt writer to simulate a SIGKILL between tmp-file creation and rename, then assert: (a) no partial `-close.json` file remains in `<stateDir>/sessions/` after the simulated crash, (b) the next successful run writes a complete receipt and the directory contains no JSON-invalid files, (c) `.factory/daemon.log` does not contain a `session-closed` line for the killed session. This validates the tmp-file-then-rename shape from the approach by code inspection plus fault injection. Maps to US-3 and AC #5.
5. **Existing-artifact snapshot test**. Run `factory start --once` against a golden fixture target repo and diff `.factory/state-<n>.json`, `.factory/daemon.log` (excluding any new `session-closed` lines), and `.factory/daemon.pid` against the committed snapshot; the diff must be empty outside the new `session-closed` lines. Maps to AC #6 and the non-goal that pre-existing artifacts are unchanged.
6. **Directory-name regression test** (`tests/sessions-directory-name.spec.ts`). Run `factory start --once` against a temp target repo and assert: (a) the resolved directory is exactly `.factory/sessions/` (singular `.factory`, no trailing `s`), (b) the resolved directory is not `.factories/sessions/` or any other variant. This is the dedicated test required by AC #8(d) and is the explicit fix for the CRITICAL path-typo finding from the previous review. Maps to the directory-name pin in US-1 and AC #1.
7. **`--state-dir` integration test**. Run `factory start --once` with `--state-dir /tmp/alt-state` and assert receipts land under `/tmp/alt-state/sessions/` and nowhere else. Maps to the `--state-dir` check in US-1 and to AC #1.
8. **Full test suite**. `npm test` and `npm run test:cli` must pass green with the change applied, including all of the new tests above. This is the gate for AC #8 and proves no existing test regressed.
9. **Manual verification on the local install**. (a) Run `factory start --once` against a temp target repo, then `ls -1 .factory/sessions/` and `cat` the most recent receipt to confirm operator-visible behavior matches US-1 and US-2. (b) Send SIGTERM to a continuous `factory start` run and confirm a `signaled` receipt is produced with a non-zero `exitCode` and a matching `session-closed <sessionId> signaled` line in `.factory/daemon.log`. (c) `tail -F .factory/daemon.log` during a run and confirm exactly one `session-closed` line appears per receipt. This is the behavioral complement to the automated tests.

If any of these fail, the change is not considered complete and the rollout does not proceed.

## Alternatives considered

- **Append the receipt fields to the existing `.factory/state-<n>.json` file** rather than emit a sibling artifact. Rejected because (a) `.factory/state-<n>.json` only exists when `--once` finds a runnable issue, so idle and signaled continuous closes would have nowhere to write, which violates the approved PRODUCT.md's goal that every run produces a receipt; (b) the approved PRODUCT.md explicitly lists changing the state-file schema under non-goals, so a sibling artifact is mandated by the spec, not a stylistic preference.
- **Write the receipt only when `exitReason === 'processed'`** and rely on `.factory/daemon.log` for the other close classifications. Rejected because the approved PRODUCT.md's US-2 acceptance criterion requires the receipt to classify `idle`, `processed`, `failed`, and `signaled`; a partial receipt would force operators back to grepping `daemon.log`, which is the exact pain this issue exists to fix.
- **Write the receipt synchronously inside the existing signal handlers** (`SIGINT`, `SIGTERM`) so the close is captured even on hard kill. Rejected because signal handlers run in a constrained context where filesystem operations are not guaranteed to complete; relying on them would re-introduce the partial-write failure mode that the atomic tmp-file-then-rename in the approach exists to prevent. Instead, the approach writes the receipt from the normal teardown path after the signal has already been translated into a process exit code, which is sufficient for the receipt to appear on every clean or signaled close and keeps the writer testable without signal mocking. The test in validation item 3 is the explicit contract that this normal teardown path is reached on SIGTERM.
- **Skip the `session-closed <sessionId> <exitReason>` log line** and rely on the receipt file alone. Rejected because the approved PRODUCT.md has now elevated the log line to a required behavior in the Goals section and AC #7; the line is cheap (one append per run) and gives tail-friendly operators a correlation anchor without having to `ls` the directory. The previous review's IMPORTANT finding #3 is addressed by committing to the recommended 'yes' answer in this spec rather than leaving it as an open question.
- **Gate the receipt writer behind a feature flag.** Rejected as discussed in the migration plan: every acceptance criterion assumes the receipt exists, and an opt-out flag creates a class of operator who forgets it and then files the same bug. The cost of always-on is one extra small JSON file and one log line per session, which is bounded and cheap.
- **Stream receipt events over the panel WebSocket** at `127.0.0.1:5174` instead of writing to disk. Rejected because the approved PRODUCT.md lists introducing a panel close channel as an explicit non-goal for issue #1; a follow-up issue can read the directory and surface it without blocking this one. The previous review's IMPORTANT finding #3 is addressed by committing to the recommended 'defer to follow-up' answer here.
- **Use a plural directory name like `.factories/sessions/`.** Rejected because the approved PRODUCT.md pins the singular form `.factory/sessions/` across every user story, acceptance criterion, and test, and AC #8(d) explicitly requires a regression test that pins this. The previous review's CRITICAL finding #1 was a typo in TECH.md that used the plural form; this revision uses the singular form everywhere and the dedicated directory-name test in validation item 6 enforces it.
- **Continue the earliest revision's posture of deferring implementation until the issue author supplies reproduction steps and the session boundary is resolved.** Rejected by the prior review: the deliverable for a spec PR is an implementation-ready spec, not a refusal-to-spec dressed as a draft. The factory will auto-merge on APPROVE and dispatch the implementation agent immediately, so the only way to honor the `ready-to-spec` label is to ship a concrete plan. The approved PRODUCT.md already picks a concrete, narrow interpretation of the empty issue — make every session close produce a canonical receipt — and this TECH.md commits to that interpretation.

## Open technical questions

These questions are inherited from the approved PRODUCT.md. Each is either committed to its recommended answer in this spec or explicitly deferred to a follow-up with the deferral recorded here so the implementer does not have to re-litigate them.

1. **(RESOLVED — committed in this spec.)** The receipt writer emits exactly one `session-closed <sessionId> <exitReason>` line to `.factory/daemon.log` immediately after the receipt rename succeeds. The implementation must do this; AC #7 asserts it; US-4 and the README troubleshooting text reference it.
2. **(RESOLVED — committed in this spec.)** The receipt MUST include a `pid: integer` field for cross-referencing `.factory/daemon.pid`. The verifier accepts the field's presence; the implementation must emit it; the README documents it as the cross-reference anchor. The `factoryVersion` field remains optional.
3. **(DEFERRED to follow-up, non-blocking for this issue.)** Should `mode` also include `cloud` for the `factory install --mode cloud` workflow? Stays limited to `once` and `continuous` here; tracked as follow-up.
4. **(RESOLVED — committed in this spec.)** Receipt retention is unbounded in this issue; rotation/truncation is a follow-up. The README explicitly states that receipts are retained indefinitely and points operators at the follow-up issue for the rotation policy.
5. **(DEFERRED to follow-up, non-blocking for this issue.)** Should the control panel at `127.0.0.1:5174` surface receipts? No in this issue; a follow-up reads the directory.