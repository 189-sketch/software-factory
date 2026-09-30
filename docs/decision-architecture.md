# Decision Architecture

> A short, human-reader summary of the decision-architecture spec.
> For the contract details, see [`specs/2026-09-20-decision-architecture/`](../specs/2026-09-20-decision-architecture/).

## The Thesis

A software factory that aims to ship high-quality code autonomously must make **a large number of internal decisions** on every issue, on every polling cycle, on every retry.
Today those decisions are made implicitly: an LLM is given one large prompt and a large JSON output contract, and the human-readable prose it produces happens to also include the verdict fields the orchestrator needs.
This couples "judgement" to "generation" and forces the factory to choose between two bad options:

- **Tight prompt + strict parse** — every decision becomes a parse-fragile field on a single LLM response.
- **Loose prompt + generous parse** — every decision is best-effort and the orchestrator can't tell when the model was unsure.

The decision architecture separates the two concerns.

## The Layer Split

```
                Issue / PR / Spec / Receipts
                              │
                              ▼
        ┌─────────────────────────────────────────┐
        │   State Object  (`JudgmentState`)       │
        │   read-only, shared across primitives   │
        └─────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌──────────┐    ┌──────────┐    ┌──────────┐
        │ Choice   │    │  Score   │    │  Noul    │
        │  + conf  │    │  + conf  │    │  + conf  │
        └──────────┘    └──────────┘    └──────────┘
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                judgment + confidence surface
                              │
                              ▼
        ┌─────────────────────────────────────────┐
        │  Routing  (per-action confidence gates)│
        │  auto | confirm | escalate              │
        │  ─ read from `decisions.yaml`           │
        └─────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
        Auto-proceed                  Author / Operator
              │
              ▼ (only when narrative output is needed)
        ┌─────────────────────────────────────────┐
        │   Generation Layer (Claude CLI)         │
        │   prose, code, inline comments,         │
        │   correction messages                   │
        └─────────────────────────────────────────┘
```

Two parallel calls on the same `JudgmentState`:

- **Judgment** — TypeSafe (Jev) batch primitive calls: `Choice`, `Score`, `Noul`.
  Fast, cheap, calibrated, returns confidence.
  Used for the ~22 migratable decision points in factory today.
- **Generation** — Claude CLI: prose, code, inline bodies.
  Used when the author (or operator) needs to read a human-language artefact.

The orchestrator composes both into a final stage result.

The current routing seam is the pure `applyDecision(action, payload, decisions)` function in `src/core/decision-router.ts`.
It reads the parsed `decisions.yaml` table and returns `auto`, `confirm`, or `escalate`.
`decisionRouter.apply` is a frozen alias of the same function, not a second implementation.
For PR merges, `blocking_findings_max` is a hard veto: a high confidence score cannot override a blocking finding.

## The Eight Decisions (Phase A)

| # | Decision | One-line summary |
| --- | --- | --- |
| 1 | Judgment is a first-class primitive | Every verdict / status / severity / action field is a typed primitive, not a side-effect of text generation. |
| 2 | Judgment and Generation are physically layered | A new `typesafe` readonly backend is registered in the Phase 11 dispatcher; the dispatcher itself is unchanged. |
| 3 | State is shared, not duplicated | `JudgmentState` is the canonical state object every primitive consumes; no per-agent `evidenceBlock`. |
| 4 | Freshness is the primary polling optimisation | A cheap `Noul` on a tiny state hash short-circuits ~90% of polling-cycle judgments. |
| 5 | Routing is configurable, not hard-coded | Per-action confidence thresholds live in `decisions.yaml`; operators retune without code. |
| 6 | Composite scoring drives the operator dashboard | A four-dimension health signal (spec / impl / review / verify) is composed in code from four `Score` primitives. |
| 7 | CJK fallback is a hard constraint | `typesafe` fails / confidence falls below threshold → automatic fallback to `claude-code` with structured logging. |
| 8 | Deterministic classifiers stay deterministic | `failure-classifier.ts` and `verification-guard.ts` are regex tables and remain so. |

## The Decision Inventory (Phase B / C targets)

| Category | Count | Migration phase |
| --- | --- | --- |
| A — polling-time judgments | 5 (4 migratable + 1 deterministic) | A1, A2, A3 → Phase B; A5 → Phase C |
| B — per-stage judgments | 16 (14 migratable + 2 deterministic) | B7–B14 → Phase B; B1–B3 → Phase C |
| C — cross-stage strategy | 4 | Phase C |
| D — operational | 5 | Phase C |
| E — meta-decisions | 4 | E1 → Phase B; E2–E4 → Phase C |
| **Total** | **37** (32 migratable + 5 deterministic) | |

## What Phase A Ships

- `specs/2026-09-20-decision-architecture/requirements.md` — the architecture contract (Decisions 1–8, full inventory, `JudgmentState`, freshness protocol, `decisions.yaml`, composite rubric, CJK fallback contract).
- `specs/2026-09-20-decision-architecture/plan.md` — DAG + task table.
- `specs/2026-09-20-decision-architecture/validation.md` — 7-layer pyramid.
- `scripts/spec-lineage-check.mjs` — 12 named checks enforcing the spec's structural completeness.

## What Phase A Does NOT Ship

- No `runtime/typesafe-backend.mjs` — that is Phase B's first executable task.
- No actual judgment migration — every agent still calls Claude.
- No UI changes — confidence distributions are not yet visible in the control panel.
- No dispatcher changes — `BACKEND_DESCRIPTORS` does not yet contain a `typesafe` entry.

## Where to Read More

| Document | What it answers |
| --- | --- |
| `specs/2026-09-20-decision-architecture/requirements.md` | "What is being built?" |
| `specs/2026-09-20-decision-architecture/plan.md` | "How will it be built?" |
| `specs/2026-09-20-decision-architecture/validation.md` | "How do we know it's built?" |
| `specs/2026-09-16-unified-agent-runtime/requirements.md` Decision 3 | "How does this fit into Phase 11's roadmap?" |

## Cross-References

- Phase 11 Slice C–F (`specs/2026-09-16-unified-agent-runtime/requirements.md`) — the dispatcher contract this spec extends via a new readonly backend descriptor.
- `docs.typesafe.ai/concepts/system-one.md` — the upstream mental model behind the primitive vocabulary.
- `docs.typesafe.ai/patterns/intent-routing.md` — direct inspiration for the routing matrix (`decisions.yaml`).

---

> Last updated: 2026-09-20 (Phase A scaffold landed at commit `7019dc6` on branch `phase-2-decision-architecture`).
