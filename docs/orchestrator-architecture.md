# Orchestrator responsibility boundaries

The orchestrator entry point retains scheduling, stage lifecycle, provider sessions, operator waits, failure handling, and project synchronization.
The main module delegates the spec loop through an explicit dependency interface without exposing its private methods or introducing a runtime import cycle.

| Module | Responsibility |
| --- | --- |
| contracts | Implementation acceptance and spec-budget error types |
| limits | Environment limit parsing and legacy exported limits |
| prior-attempt | Retry evidence and deprecated compatibility predicates |
| reroute | Stage-specific output invalidation and preservation |
| event-log | Stage events and verdict extraction |
| spec-fallback | Unmerged spec branch selection |
| review-artifacts | Annotated diff and review bundle files |
| spec-phase | Existing spec revision, rubric, review, and merge loop |
| decision-publish | Labels, decision comments, and operation receipts |

The barrel re-exports the modules so consumers of dist/factory/orchestrator.js keep their existing imports.
The private runSpecPhase method remains the scheduling entry point.
The extracted body receives only the repository, configuration, logging, persistence, and stage callbacks it uses.
Review comment marker namespaces remain byte-identical.

## Verification

Run npm test and npm run build.
Run node scripts/spec-lineage-check.mjs.
Pipeline contract tests are part of test:fast to prevent source-location and obsolete-policy assertions from drifting again.
The source-level private async runSpecPhase invariant is checked against TypeScript rather than bundled JavaScript, where TypeScript visibility modifiers are erased.
The CLI accepts --issue and --stage, not the obsolete --replay option in the original plan.
