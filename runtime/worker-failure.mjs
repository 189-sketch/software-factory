import { createHash } from "node:crypto";

const STATE_OPERATIONS = new Set(['read', 'save', 'recover', 'history', 'lease-acquire', 'lease-read',
  'lease-release', 'sessions-read', 'external-recovery']);

function safeRequest(value) {
  if (!value || !['issue-comments', 'issue', 'git-ref', 'writer', 'github-api'].includes(value.resource)
    || !['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD'].includes(value.method)
    || !['headers', 'body', 'decode'].includes(value.phase)
    || Object.keys(value).some(key => !['resource', 'method', 'phase', 'attempt', 'elapsedMs', 'timeoutMs', 'status', 'page', 'perPage'].includes(key))
    || !Number.isSafeInteger(value.attempt) || value.attempt < 1
    || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0
    || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1
    || (value.status !== undefined && (!Number.isInteger(value.status) || value.status < 100 || value.status > 599))
    || [value.page, value.perPage].some(item => item !== undefined && (!Number.isSafeInteger(item) || item < 1))) return undefined;
  return { ...value };
}

/** Only the factory CLI issues this envelope; never classify agent prose as a runtime fault. */
export function workerFailure(error) {
  const causes = [];
  const seen = new Set();
  let current = error;
  let operation, request;
  while (current && !seen.has(current) && causes.length < 8) {
    seen.add(current);
    const code = typeof current.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(current.code)
      ? current.code : "UNCLASSIFIED";
    const name = typeof current.name === "string" ? current.name : typeof current;
    // Messages contribute to identity, but are never published or persisted here.
    causes.push({ code, name, message: String(current.message ?? current).slice(0, 2000) });
    if (!operation && STATE_OPERATIONS.has(current.stateOperation)) operation = current.stateOperation;
    if (!request) request = safeRequest(current.githubRequest);
    current = current.cause;
  }
  return {
    version: 1,
    owner: causes.some(cause => cause.code.startsWith("FACTORY_STATE_")) ? "state-runtime" : "worker-runtime",
    code: causes[0]?.code === "UNCLASSIFIED" ? "FACTORY_WORKER_UNCAUGHT" : causes[0]?.code ?? "FACTORY_WORKER_UNCAUGHT",
    fingerprint: createHash("sha256").update(JSON.stringify(causes)).digest("hex"),
    ...(operation ? { operation } : {}), ...(request ? { request } : {}),
  };
}

export function isWorkerFailure(value) {
  return value?.version === 1 && ["state-runtime", "worker-runtime"].includes(value.owner)
    && typeof value.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)
    && /^[a-f0-9]{64}$/.test(value.fingerprint ?? "")
    && (value.operation === undefined || STATE_OPERATIONS.has(value.operation))
    && (value.request === undefined || Boolean(safeRequest(value.request)));
}
