---
name: verify-behavior
description: Verify or reproduce product behavior with task-appropriate executable assertions and factory-issued execution receipts.
---

# Verify Behavior

## Modes

- `reproduce` — does the bug still happen on baseline?
- `verify` — does the implemented change match expected behavior?

## Workflow

1. Read the issue and approved PRODUCT.md acceptance criteria, including human constraints.
2. Choose an acceptance method for each required behavior from its meaning and the actual implementation, without classifying from isolated words or unrelated repository surfaces.
   Exercise required failure outcomes at the actual boundary where the operation can fail.
   For durable storage, verify both completed persistence and a failed backing-store commit, including success/error feedback, input retention and reload behavior required by the AC.
   A synchronous facade mock or failure before the write starts does not establish behavior when its asynchronous commit fails.
   Use isolated temporary fixtures when fault injection is needed and keep product files unchanged.
   Declare any failure outcome that could not be exercised instead of claiming complete coverage.
   Derive lifecycle scenarios from actual state ownership.
   When stored state survives a page or consumer, repeat the operation after navigating away and returning, or after remounting the consumer.
   Assert both the resulting state and independent operation of retained and newly created items.
   Exercise multiple entry points when they share the same state owner; a passing single-use helper does not establish this boundary.
3. For CLI and filesystem behavior, use `run_acceptance_test` to execute the actual command and assert exit status, output and required filesystem effects.
   For browser interaction behavior, start the actual application with `start_service` and use `browser` actions and assertions against its returned URL.
   Mixed requirements need the appropriate evidence for each acceptance criterion.
4. Register each executed assertion with `record_acceptance_check`, exact current-run receipt IDs and the authoritative requirement IDs.
   Cite the live assertions for each claimed outcome and the preceding actions that establish their cause.
   Page text returned by an action is diagnostic context, not a recorded assertion.
   A test runner's total passed count does not disclose what its tests asserted.
   Use detailed test output and source-bound temporary acceptance fixtures when the existing test receipt does not expose the required assertions.
   Expected CLI refusals need wrapper assertions that succeed when the required exit status, diagnostic and side effects are observed.
5. Return `verified`, `not-verified` or `blocked` in verify mode, and `confirmed`, `not-reproduced` or `blocked` in reproduce mode.
   Explain the method, observations and limitations in notes; independent judgment checks whether the method and receipts establish the required behavior.
6. Produce a `BehaviorVerificationResult` with `ozRunUrl`, `evidence[]`, checks and notes, following the supplied output contract.

## Guardrails

- When an AC requires actual CI execution, use collect_ci_checks to read existing runs for the current implementation commit and register its issued receipt.
- Check every required runner/job, terminal status, conclusion and run URL.
- Do not trigger another workflow merely to collect evidence that already exists.
- CI YAML configuration and a local Windows run do not prove successful Linux execution.

- Real process assertions and live Playwright browser assertions are supported by the factory tools.
- Process verification uses the existing `desktop` channel value; native desktop interaction is unavailable and must be reported as blocked when required.
- A passing command, startup, screenshot or self-report alone cannot prove a required browser interaction.
- Tool errors or an incorrect assertion do not by themselves establish a product defect.
- A contrary live application observation remains unresolved until an executed control explains it.
  Do not dismiss duplicate effects, missing feedback or other unexpected behavior as a tool artifact based on a passing helper test.
  Compare the real application bootstrap and execution mode with the helper before deciding what the observation demonstrates.
- Create additional tests with `write_acceptance_fixture` using literal source content, then execute the returned path with `run_acceptance_test` using `program` and `args`.
- Do not use shell redirection, heredocs or escaped `node -e` commands to write tests.
- The fixture tool owns temporary test files, archives their source and removes them after verification; existing product files and tests must remain unchanged.
- When a tool rejects a command, use the supported typed tool instead of trying alternate shell encodings.
- Every screenshot posted to GitHub must have a caption naming the observed state and what it demonstrates.
- There is no native Oz video capture path today; do not claim one was produced.
- Never start a third-party screen recorder or invoke any parent-level recording APIs to "fabricate" video evidence.
- Never invent `gh --attach` uploads for non-existent videos.
