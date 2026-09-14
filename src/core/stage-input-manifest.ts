/**
 * Stage input manifest: the typed handoff contract between stages.
 *
 * ## Why this module exists
 *
 * Before M3 the only thing that survived a stage transition was the
 * typed result (`SpecPair`, `ImplementationResult`, etc.). The next
 * stage either re-derived everything from the worktree (slow) or
 * trusted the previous stage's summary (fragile). Issue #20's
 * review-spec loop fell into the second bucket: the second reviewer
 * saw the same PRODUCT/TECH twice but never the diff between them
 * and the prior review's REJECT, so it could not tell "what changed
 * since I last looked at this".
 *
 * M3 fixes that by giving every stage a `StageInputManifest` that
 * captures:
 *
 *   - the requirement version (so a rule change invalidates old
 *     reviews rather than letting them ride along);
 *   - the artifact revisions the next stage will read (hash + path +
 *     source run id, so a later stage can verify the file on disk is
 *     the one the previous stage wrote);
 *   - the open findings the previous stage left (so a reviewer knows
 *     what to re-check);
 *   - the rules the next stage must apply (by hash, so a stale cache
 *     cannot silently downgrade);
 *   - the completion criteria for the stage (machine-readable, not
 *     free-text in the system prompt).
 *
 * Persisted as part of the checkpoint's `events` log (each manifest
 * is one event with `kind: "stage-input-manifest"`), so a recovery
 * walk can reconstruct exactly what every stage saw.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

/** A reference to a specific artifact revision the next stage will read. */
export interface InputArtifactRef {
  /** Kind of artifact (e.g. `spec-product`, `spec-tech`, `implementation`). */
  kind: string;
  /** Content hash. SHA-256 hex for file bodies; commit SHA for VCS artifacts. */
  hash: string;
  /** Filesystem path when the artifact is a file. */
  path?: string;
  /** Source run id (matches `events[].runId` of the stage that produced it). */
  sourceRunId: string;
  /** Source stage name. */
  sourceStage: string;
}

/** A finding the next stage must address (open or dismissed-superseded). */
export interface InputFindingRef {
  findingId: string;
  ruleId: string;
  severity: "blocking" | "important" | "suggestion" | "nit";
  /** Affected requirement id (matches `RequirementBaseline.id`). */
  requirementId?: string;
  /** One-line summary. Full body lives in the parent checkpoint's `findings[]`. */
  summary: string;
}

/** A rule version the next stage must apply. */
export interface InputRuleRef {
  ruleId: string;
  /** SHA-256 of the rule body. Read against the on-disk skill to verify it
   * hasn't drifted between the manifest write and the stage run. */
  contentHash: string;
  /** Human-readable label (e.g. `severity-spec`). */
  label: string;
}

/** A previous decision the next stage should respect. */
export interface InputDecisionRef {
  decisionId: string;
  /** `accepted | dismissed | superseded` — superseded means a newer
   * decision replaced it; the next stage should treat the newer one
   * as the active rule. */
  status: "accepted" | "dismissed" | "superseded";
  /** One-line summary. */
  summary: string;
}

/**
 * The full input manifest handed to one stage.
 *
 * `requirementVersion` is a monotonically increasing id bumped on
 * every accepted requirement change. A manifest with an older
 * requirementVersion than a stage expects is invalid — the stage
 * must refuse and re-derive its inputs from the latest baseline.
 */
export interface StageInputManifest {
  manifestId: string;
  /** Stage the manifest is addressed to (`spec`, `implementation`, …). */
  stage: string;
  /** Issue number. */
  issueNumber: number;
  /** Source run id (which stage wrote this manifest). */
  sourceRunId: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Monotonic requirement version the stage must satisfy. */
  requirementVersion: number;
  /** Artifact revisions the stage must read. */
  artifacts: InputArtifactRef[];
  /** Open findings the stage must address. */
  findings: InputFindingRef[];
  /** Decisions the stage must respect. */
  decisions: InputDecisionRef[];
  /** Rule versions the stage must apply (skill content hashes). */
  rules: InputRuleRef[];
  /** Machine-readable completion criteria. Free-text descriptions go
   * in the rule prompt; these are the checks that can be evaluated
   * without an LLM. */
  completionCriteria: string[];
  /** Free-form note from the previous stage (truncated). */
  note?: string;
}

/** Compute the SHA-256 hex digest of a UTF-8 string. */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Compute the SHA-256 hex digest of a file on disk. */
export async function hashFile(absolutePath: string): Promise<string> {
  const buffer = await fs.readFile(absolutePath);
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Verify that the artifact on disk still matches the hash recorded in
 * the manifest. Returns `null` when the file is missing or unreadable
 * (the caller decides whether missing is fatal — usually it is, but
 * a recovery tool may want to fall through). Returns the on-disk
 * hash on success.
 *
 * The mismatch error message includes both hashes so the daemon log
 * can attribute the divergence to either a write-side bug or an
 * out-of-band edit without grepping two files.
 */
export async function verifyArtifact(ref: InputArtifactRef): Promise<
  { ok: true; onDiskHash: string } | { ok: false; reason: "missing" | "mismatch"; onDiskHash?: string }
> {
  if (!ref.path) return { ok: false, reason: "missing" };
  let onDisk: string;
  try {
    onDisk = await hashFile(ref.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: false, reason: "missing" };
    throw error;
  }
  if (onDisk !== ref.hash) return { ok: false, reason: "mismatch", onDiskHash: onDisk };
  return { ok: true, onDiskHash: onDisk };
}

/**
 * Pretty-print the manifest for the daemon log so an entry can answer
 * "what did the spec reviewer actually see?" without parsing JSON.
 * Kept short on purpose — full data is in the checkpoint event.
 */
export function summarizeManifest(manifest: StageInputManifest): string {
  return [
    `manifest=${manifest.manifestId}`,
    `stage=${manifest.stage}`,
    `req=${manifest.requirementVersion}`,
    `artifacts=${manifest.artifacts.length}`,
    `findings=${manifest.findings.length}`,
    `rules=${manifest.rules.length}`,
  ].join(" ");
}