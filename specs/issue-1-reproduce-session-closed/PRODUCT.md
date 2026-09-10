# PRODUCT.md

## Title & Status

- **Title:** Reproduce session closed — make every session close produce a canonical, machine-readable receipt
- **Issue:** #1
- **Status:** Approved (implementation-ready)
- **Owner:** spec agent

## Problem

Issue #1's title — "Reproduce session closed" — is the only signal in the issue body. In context, the user pain is the absence of a deterministic, machine-readable close signal for a factory session. When an operator runs `factory start --once` (or its in-source equivalent `node ./bin/factory.js start --once`) from a target repository, the daemon's exit path after processing the issue leaves no positive, grep-able artifact that the run ended cleanly. Today the only post-run artifacts are `.factory/daemon.log` (free-form text) and `.factory/state-<n>.json` (which only exists when `--once` finds a runnable issue). There is no dedicated close-receipt that records session id, start/end timestamps, exit reason (`idle` vs. `processed` vs. `failed` vs. `signaled`), and a stable `closed` field. Operators therefore cannot reliably tell a clean close from a hung or crashed close, cannot correlate logs across runs, and cannot audit which session produced a given state file. This issue makes the close of every session reproducible and observable by emitting one canonical receipt per run.

## Goals

- Ship a deterministic, machine-readable **Session Close Receipt** on every `factory start` invocation (both `--once` and continuous mode) regardless of whether any issue was processed.
- The receipt must record: `sessionId`, `mode` (`once` or `continuous`), `startedAt`, `endedAt`, `durationMs`, `exitCode`, `exitReason` (`idle` | `processed` | `failed` | `signaled`), `issueNumber` (integer or `null`), and `stateFile` (absolute path or `null`).
- Make every receipt discoverable from one canonical path (`.factory/sessions/`) so an operator can `ls` the directory and answer "did my last session close cleanly?" in under five seconds.
- Treat the receipt as the authoritative signal that a session closed; update the README troubleshooting section to point at it.
- Ensure the receipt is written atomically (tmp file + rename) so a SIGKILL mid-write cannot leave a half-written receipt on disk.
- Keep the change strictly additive: existing `.factory/state-<n>.json`, `.factory/daemon.log`, and `.factory/daemon.pid` semantics are unchanged so current operators and tests are not broken.

## Non-goals

- Do not redesign the daemon polling loop, signal handling, or single-instance lock (`.factory/daemon.pid`); this issue only adds a close receipt.
- Do not change the contents or schema of `.factory/state-<n>.json`; the receipt is a sibling artifact, not a replacement.
- Do not introduce a new long-running HTTP/WebSocket close channel for the control panel; the panel can read the receipt file later, but no panel protocol change ships in this issue.
- Do not auto-close, relabel, or transition issue #1 itself; the factory's state machine for issues is untouched.
- Do not change shutdown, retry, or backoff semantics; only the observability of the close is added.
- Do not block the receipt on GitHub or LLM network calls; the receipt must be writable offline.

## User stories

### US-1 — Operator sees a single canonical directory listing of recent session close receipts

- **As a** an operator who has just run `factory start --once` against a target repository
- **I want** to list a known directory and see one JSON file per past session, named so the most recent close is obvious
- **So that** I can confirm the session closed and pick the right receipt to inspect without grepping `daemon.log`

Checks:

- [ ] Running `factory start --once` in any target repo creates exactly one file in `.factory/sessions/` whose name ends in `-close.json` and whose basename contains a sortable timestamp.
- [ ] Running `factory start --once` a second time produces a second file in the same directory; the first file is not overwritten.
- [ ] Running `ls -1 .factory/sessions/` from the target repo root after one or more runs shows the receipt(s) without any additional flags.
- [ ] If `.factory/sessions/` does not exist before the run, the run creates it; no error is raised.

### US-2 — Operator reads the receipt and learns how the session closed

- **As a** an operator triaging a suspected hung or crashed `factory start` run
- **I want** to open the most recent close receipt and see exit code, exit reason, duration, and the issue number processed (if any)
- **So that** I can classify the close as `idle`, `processed`, `failed`, or `signaled` without reading the log

Checks:

- [ ] The receipt is valid JSON parseable by `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))"`.
- [ ] The receipt contains the fields: `sessionId`, `mode`, `startedAt` (ISO 8601 UTC), `endedAt` (ISO 8601 UTC), `durationMs` (integer), `exitCode` (integer), `exitReason` (one of `idle` | `processed` | `failed` | `signaled`), `issueNumber` (integer or `null`), and `stateFile` (absolute path string or `null`).
- [ ] For a `factory start --once` run that found no eligible issue, `exitReason` is `idle`, `issueNumber` is `null`, and `stateFile` is `null`.
- [ ] For a `factory start --once` run that processed issue N, `exitReason` is `processed`, `issueNumber` is N, and `stateFile` is the absolute path of `.factory/state-N.json`.
- [ ] For a run that exited with a non-zero code, `exitReason` is `failed` and `exitCode` matches the process exit code.

### US-3 — Receipt survives a hard kill mid-run without leaving a corrupt file on disk

- **As a** an operator whose terminal or process was killed mid-run (SIGKILL, power loss, OOM)
- **I want** the directory to contain either a fully written receipt or no receipt for that session
- **So that** I never have to discard a half-written JSON file before I can trust the directory listing

Checks:

- [ ] If the factory process is killed before the receipt is fully written, no file ending in `-close.json` for that session id remains in `.factory/sessions/` after a subsequent successful run.
- [ ] On a clean exit, the receipt appears atomically: a parallel `ls` of the directory never observes a zero-byte or JSON-invalid file.
- [ ] The receipt write uses a sibling temp file followed by `rename`, verifiable by code inspection of the receipt writer.

### US-4 — README points operators at the receipt as the primary close signal

- **As a** a new operator reading the README troubleshooting section after a confusing close
- **I want** the README to document `.factory/sessions/<id>-close.json` as the canonical place to confirm a session closed and to classify how
- **So that** I do not have to reverse-engineer `daemon.log` to learn the close reason

Checks:

- [ ] README mentions the `.factory/sessions/` directory in the "日志与故障排查" section.
- [ ] The README explains the `exitReason` enum (`idle`, `processed`, `failed`, `signaled`) and maps each to a recommended operator next step.
- [ ] The README does not contradict the receipt by claiming `daemon.log` is the primary close signal.

## Acceptance criteria

1. After any `factory start` run (with or without `--once`, in continuous mode for one cycle, with or without a runnable issue), at least one file ending in `-close.json` exists under `.factory/sessions/` in the target repository's working directory.
2. Every receipt is syntactically valid JSON and contains all required fields: `sessionId`, `mode`, `startedAt`, `endedAt`, `durationMs`, `exitCode`, `exitReason`, `issueNumber`, `stateFile`.
3. `exitReason` is exactly one of `idle`, `processed`, `failed`, `signaled`; a verifier run on the receipt's value against this set passes for every shipped fixture.
4. Two consecutive `factory start --once` runs produce two distinct receipt files whose basenames sort chronologically; the second run does not overwrite or remove the first.
5. A run whose process is killed before normal exit leaves no partial `-close.json` file in `.factory/sessions/` after the next successful run completes.
6. The pre-existing artifacts `.factory/state-<n>.json`, `.factory/daemon.log`, and `.factory/daemon.pid` are still produced with unchanged paths and contents on a successful run; a snapshot diff of an existing golden fixture shows no changes outside the new `.factory/sessions/` directory.
7. `npm test` and `npm run test:cli` pass with the change applied, including a new unit test that asserts the required receipt fields and the `exitReason` enum, and a new CLI integration test that runs `factory start --once` against a temp target repo and asserts one valid receipt file exists afterward.
8. The README "日志与故障排查" section is updated to point operators at `.factory/sessions/` as the canonical close signal and to document the `exitReason` enum.

## Open product questions

1. Should the receipt writer additionally emit a single line to `.factory/daemon.log` of the form `session-closed <sessionId> <exitReason>` for tail-friendly log correlation, or stay strictly file-only? Recommend yes for log correlation; deferring to implementation would still meet all acceptance criteria above.
2. Should `mode` also include `cloud` for the `factory install --mode cloud` workflow in a follow-up issue, or stay limited to `once` and `continuous` here? Recommend staying limited here; cloud is out of scope for issue #1.
3. Should the receipt include a `pid` field for cross-referencing `.factory/daemon.pid`? Recommend yes; not blocking but cheap and useful.
4. How long should receipts be retained before rotation/truncation? Recommend unbounded in this issue and tracking retention as a follow-up.
5. Should the panel at `127.0.0.1:5174` surface receipts in this issue? Recommend no; the panel can read the directory in a later issue without blocking this spec.
