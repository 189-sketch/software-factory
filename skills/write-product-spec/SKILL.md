---
name: write-product-spec
description: Write a PRODUCT.md that defines user-facing behavior, goals, non-goals, user stories, acceptance criteria, and open product questions.
---

# Write Product Spec

## Sections (in order)

1. **Title & Status** — feature title, status (Draft / Ready for review / Approved).
2. **Problem** — one-paragraph user problem statement.
3. **Goals** — 3–7 bullet outcomes the feature must achieve.
4. **Non-goals** — 2–5 bullets this feature explicitly does NOT cover.
5. **User stories** — at least 3, each with `As a …`, `I want …`, `So that …`, and a checks list.
6. **Acceptance criteria** — 3–7 testable conditions.
7. **Open product questions** — questions a reviewer must answer before implementation.

## Rules

- Stories must be exercisable in a UI or CLI flow.
- Acceptance criteria must be observable.
- Open questions must be specific and blocking.

## Review rubric self-check (R-series)

The spec reviewer judges this document through structured judgment points.
Before returning, verify each rule against your own draft — a violation rejects the spec:

- **R1 — every AC is satisfiable as written.**
  An AC passes R1 if any one of the following holds:
    - (a) it names a concrete automated assertion (test / command / observable DOM/CLI/API signal) that proves it, OR
    - (b) it names a reference system (Apple HIG / Material 3 / Tailwind UI / Polaris / …) plus the artifact to compare against, OR
    - (c) it references an explicit default table the spec body declares (token table, motion scale, …) and the spec body offers an author-override channel (PR comment before auto-merge).
  The author need not pre-specify numeric values the issue never asked for — a named reference + declared defaults is satisfiable. An AC like "looks polished" with no reference and no defaults still fails R1.
- **R2 — story↔AC coverage with matching quantifiers.**
  Every check in every user story must be covered by an acceptance criterion at the SAME quantifier: if a check promises all four properties, the AC must require all four — never "at least one of".
- **R4 — no ride-along open questions.**
  Only list a question when implementation genuinely cannot start without the author's answer.
  Anything the spec itself can settle, settle it in the spec with a pinned default.
- **R5 — every story is in scope.**
  Each story must decompose what the issue (or a binding author reply) actually asks for.
  No silently added functionality.
- **R6 — non-goals stay unimplemented.**
  Nothing in the spec (or the TECH.md you will write next) may deliver a listed non-goal.
- **UI/visual work — declare a visual reference + default token table.**
  Before writing stories for any visual change:
    - Choose a reference system (Apple HIG / Material 3 / Tailwind UI / Polaris / …) appropriate to the issue's stated direction.
    - Declare a default token table — concrete values for color hex, type sizes, radii, shadow, alpha range, easing curves as cubic-bezier numbers. Pin them in a "Default tokens" section of PRODUCT.md (and again in TECH.md).
    - In every AC that references visual properties, name the reference system AND/OR point to the default token section; the AC is satisfiable as written without the author naming every value.
    - Surface the override channel: "the author may override any default by commenting on this PR before it auto-merges."
  When the issue body already supplies specific tokens or a design system, use those verbatim instead.
- **Revision pass — resolve every prior finding.**
  When revising after a REJECT, each previous finding is re-judged individually (R7).
  A finding that still applies after your edit rejects the spec again; edit the exact contradicting/vague/brittle text, do not merely reword around it.
