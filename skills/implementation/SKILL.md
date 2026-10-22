---
name: implementation
description: Implement a fix or feature from a GitHub issue by making the smallest cohesive code change, validating it, optionally verifying visible behavior via verify-behavior, and opening a pull request.
---

# Implementation

## Workflow

1. Identify the issue.
2. If `PRODUCT.md` / `TECH.md` exist, read them first.
3. Inspect the codebase to find affected areas.
4. Make the smallest cohesive change that satisfies the issue.
5. Run validation: tests, lint, typecheck, build.
6. If `PRODUCT.md` / `TECH.md` exist, run `validate-changes-match-specs`.
7. If the change has visible UI behavior, run `verify-behavior` in `verify` mode.
8. Open a branch and pull request; capture the PR URL.
9. Post a final comment on the issue with the PR URL, validation summary, and verification result.

## File naming

- Use **descriptive kebab-case file names** derived from the issue title:
  - `src/<slug-of-title>.js` (or `.ts`) for the implementation module
  - `tests/<slug-of-title>.test.js` for the Node test file
  - If the repo already has a convention (`__tests__/`, `spec/`, `test/`), follow that convention instead.
- **Never** use the legacy `feature-<number>.*` pattern — that hardcodes the issue id into the file name, pollutes the repo with semantic-free names, and gets the diff REJECTed by review-pr's regex rules (the runner's own code under `factory/` historically tripped the same rule).
- If the issue title produces an empty slug (only punctuation, only emojis, only CJK that wouldn't slugify), surface the bad title in the final issue comment so the author can rename it; otherwise the implementation agent will pick a reasonable fallback.

## Guardrails

- Never implement without fetching issue context.
- Never expose secrets, tokens, or internal reasoning.
- Never claim verification passed without an explicit result or blocker.
- Keep type checks effective: install the compatible development type package instead of broad ambient module declarations or ignored errors.
- Trace shared mutable state through route unmounts and multiple consumers; allocate IDs in the same owner as the stored tasks.
- Never describe implementation as complete without an actual PR URL.
