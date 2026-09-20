/**
 * Artifact tracker (M5).
 *
 * `IssueStore.save()` used to write the whole `FactoryIssueState`
 * blob to disk and call that a checkpoint. The actual recoverable
 * artifacts (spec files, review verdicts, implementation commits,
 * verification evidence) were buried inside opaque `body` / `commit`
 * fields with no content hash, so a recovery tool could not tell
 * whether the bytes on disk matched the bytes the previous stage
 * intended.
 *
 * This module sits between the orchestrator and `IssueStore.save`:
 * it observes the artifact fields the orchestrator just wrote,
 * computes content hashes, and appends an entry to
 * `state.artifacts[]` so the checkpoint carries a self-describing
 * audit trail. Pure functions; no I/O; orchestrator passes the
 * resulting artifact into the save payload.
 *
 * Design choices:
 *   - We hash the body the orchestrator hands us rather than
 *     re-reading the file, because the spec agent and orchestrator
 *     may disagree about which copy is canonical (see
 *     `assertSpecFilesMatchBodies` for the guard). The hash we
 *     record is the hash of the body the orchestrator committed.
 *   - `parentRevision` chains revisions of the same kind. Recovery
 *     tools can answer "what came before this spec commit?" with
 *     one walk.
 *   - The tracker is best-effort: failures inside it never block
 *     a save. The orchestrator's caller will see an empty
 *     `artifacts[]` rather than a save failure, and the existing
 *     `assertSpecFilesMatchBodies` path is the only hard guard.
 */
import { randomUUID } from "node:crypto";

import type { ArtifactRevision, FactoryIssueState, SpecPair, SpecReviewResult, ImplementationResult, ReviewResult, BehaviorVerificationResult } from "./types.js";
import { hashText } from "./artifact-hash.js";

/**
 * Logical kind strings used in `ArtifactRevision.kind`. The same
 * vocabulary as `ExternalOperationKind` plus a few spec-only kinds;
 * kept as a string union so future kinds do not require touching
 * this file.
 */
export type ArtifactKind =
  | "spec-product"
  | "spec-tech"
  | "spec-review"
  | "implementation-commit"
  | "review-pr"
  | "verify-evidence";

/** A descriptor of an artifact the caller just produced. */
export interface ArtifactDescriptor {
  kind: ArtifactKind;
  /** Stable text body the orchestrator committed. */
  body: string;
  /** Optional filesystem path the body was written to. */
  path?: string;
  /** Stage that produced the artifact. */
  sourceStage: string;
  /** Run id of the producing stage. */
  sourceRunId: string;
}

/**
 * Append a revision entry to `state.artifacts[]` if and only if the
 * artifact's hash changed since the previous revision of the same
 * kind. The function is pure: it never mutates the input
 * descriptor, and it returns a new array reference so the caller
 * can pass it back to `IssueStore.save`.
 *
 * When the most recent entry of the same kind has the same hash,
 * the function returns the input array unchanged (no-op) so the
 * checkpoint does not bloat with duplicate revisions.
 */
export function recordArtifact(
  state: FactoryIssueState,
  descriptor: ArtifactDescriptor,
): ArtifactRevision[] {
  const existing = state.artifacts ?? [];
  const previous = lastOfKind(existing, descriptor.kind);
  const hash = hashText(descriptor.body);
  if (previous && previous.hash === hash) {
    return existing;
  }
  const revision: ArtifactRevision = {
    id: randomUUID(),
    kind: descriptor.kind,
    hash,
    path: descriptor.path,
    sourceRunId: descriptor.sourceRunId,
    sourceStage: descriptor.sourceStage,
    parentRevision: previous?.id,
    registeredAt: new Date().toISOString(),
  };
  return [...existing, revision];
}

/**
 * Convenience wrapper: derive the artifact descriptor for a
 * `SpecPair` and return the updated artifacts array. Records both
 * product and tech kinds so a recovery tool can see the full
 * spec at a glance.
 */
export function recordSpecArtifacts(
  state: FactoryIssueState,
  spec: SpecPair,
  sourceStage: string,
  sourceRunId: string,
): ArtifactRevision[] {
  let artifacts = state.artifacts ?? [];
  const slug = spec.product.slug;
  const productPath = slug ? `specs/${slug}/PRODUCT.md` : undefined;
  const techPath = slug ? `specs/${slug}/TECH.md` : undefined;
  artifacts = recordArtifact(state, {
    kind: "spec-product",
    body: spec.product.body,
    path: productPath,
    sourceStage,
    sourceRunId,
  });
  artifacts = recordArtifact(
    { ...state, artifacts },
    {
      kind: "spec-tech",
      body: spec.tech.body,
      path: techPath,
      sourceStage,
      sourceRunId,
    },
  );
  return artifacts;
}

/** Record a spec review verdict. Body is the prose; findings
 * (if present) are not hashed separately — the body captures the
 * full reviewer output and is what the orchestrator serializes. */
export function recordSpecReviewArtifact(
  state: FactoryIssueState,
  review: SpecReviewResult,
  sourceStage: string,
  sourceRunId: string,
): ArtifactRevision[] {
  return recordArtifact(state, {
    kind: "spec-review",
    body: review.body,
    sourceStage,
    sourceRunId,
  });
}

/** Record an implementation result. Only the commit SHA is
 * persisted — the `comment` is a human narrative, not a body
 * whose bytes downstream stages will read. Use `recordArtifact`
 * separately if the implementation produces a file the
 * orchestrator wants to track. */
export function recordImplementationArtifacts(
  state: FactoryIssueState,
  impl: ImplementationResult,
  sourceStage: string,
  sourceRunId: string,
): ArtifactRevision[] {
  const existing = state.artifacts ?? [];
  return recordCommitShaArtifact(state, existing, {
    kind: "implementation-commit",
    commitSha: impl.commitSha,
    sourceStage,
    sourceRunId,
  });
}

/** Record a PR review verdict. */
export function recordReviewPrArtifact(
  state: FactoryIssueState,
  review: ReviewResult,
  sourceStage: string,
  sourceRunId: string,
): ArtifactRevision[] {
  return recordArtifact(state, {
    kind: "review-pr",
    body: review.body,
    sourceStage,
    sourceRunId,
  });
}

/** Record a verify-behavior evidence blob. */
export function recordVerifyEvidenceArtifact(
  state: FactoryIssueState,
  evidence: BehaviorVerificationResult,
  sourceStage: string,
  sourceRunId: string,
): ArtifactRevision[] {
  return recordArtifact(state, {
    kind: "verify-evidence",
    body: JSON.stringify(evidence, null, 2),
    sourceStage,
    sourceRunId,
  });
}

/**
 * Internal: append an artifact whose `hash` is the commit SHA
 * (used for `implementation-commit` and `pr-merge`). Recovery tools
 * can resolve the SHA through git rather than re-running the
 * producing stage.
 */
function recordCommitShaArtifact(
  _state: FactoryIssueState,
  existing: ArtifactRevision[],
  input: {
    kind: ArtifactKind;
    commitSha: string;
    sourceStage: string;
    sourceRunId: string;
  },
): ArtifactRevision[] {
  if (!input.commitSha) return existing;
  const previous = lastOfKind(existing, input.kind);
  if (previous && previous.hash === input.commitSha) return existing;
  return [
    ...existing,
    {
      id: randomUUID(),
      kind: input.kind,
      hash: input.commitSha,
      sourceRunId: input.sourceRunId,
      sourceStage: input.sourceStage,
      parentRevision: previous?.id,
      registeredAt: new Date().toISOString(),
    },
  ];
}

/** Return the most recent revision of `kind`, or undefined. */
function lastOfKind(
  artifacts: ArtifactRevision[],
  kind: ArtifactKind,
): ArtifactRevision | undefined {
  for (let i = artifacts.length - 1; i >= 0; i -= 1) {
    if (artifacts[i].kind === kind) return artifacts[i];
  }
  return undefined;
}

/**
 * Walk the chain of revisions for a single kind and return them
 * in chronological order (oldest first). Used by recovery tools
 * and tests.
 */
export function revisionsOfKind(
  state: FactoryIssueState,
  kind: ArtifactKind,
): ArtifactRevision[] {
  const out: ArtifactRevision[] = [];
  const artifacts = state.artifacts ?? [];
  for (const a of artifacts) if (a.kind === kind) out.push(a);
  return out;
}
