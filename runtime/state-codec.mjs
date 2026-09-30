import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

export const STATE_MARKER = "<!-- factory-state:v1:";
const MAX_STATE_BYTES = 512 * 1024;
const MAX_COMMENT_BYTES = 60_000;
const HASH = /^[a-f0-9]{64}$/;
const STATE_FIELDS = new Set([
  "schemaVersion", "revision", "triage", "specs", "specReview", "implementation",
  "review", "merged", "agentMode", "labelPending", "reviewedSha", "verifiedSha",
  "reviewedBaseSha", "specReviewedKey", "nextLabel", "status", "wait", "attempts",
  "specAttempts", "agentFailures", "correction", "specLoopVersion", "error",
  "stages", "events", "artifacts", "externalOps", "pendingSteps", "openQuestions",
  "failureCounts", "lastFailure", "specTypesafeRevisions", "specRubricFailures",
  "lastSpecVerdict", "lastJudgmentHash", "lastTriageAt",
]);
const PRIVATE_KEYS = new Set([
  "providerSessions", "providerSessionId", "resumeSessionId", "lastProviderSessionId",
  "apiKey", "accessToken", "authorization", "token",
]);

function publicValue(value) {
  if (typeof value === "string") {
    return value.replace(/\b(?:gh[pousr]_[a-zA-Z0-9]+|github_pat_[a-zA-Z0-9_]+|sk-ant-[a-zA-Z0-9_-]+)\b/g, "[REDACTED]")
      .replace(/Bearer\s+[a-zA-Z0-9._~+\/-]+/gi, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !PRIVATE_KEYS.has(key))
      .map(([key, entry]) => [key, publicValue(entry)]));
  }
  return value;
}

/** Runtime progress is public; credentials, sessions, and issue-thread copies are not. */
export function publicSnapshot(state) {
  const snapshot = { issue: { number: state.issue?.number } };
  for (const [key, value] of Object.entries(state)) {
    if (STATE_FIELDS.has(key)) snapshot[key] = publicValue(value);
  }
  return snapshot;
}

function validateEnvelope(envelope) {
  if (!envelope || envelope.version !== 1
      || typeof envelope.repository !== "string" || !/^[^/]+\/[^/]+$/.test(envelope.repository)
      || !Number.isSafeInteger(envelope.issueNumber) || envelope.issueNumber < 1
      || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1
      || (envelope.parentHash !== null && !HASH.test(envelope.parentHash ?? ""))
      || (envelope.revision === 1 && envelope.parentHash !== null)
      || (envelope.revision > 1 && envelope.parentHash === null)
      || envelope.snapshot?.issue?.number !== envelope.issueNumber
      || envelope.snapshot?.revision !== envelope.revision) {
    throw new Error("Invalid factory state envelope");
  }
  if (JSON.stringify(publicSnapshot(envelope.snapshot)) !== JSON.stringify(envelope.snapshot)) {
    throw new Error("Factory state contains private or unsupported fields");
  }
}

export function encodeState(envelope) {
  validateEnvelope(envelope);
  const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
  if (bytes.length > MAX_STATE_BYTES) throw new Error("Factory recovery state exceeds the decoded size budget");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const packed = deflateSync(bytes).toString("base64");
  const marker = STATE_MARKER + hash + ":" + packed + " -->";
  const body = "Factory recovery record v1, revision " + envelope.revision + ".\n\n" + marker;
  if (Buffer.byteLength(body) > MAX_COMMENT_BYTES) throw new Error("Factory recovery state exceeds the comment size budget");
  return { hash, body, envelope };
}

/** A checksum detects corruption, not authorship; callers MUST provide trusted writers. */
export function decodeStateComment(comment, { repository, issueNumber, writers }) {
  if (!writers?.includes(comment?.author) || !comment?.body?.includes(STATE_MARKER)) return null;
  if (Buffer.byteLength(comment.body) > MAX_COMMENT_BYTES) throw new Error("Factory state comment exceeds size budget");
  const match = comment.body.match(/^<!-- factory-state:v1:([a-f0-9]{64}):([A-Za-z0-9+/=]+) -->$/m);
  if (!match) throw new Error("Malformed trusted factory state marker");
  const bytes = inflateSync(Buffer.from(match[2], "base64"), { maxOutputLength: MAX_STATE_BYTES });
  if (createHash("sha256").update(bytes).digest("hex") !== match[1]) throw new Error("Factory state checksum mismatch");
  const envelope = JSON.parse(bytes.toString("utf8"));
  validateEnvelope(envelope);
  if (envelope.repository !== repository || envelope.issueNumber !== issueNumber) {
    throw new Error("Factory state repository or issue mismatch");
  }
  return { hash: match[1], envelope, commentId: comment.id };
}

/** Reject forks, missing parents, and malformed records rather than guessing a resume point. */
export function latestStateRecord(comments, options) {
  const records = comments.map((comment) => decodeStateComment(comment, options))
    .filter(Boolean).sort((a, b) => a.envelope.revision - b.envelope.revision);
  let latest = null;
  for (const record of records) {
    if (record.hash === latest?.hash) continue; // POST response-loss duplicate
    if (record.envelope.revision !== (latest?.envelope.revision ?? 0) + 1
        || record.envelope.parentHash !== (latest?.hash ?? null)) {
      throw new Error("Factory state revision conflict or missing parent; operator reconciliation required");
    }
    latest = record;
  }
  return latest;
}
