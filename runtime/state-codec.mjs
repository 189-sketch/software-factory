import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

export const STATE_MARKER = "<!-- factory-state:v1:";
export const STATE_CHUNK_MARKER = "<!-- factory-state-chunk:v1:";
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
  "lastSpecVerdict", "lastJudgmentHash", "lastTriageAt", "verificationRecovery",
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
  if (Buffer.byteLength(body) <= MAX_COMMENT_BYTES) return { hash, body, envelope };
  // Publish fragments first, then the hash-linked commit marker. A partial
  // upload is not a recovery revision and cannot supersede its parent.
  const payloads = packed.match(/.{1,54000}/g);
  const chunks = payloads.map((payload, index) => `${STATE_CHUNK_MARKER}${hash}:${index + 1}:${payloads.length}:${payload} -->`);
  return { hash, envelope, chunks,
    body: `Factory recovery record v1, revision ${envelope.revision}.\n\n${STATE_MARKER}${hash}:chunks:${chunks.length} -->` };
}

/** A checksum detects corruption, not authorship; callers MUST provide trusted writers. */
export function decodeStateComment(comment, { repository, issueNumber, writers, comments = [] }) {
  if (!writers?.includes(comment?.author) || !comment?.body?.includes(STATE_MARKER)) return null;
  if (Buffer.byteLength(comment.body) > MAX_COMMENT_BYTES) throw new Error("Factory state comment exceeds size budget");
  const match = comment.body.match(/^<!-- factory-state:v1:([a-f0-9]{64}):([A-Za-z0-9+/=]+) -->$/m);
  const fragmented = comment.body.match(/^<!-- factory-state:v1:([a-f0-9]{64}):chunks:([0-9]+) -->$/m);
  if (!match && !fragmented) throw new Error("Malformed trusted factory state marker");
  const hash = (match ?? fragmented)[1];
  let packed = match?.[2];
  if (fragmented) {
    const count = Number(fragmented[2]);
    if (!Number.isSafeInteger(count) || count < 2 || count > 16) throw new Error("Invalid factory state fragment count");
    const fragments = new Map();
    for (const row of comments) {
      if (!writers.includes(row.author) || !row.body?.includes(`${STATE_CHUNK_MARKER}${hash}:`)) continue;
      if (Buffer.byteLength(row.body) > MAX_COMMENT_BYTES) throw new Error("Factory state fragment exceeds size budget");
      const fragment = row.body.match(/^<!-- factory-state-chunk:v1:([a-f0-9]{64}):([0-9]+):([0-9]+):([A-Za-z0-9+/=]+) -->$/m);
      const index = Number(fragment?.[2]);
      if (!fragment || Number(fragment[3]) !== count || index < 1 || index > count) throw new Error("Malformed trusted factory state fragment");
      if (fragments.has(index) && fragments.get(index) !== fragment[4]) throw new Error("Factory state fragment conflict");
      fragments.set(index, fragment[4]);
    }
    if (fragments.size !== count) throw new Error("Committed factory state is missing trusted fragments");
    packed = Array.from({ length: count }, (_, index) => fragments.get(index + 1)).join('');
    if (packed.length > MAX_STATE_BYTES * 2) throw new Error("Factory state fragments exceed packed size budget");
  }
  const bytes = inflateSync(Buffer.from(packed, "base64"), { maxOutputLength: MAX_STATE_BYTES });
  if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("Factory state checksum mismatch");
  const envelope = JSON.parse(bytes.toString("utf8"));
  validateEnvelope(envelope);
  if (envelope.repository !== repository || envelope.issueNumber !== issueNumber) {
    throw new Error("Factory state repository or issue mismatch");
  }
  return { hash, envelope, commentId: comment.id };
}

/** Reject forks, missing parents, and malformed records rather than guessing a resume point. */
export function stateRecordHistory(comments, options) {
  const records = comments.map((comment) => decodeStateComment(comment, { ...options, comments }))
    .filter(Boolean).sort((a, b) => a.envelope.revision - b.envelope.revision);
  let latest = null;
  const history = [];
  for (const record of records) {
    if (record.hash === latest?.hash) continue; // POST response-loss duplicate
    if (record.envelope.revision !== (latest?.envelope.revision ?? 0) + 1
        || record.envelope.parentHash !== (latest?.hash ?? null)) {
      throw new Error("Factory state revision conflict or missing parent; operator reconciliation required");
    }
    latest = record;
    history.push(record);
  }
  return history;
}

export function latestStateRecord(comments, options) {
  return stateRecordHistory(comments, options).at(-1) ?? null;
}
