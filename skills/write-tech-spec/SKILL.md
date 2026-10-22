---
name: write-tech-spec
description: Write a TECH.md that describes implementation approach, affected code areas, data model, API changes, validation plan, and open technical questions.
---

# Write Tech Spec

Before returning, trace each worked example and expected result back to the product behavior.
For filesystem or CLI flows, identify the invocation directory, resolved target directory, affected paths and final next-step working directory explicitly.
Check that formulas, prose and validation assertions resolve to the same target, including any generated child directory.
A configured CI matrix is an execution plan; actual job results are required to claim cross-platform validation has passed.

## Sections (in order)

1. **Title & Status** — same as PRODUCT.md.
2. **Approach** — one-paragraph technical direction.
3. **Affected areas** — list of files / modules / services to touch.
4. **Data model** — schema changes or invariants.
5. **API changes** — endpoints, request/response shapes, error semantics.
6. **Migration plan** — backwards compatibility, rollout.
7. **Validation plan** — unit tests, integration tests, behavioral verification.
8. **Alternatives considered** — at least one rejected alternative with rationale.
9. **Open technical questions** — questions blocking implementation.

## Rules

- Approach must be concrete enough to start coding.
- Affected areas must reference real paths in the codebase.
- Treat allowed paths as an upper bound, and compare implementation changes against their actual PR base after the separate specification PR lands.
- Verify scenario behavior through assertions and actual CI results, rather than imposing test counts or mirrored test-source parsing algorithms.
- Open questions must be specific and blocking.
- Verify affected files and dependency manifests before distinguishing new files from modifications.
  Preserve existing test setup behavior and explicitly declare every new test dependency.
- Verify dependency API signatures and initialization requirements against installed declarations or primary documentation.
  Cite the inspected path or source beside the decision; do not invent methods, versions or differences between browser and unit-test initialization.
- Cross-check action semantics, side effects, failure states and exact validation messages throughout the document.
  A targeted fix must update every contradictory occurrence while preserving unrelated correct requirements.

## Review rubric self-check (R-series)

The spec reviewer judges this document through structured judgment points.
Before returning, verify each rule against your own draft — a violation rejects the spec:

- **R2 — the approach delivers every story at matching quantifiers.**
  Each PRODUCT.md user-story check must be deliverable by the approach as written; if a story promises a set (e.g. transitions on four properties), the approach and ACs must cover the whole set, not a subset.
- **R3 — every validation-plan item is satisfiable as written.**
  A VP item passes R3 if any one of the following holds:
    - (a) it names a runnable automated check (test file / command / observable signal) whose result depends only on real behaviour or parsed style rules,
    - (b) it names a specific tool with input args (e.g. `axe-core --tags wcag2aa`, `playwright visual-diff against specs/<slug>/tokens.baseline.png`, `vitest run tokens.spec`, `eslint --rule no-restricted-syntax …`),
    - (c) it names a manual review with an explicit checklist the reviewer must walk.
  "Verify manually" without a checklist still fails R3.
  Style/content assertions must parse the artifact (e.g. a Vitest test reading computed `cssText`, or a small CSS parser that strips comments) — a raw grep over source still fails R3 because it false-positives on comments and string literals.
- **R1 — AC references stay satisfiable.**
  When TECH.md restates or implements a PRODUCT.md acceptance criterion, keep it in one of the three R1 forms (automated assertion / named reference / default token table + override channel) — do not soften a numeric AC into an adjective that names no reference and references no defaults.
- **Affected areas ↔ migration plan mutual coverage.**
  Every file listed in Affected areas appears in a Migration plan step, and every Migration plan step names only listed files.
- **R6 — never implement a PRODUCT.md non-goal.**
  Check the approach, affected areas, and migration plan against every non-goal before returning.
- **R4 — no ride-along open questions.**
  Only list a technical question when implementation genuinely cannot start without the answer; settle everything else in the document with a concrete decision.
- **Revision pass — resolve every prior finding.**
  When revising after a REJECT, each previous finding is re-judged individually (R7).
  Edit the exact contradicting/vague/brittle text the finding names; a finding that still applies after your edit rejects the spec again.
