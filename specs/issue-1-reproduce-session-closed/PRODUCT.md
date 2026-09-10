# PRODUCT.md

## Title & Status

- **Title:** Reproduce session closed
- **Issue:** #1
- **Status:** Draft — blocked on missing issue context
- **Owner:** spec agent

## Problem

The user-reported problem is not specified. Issue #1 has the title "Reproduce session closed" and a body of `test` with no comments, so there is no concrete user pain point, reproduction steps, expected behavior, or affected surface area from which to derive a product specification. The term "session" is also ambiguous in this repository: it could plausibly refer to a single `factory start --once` run, a daemon polling cycle managed by `.factory/daemon.pid`, or a control-panel browser session served at `http://127.0.0.1:5174`.

Until the issue author supplies the missing context, any spec written here would be invented from memory rather than grounded in a real problem. The spec agent therefore returns this blocking draft instead.

## Goals

- Confirm with the issue author what user-visible behavior is failing or being asked to reproduce.
- Establish a shared definition of "session" for this issue (daemon polling session, single CLI run, or panel session).
- Capture reproducible steps — environment, commands, inputs, expected vs. actual outcome — in the issue before any spec work continues.
- Define the user-facing success criterion for "session closed" (graceful shutdown, error, hang, exit code, log line).
- Once clarified, produce a user flow that is exercisable from the CLI and/or the control panel.
- Ensure the resulting behavior is observable from existing logs, state files, or a new surface so the user can verify it.
- Avoid implementing any change before the product questions in this spec are answered.

## Non-goals

- Do not redesign the daemon polling lifecycle or the control-panel session model in this issue.
- Do not change shutdown, signal handling, or persistence semantics based on speculation about what "session closed" means.
- Do not auto-close or relabel issue #1; triage is out of scope for the spec agent.
- Do not write a technical implementation plan (TECH.md) until this PRODUCT.md is approved.

## User stories

### US-1 — Issue author clarifies what "session closed" reproduces

- **As a** the issue author
- **I want** to provide reproduction steps for the closed-session scenario in the issue body or a comment
- **So that** the spec agent can write a product specification grounded in a real user problem instead of guessing

Checks:

- [ ] Issue #1 body or a comment describes the command(s) or UI action(s) that produce a "session closed" state.
- [ ] The description names the surface involved: `factory start`, `factory start --once`, the daemon, or the control panel at `127.0.0.1:5174`.
- [ ] Expected vs. actual behavior is stated, including any error message, exit code, log line, or UI indicator.
- [ ] Environment (target repo, daemon mode, model adapter, Node version) is specified or explicitly marked as irrelevant.

### US-2 — Reviewer agrees on a definition of "session" for this issue

- **As a** a human reviewer of PRODUCT.md
- **I want** to resolve which definition of "session" applies — daemon polling cycle, single `factory start --once` run, or control-panel browser session
- **So that** the acceptance criteria below can refer to a concrete, observable boundary instead of an ambiguous noun

Checks:

- [ ] PRODUCT.md names the session boundary used in every acceptance criterion.
- [ ] Out-of-scope session boundaries are listed under Non-goals.
- [ ] The chosen boundary maps to an existing observable artifact (`.factory/state-<n>.json`, `.factory/daemon.log`, panel event, or exit code).

### US-3 — User can observe that session-closed behavior matches the documented expectation

- **As a** a user running the affected command or panel flow
- **I want** to see a clear, documented signal that the session ended as expected (exit code, log line, state file, or UI state)
- **So that** I can distinguish a normal session close from a crash, hang, or stuck state without reading source code

Checks:

- [ ] The signal is reachable from the CLI surface the issue names (e.g., `factory start --once` exit code and `.factory/state-<n>.json`).
- [ ] The signal is reachable from the control panel if the issue's "session" refers to the panel.
- [ ] The documented signal differs from the signals for crash, hang, and `needs-info` waits.

## Acceptance criteria

1. Issue #1 contains either an updated body or at least one comment that supplies reproduction steps and expected vs. actual behavior, or a human reviewer explicitly approves the placeholder wording above.
2. PRODUCT.md names the session boundary (daemon poll, `factory start --once` run, or panel session) used in every acceptance criterion.
3. For the chosen boundary, at least one observable signal of session close is identified (exit code, log line, state-file field, or panel event) and is referenced from a user story.
4. Out-of-scope session boundaries are listed under Non-goals so a future reader does not assume coverage.
5. Every open question in this spec is either resolved by the reviewer or explicitly deferred with an owner and a blocker note.
6. No code change is proposed in PRODUCT.md; implementation waits for TECH.md after this spec is approved.

## Open product questions

1. What does "session" mean in issue #1: a single `factory start --once` run, a daemon polling cycle, or a control-panel browser session at `http://127.0.0.1:5174`?
2. What reproduction steps, command(s), or UI actions lead to the "closed" state the user is reporting?
3. What is the expected behavior when the session closes — graceful exit with code 0, a specific log line in `.factory/daemon.log`, a panel status change, a state-file transition?
4. What is the actual behavior the user observed — crash, hang, non-zero exit code, missing log line, stale panel state?
5. Is the desired outcome to (a) reproduce the current behavior so it can be diagnosed, (b) fix a failure that occurs when the session closes, or (c) improve the observability of a normal close?
6. Which environment is affected — local install, cloud install, both, or neither — and does the model adapter or agent mode matter?
7. Is there a related issue, PR, or log excerpt that should be linked before this spec is approved?
