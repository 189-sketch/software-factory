/**
 * Helpers for distinguishing factory-internal comments from author
 * (or any non-factory) comments on a GitHub issue thread.
 *
 * The factory signs every comment it posts with one of the markers below
 * so downstream agents can tell whose voice a comment belongs to without
 * relying on the GitHub login (which is unreliable when an operator and
 * a factory bot share an account, as happens in the smoke-test fixture).
 *
 * Triage / spec / review agents all read `issue.comments` and need to
 * weigh author replies against factory status posts. Without a shared
 * classifier each agent re-implements the rule and silently drops the
 * factory's `<!-- pi-software-factory:... -->` markers from its view
 * — which is exactly the bug that left issue #24 at needs-info for ~2h.
 */

export const FACTORY_COMMENT_MARKERS = Object.freeze([
  "<!-- pi-software-factory:triage:",
  "<!-- pi-software-factory:spec-review:",
  "<!-- pi-software-factory:pr-review:",
] as const);

/**
 * True when the comment was posted by the factory itself. False for
 * unmarked comments (treat as author voice).
 */
export function isFactoryComment(comment: { body?: string } | null | undefined): boolean {
  if (!comment) return false;
  const body = comment.body ?? "";
  for (const marker of FACTORY_COMMENT_MARKERS) {
    if (body.includes(marker)) return true;
  }
  return false;
}

/**
 * True when the most recent comment on the issue is from the author
 * (or any non-factory voice). Used by the orchestrator as a stronger
 * signal than JSON.stringify-equality on the comments array: even when
 * the checkpoint was just saved with the author's reply already inside,
 * the author voice at the bottom still warrants a fresh triage.
 */
export function latestVoiceIsAuthor(
  comments: ReadonlyArray<{ body?: string }> | null | undefined,
): boolean {
  if (!comments || comments.length === 0) return false;
  return !isFactoryComment(comments[comments.length - 1]);
}
