---
name: spec
description: Coordinate spec-driven development for an issue marked ready-to-spec by writing PRODUCT.md and TECH.md, opening a specs PR, and handing off to implementation.
---

# Spec

Create checked-in product and technical specs.

## Workflow

1. Identify the issue.
2. Verify `write-product-spec` and `write-tech-spec` skills are present.
3. Fetch full issue context.
4. Choose `specs/<issue-slug>/` and create it.
5. Write `PRODUCT.md` using `write-product-spec`.
6. Write `TECH.md` using `write-tech-spec`.
7. Return the spec pair to the orchestrator, which publishes the specs pull request and runs independent review.
8. After rejection, fix each supplied finding in the existing documents and preserve unrelated correct text.
9. The orchestrator advances to implementation only after spec review approves the current revision.

## Guardrails

- Never implement the product change during spec work.
- Never close, assign, or relabel the issue.
- Never write substitute PRODUCT.md / TECH.md content from memory — follow the shared skills.
