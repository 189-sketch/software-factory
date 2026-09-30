---
name: improve-review-pr
description: Daily outer loop that reviews human reactions to automated review-pr comments and opens a PR to update the review-pr skill when durable organizational knowledge is found.
---

# Improve Review PR

## Workflow

1. Collect the last 24h of review-agent interactions via `scripts/collect-feedback.mjs` (called from `src/agents/improve-review-pr.ts`).
2. Score each feedback item: validated / corrected / refined / ambiguous.
3. Synthesize durable organizational knowledge.
4. Decide between `no_changes` (no durable signal — stop) and `update_review_pr` (apply small, cohesive edits to `skills/review-pr/SKILL.md` or the local companion). The current implementation only emits these two outcomes; `update_review_pr_local` and `both` are reserved for future extensions and are not produced today.
5. Open a skill-improvement PR; never merge it.

## Guardrails

- Never change the JSON schema, severity labels, or safety rules.
- Never open a PR for weak, one-off, or already-encoded feedback.
- Prefer small, durable rules over PR diaries.
