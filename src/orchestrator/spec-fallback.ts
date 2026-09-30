import type { FactoryIssueState } from '../core/types.js';

/**
 * Return the git ref that should serve as the implementation base when
 * the spec isn't on `origin/<defaultBranch>`.
 *
 * Default implementation flow: spec PR was approved and merged, so the
 * spec files (`PRODUCT.md`, `TECH.md`) live on `origin/<defaultBranch>`
 * and the implementation agent reads them straight off the default
 * branch (line 873-878 in `runForIssue`).
 *
 * Author-override flow: spec PR exists but was REJECTED, the author has
 * since explicitly told the pipeline to skip review and proceed
 * (`直接进入implement` / `go to implement` / `approve directly`), and
 * triage has decided `ready-to-implement` on that evidence. The spec
 * files are NOT on `origin/<defaultBranch>` (the PR was never merged)
 * but they ARE on the spec PR branch — that's where the agent opened
 * the PR from. Falling back to that branch lets implementation proceed
 * without forcing a manual merge of a spec the author has already
 * overridden.
 *
 * Returns:
 *   - `null` when no fallback is available (caller treats this as
 *     "spec not reachable — surface to operator");
 *   - `origin/<state.specs.branch>` when the spec PR branch exists.
 */
export function resolveSpecFallbackRef(state: FactoryIssueState): string | null {
  if (!state.specs) return null;
  // The SpecPair type stores the branch under `specBranch` (not `branch`).
  // Reading `state.specs.branch` here would always be undefined and the
  // helper would silently return null — that was the original bug in the
  // first cut of this fix and the reason the spec-existence check still
  // threw on issue #34.
  const branch = (state.specs as { specBranch?: unknown }).specBranch;
  if (typeof branch !== 'string' || branch.length === 0) return null;
  return `origin/${branch}`;
}
