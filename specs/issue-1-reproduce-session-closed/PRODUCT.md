# PRODUCT.md

## Title & Status

- **Title:** Reproduce session closed — make every session close produce a canonical, machine-readable receipt
- **Issue:** #1
- **Status:** Approved (implementation-ready, revision 2)
- **Owner:** spec agent

## Problem

Issue #1's title — "Reproduce session closed" — is the only signal in the issue body. In context, the user pain is the absence of a deterministic, machine-readable close signal for a factory session. When an operator runs `factory start --once` (or its in-source equivalent `node ./bin/factory.js start --once`) from a target repository, the daemon's exit path after processing the issue leaves no positive, grep-able artifact that the run ended cleanly. Today the only post-run artifacts are `.factory/daemon.log` (free-form text) and `.factory/state-<n>.json` (which only exists when `--once` finds a runnable issue). There is no dedicated close-receipt that records session id, start/end timestamps, exit reason, and a stable close marker. Operators therefore cannot reliably tell a clean close from a hung or crashed close, cannot correlate logs across runs, and cannot audit which session produced a given state file. This issue makes the close of every session reproducible and observable by emitting one canonical receipt per run under `.factory/sessions/`.

## Goals

- Ship a deterministic, machine-readable **Session Close Receipt** on every `factory start` invocation (both `--once` and continuous mode) regardless of whether any issue was processed, including the SIGTERM → signaled teardown path.
- The required receipt fields are exactly: `sessionId`, `mode`, `startedAt`, `endedAt`, `durationMs`, `exitCode`, `exitReason`, `issueNumber`, `stateFile`. The receipt may include additional optional fields (for example `pid`, `factoryVersion`) but those are not part of the required contract.
- All receipts are persisted under exactly one canonical path: `<stateDir>/sessions/<sessionId>-close.json`, where `stateDir` is the daemon's resolved state directory (default `.factory`, overridable via `--state-dir`). The directory name is `.factory/sessions/` — singular `.factory`, never `.factories` or any other variant. Every user story, acceptance criterion, and test asserts the same path.
- Treat the receipt as the authoritative signal that a session closed; the README troubleshooting section must point at `.factory/sessions/` as the primary close signal.
- Ensure the receipt is written atomically (tmp file + rename) so a SIGKILL mid-write cannot leave a half-written receipt on disk, and so a `signaled` exit (SIGTERM/SIGINT translated into a clean teardown) still produces a complete receipt.
- Keep the change strictly additive: existing `.factory/state-<n>.json`, `.factory/daemon.log`, and `.factory/daemon.pid` semantics are unchanged so current operators and tests are not broken.
- Emit exactly one log line to `.factory/daemon.log` of the form `session-closed <sessionId> <exitReason>` immediately after the receipt rename succeeds, so tail-friendly log correlation and the receipt directory agree.
- Include the daemon `pid` in the receipt as an optional-but-recommended field; verifiers must accept receipts that include it without failing.

## Non-goals

- Do not redesign the daemon polling loop, signal handling, or single-instance lock (`.factory/daemon.pid`); this issue only adds a close receipt on the normal teardown path that runs after a signal has been translated into a process exit.
- Do not change the contents or schema of `.factory/state-<n>.json`; the receipt is a sibling artifact, not a replacement.
- Do not introduce a new long-running HTTP/WebSocket close channel for the control panel; the panel can read the receipt file later, but no panel protocol change ships in this issue.
- Do not auto-close, relabel, or transition issue #1 itself; the factory's state machine for issues is untouched.
- Do not change shutdown, retry, or backoff semantics; only the observability of the close is added.
- Do not block the receipt on GitHub or LLM network calls; the receipt must be writable offline.
- Do not add a `cloud` mode to the receipt schema in this issue; `cloud` is tracked as a follow-up.
- Do not add receipt retention or rotation in this issue; receipts are retained unbounded and a follow-up issue will introduce rotation.

## User stories

### US-1 — Operator sees a single canonical directory listing of recent session close receipts

- **As a** an operator who has just run `factory start --once` against a target repository
- **I want** to list a known directory and see one JSON file per past session, named so the most recent close is obvious
- **So that** I can confirm the session closed and pick the right receipt to inspect without grepping `daemon.log`

Checks:

- [ ] Running `factory start --once` in any target repo creates exactly one file under `.factory/sessions/` (singular `.factory`, no trailing `s`) whose name ends in `-close.json` and whose basename contains a sortable timestamp.
- [ ] Running `factory start --once` a second time produces a second file in the same directory; the first file is not overwritten.
- [ ] Running `ls -1 .factory/sessions/` from the target repo root after one or more runs shows the receipt(s) without any additional flags.
- [ ] If `.factory/sessions/` does not exist before the run, the run creates it; no error is raised.
- [ ] If `--state-dir` is set, the receipts land under `<stateDir>/sessions/` and nowhere else; the path is computed from the same resolved state directory the daemon already uses.

### US-2 — Operator reads the receipt and learns how the session closed

- **As a** an operator triaging a suspected hung or crashed `factory start` run
- **I want** to open the most recent close receipt and see exit code, exit reason, duration, and the issue number processed (if any)
- **So that** I can classify the close as `idle`, `processed`, `failed`, or `signaled` without reading the log

Checks:

- [ ] The receipt is valid JSON parseable by `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))"`.
- [ ] The receipt contains every required field exactly once: `sessionId` (string), `mode` (`once` or `continuous`), `startedAt` (ISO 8601 UTC), `endedAt` (ISO 8601 UTC), `durationMs` (integer ≥ 0), `exitCode` (integer), `exitReason` (`idle` | `processed` | `failed` | `signaled`), `issueNumber` (integer or `null`), `stateFile` (absolute path string or `null`).
- [ ] A verifier that asserts only the required-field set passes on every shipped fixture; receipts may carry extra fields (e.g., `pid`, `factoryVersion`) and the verifier must not fail on them.
- [ ] For a `factory start --once` run that found no eligible issue, `exitReason` is `idle`, `issueNumber` is `null`, and `stateFile` is `null`.
- [ ] For a `factory start --once` run that processed issue N, `exitReason` is `processed`, `issueNumber` is N, and `stateFile` is the absolute path of `.factory/state-N.json`.
- [ ] For a run whose process exited with a non-zero code, `exitReason` is `failed` and `exitCode` matches the process exit code.
- [ ] For a continuous `factory start` run that received SIGTERM and then exited cleanly via the normal teardown path, `exitReason` is `signaled` and `exitCode` matches the translated exit code.

### US-3 — Receipt survives a hard kill mid-run without leaving a corrupt file on disk, and a signaled teardown still leaves a complete receipt

- **As a** an operator whose terminal or process was killed mid-run (SIGKILL, power loss, OOM) or who sent SIGTERM to a long-running continuous daemon
- **I want** the directory to contain either a fully written receipt or no receipt for that session, and a SIGTERM-triggered clean shutdown to leave a complete receipt with `exitReason: "signaled"`
- **So that** I never have to discard a half-written JSON file before I can trust the directory listing, and a normal SIGTERM-driven shutdown is observably indistinguishable from an idle close except for the reason field

Checks:

- [ ] If the factory process is killed with SIGKILL (untranslatable) before the receipt is fully written, no file ending in `-close.json` for that session id remains in `.factory/sessions/` after a subsequent successful run.
- [ ] On a clean exit, the receipt appears atomically: a parallel `ls` of the directory never observes a zero-byte or JSON-invalid file.
- [ ] The receipt write uses a sibling temp file followed by `rename`, verifiable by code inspection of the receipt writer.
- [ ] Sending SIGTERM to a continuous `factory start` run, waiting for the process to exit, and inspecting `.factory/sessions/` produces exactly one well-formed receipt whose `exitReason` is `signaled`.
- [ ] Sending SIGTERM produces a `session-closed <sessionId> signaled` line in `.factory/daemon.log`.

### US-4 — README points operators at the receipt as the primary close signal

- **As a** a new operator reading the README troubleshooting section after a confusing close
- **I want** the README to document `.factory/sessions/<id>-close.json` as the canonical place to confirm a session closed and to classify how
- **So that** I do not have to reverse-engineer `daemon.log` to learn the close reason

Checks:

- [ ] README mentions the `.factory/sessions/` directory (singular `.factory`, no trailing `s`) in the "日志与故障排查" section.
- [ ] The README explains the `exitReason` enum (`idle`, `processed`, `failed`, `signaled`) and maps each to a recommended operator next step.
- [ ] The README documents the `session-closed <sessionId> <exitReason>` log line as the tail-friendly correlation companion to the receipt file.
- [ ] The README does not contradict the receipt by claiming `daemon.log` is the primary close signal; the receipt directory is named first.

## Acceptance criteria

1. After any `factory start` run (with or without `--once`, in continuous mode for one cycle, with or without a runnable issue, and including the SIGTERM → signaled teardown path), at least one file ending in `-close.json` exists under the resolved state directory's `sessions/` subdirectory (default `.factory/sessions/`, overridable via `--state-dir`).
2. Every receipt is syntactically valid JSON and contains every required field exactly once: `sessionId`, `mode`, `startedAt`, `endedAt`, `durationMs`, `exitCode`, `exitReason`, `issueNumber`, `stateFile`. The verifier asserts only this required-field set and ignores additional fields such as `pid` and `factoryVersion`.
3. `exitReason` is exactly one of `idle`, `processed`, `failed`, `signaled`; a verifier run on the receipt's value against this set passes for every shipped fixture and for every signal-induced teardown.
4. Two consecutive `factory start --once` runs produce two distinct receipt files whose basenames sort chronologically; the second run does not overwrite or remove the first.
5. A run whose process is killed with SIGKILL before the normal teardown path completes leaves no partial `-close.json` file in the resolved sessions directory after the next successful run completes.
6. The pre-existing artifacts `.factory/state-<n>.json`, `.factory/daemon.log`, and `.factory/daemon.pid` are still produced with unchanged paths and contents on a successful run; a snapshot diff of an existing golden fixture shows no changes outside the new `<stateDir>/sessions/` directory.
7. Every receipt is paired with exactly one `session-closed <sessionId> <exitReason>` line in `.factory/daemon.log`, written after the receipt rename succeeds.
8. `npm test` and `npm run test:cli` pass with the change applied, including: (a) a new unit test that asserts the required receipt fields, the `exitReason` enum, and the `session-closed` log line emission; (b) a new CLI integration test that runs `factory start --once` against a temp target repo and asserts one valid receipt file exists afterward; (c) a new CLI integration test that sends SIGTERM to a continuous run and asserts one valid `signaled` receipt file exists afterward; (d) a regression test that asserts the persisted directory is `.factory/sessions/` and never `.factories/sessions/` or any other variant.
9. The README "日志与故障排查" section is updated to point operators at `.factory/sessions/` (singular `.factory`) as the canonical close signal, to document the `exitReason` enum, and to document the `session-closed <sessionId> <exitReason>` log line.

## Open product questions

1. **(RESOLVED — not blocking.)** The receipt writer emits a `session-closed <sessionId> <exitReason>` line to `.factory/daemon.log` immediately after the receipt rename succeeds. This is now a required behavior recorded in the Goals and AC #7.
2. **(DEFERRED to follow-up, non-blocking for this issue.)** Should `mode` also include `cloud` for the `factory install --mode cloud` workflow? Stays limited to `once` and `continuous` here; tracked as follow-up.
3. **(RESOLVED — not blocking.)** The receipt MAY include a `pid` field for cross-referencing `.factory/daemon.pid`; the verifier must accept extra fields. The implementation may include it; absence does not fail the spec.
4. **(DEFERRED to follow-up, non-blocking for this issue.)** Receipt retention is unbounded in this issue; rotation/truncation is a follow-up.
5. **(DEFERRED to follow-up, non-blocking for this issue.)** Should the control panel at `127.0.0.1:5174` surface receipts? No in this issue; a follow-up reads the directory.
