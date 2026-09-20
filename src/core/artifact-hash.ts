/**
 * Spec plan §3.5 / M3 verification: "文件与模型摘要不一致时明确失败".
 *
 * Before M3 the spec agent wrote PRODUCT.md / TECH.md to disk, returned
 * the same bodies in its JSON result, and the orchestrator committed
 * whichever copy happened to be on disk last. If the model and the tool
 * diverged (partial write, filesystem cache, agent editing one without
 * updating the other), nobody noticed until a reviewer complained that
 * "the spec I approved is not the spec that got implemented".
 *
 * This module is the single source of truth for hashing spec artifacts:
 *
 * - `hashText(s)` and `hashFile(p)` produce a stable sha-256 fingerprint.
 * - `assertSpecFilesMatchBodies(result, workdir)` reads PRODUCT.md /
 *   TECH.md from disk and verifies each matches the `body` field in the
 *   LLM-authored result. A mismatch throws `SpecHashMismatchError`, which
 *   the orchestrator treats as an `invalid-agent-output` retry (plan
 *   §3.6): one directed repair pass; on the second failure the run is
 *   preserved with the original output and surfaced to triage.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Stable sha-256 of an in-memory string. */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stable sha-256 of a file on disk. Missing files hash to the sha-256
 * of the empty string so callers can compare a body hash and a file
 * hash without special-casing ENOENT. */
export async function hashFile(filePath: string): Promise<string> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return hashText("");
    throw error;
  }
  return hashText(content);
}

/**
 * Subset of the spec result we verify. The product body and tech body
 * are the two surfaces that must agree with the corresponding files
 * on disk; the slug drives the path so it must match what the agent
 * actually wrote.
 */
export interface SpecBodiesForVerification {
  product: { body: string; slug: string };
  tech: { body: string; slug: string };
}

/**
 * Thrown when the JSON `body` returned by the spec agent does not match
 * the file the orchestrator is about to commit. Carries both digests so
 * the operator can diff the two without re-reading the worktree.
 */
export class SpecHashMismatchError extends Error {
  readonly code = "SPEC_HASH_MISMATCH";
  constructor(
    readonly document: "product" | "tech",
    readonly filePath: string,
    readonly bodyHash: string,
    readonly fileHash: string,
  ) {
    super(
      `Spec ${document} body does not match ${filePath} ` +
        `(body sha256=${bodyHash.slice(0, 12)}, file sha256=${fileHash.slice(0, 12)})`,
    );
    this.name = "SpecHashMismatchError";
  }
}

/**
 * Verify PRODUCT.md and TECH.md on disk match the bodies in `result`.
 * Throws `SpecHashMismatchError` on the first divergence. Used after
 * `SpecAgent.run()` returns and before the orchestrator commits the
 * worktree, so a partial write or a deliberate tamper attempt surfaces
 * immediately.
 */
export async function assertSpecFilesMatchBodies(
  result: SpecBodiesForVerification,
  workdir: string,
): Promise<void> {
  const slug = result.product.slug;
  if (!slug || slug !== result.tech.slug) {
    throw new Error(
      `Spec slug must match between product and tech halves (got ${JSON.stringify({
        product: result.product.slug,
        tech: result.tech.slug,
      })})`,
    );
  }
  const productPath = path.join(workdir, "specs", slug, "PRODUCT.md");
  const techPath = path.join(workdir, "specs", slug, "TECH.md");
  const productBodyHash = hashText(result.product.body);
  const productFileHash = await hashFile(productPath);
  if (productBodyHash !== productFileHash) {
    throw new SpecHashMismatchError("product", productPath, productBodyHash, productFileHash);
  }
  const techBodyHash = hashText(result.tech.body);
  const techFileHash = await hashFile(techPath);
  if (techBodyHash !== techFileHash) {
    throw new SpecHashMismatchError("tech", techPath, techBodyHash, techFileHash);
  }
}