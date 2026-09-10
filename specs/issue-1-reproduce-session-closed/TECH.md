# TECH.md

## Title & Status

- **Title:** Reproduce session closed
- **Issue:** #1
- **Status:** Draft — blocked on missing issue context
- **Owner:** spec agent

> This TECH.md pairs with the approved PRODUCT.md for Issue #1. Because the approved PRODUCT.md explicitly marks the session boundary, reproduction steps, and expected vs. actual behavior as open product questions, this TECH.md does not propose a concrete code change. It documents the diagnostic surface, the smallest possible intervention shape, and the validation plan that will activate once those product questions are resolved. No paths, constraints, or requirements beyond what the approved PRODUCT.md and the repository expose are invented here.

## Approach

The approved PRODUCT.md states that issue #1's body is `test` with no comments, and that 'session' is ambiguous across at least three boundaries in this repository:

- a single `factory start --once` run,
- a daemon polling cycle managed via `.factory/daemon.pid`,
- a control-panel browser session served at `http://127.0.0.1:5174`.

The technical direction is therefore deliberately diagnostic and conditional:

1. **Enumerate, do not edit, candidate surfaces.** Map each session boundary to the module most likely to own its lifecycle: the CLI entry point, the daemon runner and its lifecycle helper, and the panel server. Do not modify any of them yet.
2. **Define the smallest possible guard shape.** When a boundary is chosen, the fix will be a narrow predicate on the session-close transition of that surface, asserting that a close must be attributable to an explicit, named trigger. This shape is bounded enough that it does not redesign shutdown, signal handling, or persistence — all of which are non-goals in the approved PRODUCT.md.
3. **Gate any future change behind the existing feature flag** for the affected subsystem so it can be disabled without redeploy.
4. **Refuse to ship instrumentation speculatively.** Telemetry will be scoped to the single surface that wins the boundary question, not spread across all three.

This approach preserves the non-goals in PRODUCT.md and means this TECH.md produces zero runtime change in its current Draft state.

## Affected areas

The following paths are listed as candidate surfaces only; the set will be reduced to one (plus its test file) once the product boundary is resolved:

- `src/cli/factory.ts` — entry point for `factory start` and `factory start --once`; candidate for a single-run session boundary.
- `src/daemon/runner.ts` — owns the daemon polling loop and `.factory/daemon.pid` lifecycle; candidate for a daemon polling session boundary.
- `src/daemon/lifecycle.ts` — helper module for daemon state transitions and teardown signals; candidate for the close trigger on the daemon boundary.
- `src/panel/server.ts` — serves the control panel at `http://127.0.0.1:5174`; candidate for a panel browser session boundary.
- `tests/cli/factory.spec.ts` — test surface for the CLI boundary.
- `tests/daemon/lifecycle.spec.ts` — test surface for the daemon boundary.
- `tests/panel/server.spec.ts` — test surface for the panel boundary.

No additional paths are invented. If localization reveals a fourth module, it will be added in a revision of this TECH.md, not assumed now.

## Data model

No schema changes are proposed.

- The persisted artifacts associated with each candidate boundary are listed, not modified: `.factory/state-<n>.json` for a single CLI run, `.factory/daemon.pid` plus `.factory/daemon.log` for a daemon polling session, and the in-memory panel session state held by `src/panel/server.ts` for a browser session.
- Invariant under whichever boundary is chosen: a session-close transition must be attributable to an explicit, named trigger (graceful exit, signal, expiry, or admin action) and must be observable in the artifact associated with that boundary.
- No cross-boundary invariant is asserted, because the boundary itself is an open product question. Asserting one would silently extend scope into the non-goals from PRODUCT.md.

## API changes

- No new endpoints are introduced.
- No request/response shapes of existing CLI commands or panel routes are modified.
- No new error codes are introduced. Error semantics for the chosen surface remain whatever they are today until localization confirms the bug.

This list will be revised only if the chosen surface turns out to expose a contract that needs a clarifying error code, and even then only after the product boundary question is answered.

## Migration plan

- No data migration. The persisted artifacts listed above are read, not rewritten.
- No rollout in this Draft state, because no code change ships from this TECH.md. The approved PRODUCT.md's non-goals forbid implementing before the open product questions are resolved.
- Posture for any future fix derived from this TECH.md: gate the change behind the existing feature flag for the affected subsystem (CLI runner, daemon, or panel) so it can be disabled without redeploy.
- Rollback in that future state is a flag flip with no destructive data consequence, because no persisted schema changes.
- Tradeoff: this conservatism has zero runtime cost today because nothing changes. Its only real cost is delay: if the open product questions remain unresolved past the next spec cycle, the correct action is to close the issue as `needs-info` rather than to relax the non-goals and guess.

## Validation plan

These validation items activate only after the open product questions are answered and the boundary is fixed. They reference the approach above: a narrow predicate on the chosen surface, observable in the chosen artifact, with no cross-boundary effects.

1. **Failing regression unit test** — Write a unit test in the test file that matches the chosen boundary (`tests/cli/factory.spec.ts`, `tests/daemon/lifecycle.spec.ts`, or `tests/panel/server.spec.ts`) that reproduces the reported close against the chosen artifact (`.factory/state-<n>.json`, `.factory/daemon.log`, or panel state) and asserts the documented expected outcome. The test must fail before the fix and pass after.
2. **End-to-end integration test** — Drive the chosen surface end-to-end and assert that the observable signal named in the acceptance criteria (exit code, log line, state-file field, or panel event) is present and unambiguous, and that it differs from the signals currently produced for crash, hang, and `needs-info` waits.
3. **Manual verification on the local install** — Run the documented reproduction steps, capture the observable signal, and confirm it matches the documented expectation. This step is required because the issue asks for reproduction, not just a unit-level green build.
4. **Regression sweep of untouched suites** — Re-run the existing CLI, daemon, and panel test suites to confirm that no diagnostic instrumentation (if any is added temporarily during localization) alters behavior on the surfaces that were not chosen.

If any of these fail, the fix is not considered complete and the feature flag for the chosen subsystem must remain off in that environment.

## Alternatives considered

- **Speculatively refactor the daemon polling lifecycle** so that 'session closed' is idempotent and idempotently observable across all three boundaries at once. Rejected: the approved PRODUCT.md forbids implementation until the session boundary is resolved, and a cross-boundary refactor would change shutdown, signal handling, and persistence semantics — all listed as non-goals in PRODUCT.md.
- **Add blanket telemetry to every candidate module** so we can mine logs to determine the boundary after the fact. Rejected for this issue: it expands the observability surface and complicates log schemas before we know which surface is even relevant. Once the boundary is chosen, telemetry can be scoped to that one surface.
- **Close the issue as `cannot reproduce` immediately.** Rejected: the issue title contains an imperative ('Reproduce') that suggests the user wants the behavior reproduced for diagnosis, not dismissed; the approved PRODUCT.md asks the author for clarification first instead.

## Open technical questions

These questions are inherited from the approved PRODUCT.md and are blocking. They remain unresolved as of this draft.

1. **Which session boundary applies** — `factory start --once` run, daemon polling cycle, or panel browser session at `127.0.0.1:5174`? This blocks selection of the affected module and test file.
2. **What reproduction steps produce the 'session closed' state?** Without them, no regression test can be written.
3. **What is the expected observable signal for a normal close** (exit code, log line, state-file field, panel event), and what is the actual signal the user observed? This blocks the assertion in the validation test.
4. **Is the desired outcome (a) reproduce for diagnosis, (b) fix a failure on close, or (c) improve observability of a normal close?** Each maps to a different technical approach (instrumentation, guard, or signal surfacing).
5. **Which environment is affected** (local install, cloud install, both) and does the model adapter or agent mode influence the behavior? This blocks whether the fix must cover more than one code path.
6. **Are there linked issues, PRs, or log excerpts** that localize the bug to one of the three candidate modules? Without them, the affected-areas list above remains a guess across three surfaces.

Once these are answered, the `Affected areas` list will be reduced to a single module plus its test file, the unit and integration tests described in the validation plan will be authored against that module, and this TECH.md will move from Draft to Ready for review. Until then, no code in this repository should change as a result of issue #1.