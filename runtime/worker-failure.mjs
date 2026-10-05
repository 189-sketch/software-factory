import { createHash } from "node:crypto";

/** Only the factory CLI issues this envelope; never classify agent prose as a runtime fault. */
export function workerFailure(error) {
  const causes = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current) && causes.length < 8) {
    seen.add(current);
    const code = typeof current.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(current.code)
      ? current.code : "UNCLASSIFIED";
    const name = typeof current.name === "string" ? current.name : typeof current;
    // Messages contribute to identity, but are never published or persisted here.
    causes.push({ code, name, message: String(current.message ?? current).slice(0, 2000) });
    current = current.cause;
  }
  return {
    version: 1,
    owner: causes.some(cause => cause.code.startsWith("FACTORY_STATE_")) ? "state-runtime" : "worker-runtime",
    code: causes[0]?.code === "UNCLASSIFIED" ? "FACTORY_WORKER_UNCAUGHT" : causes[0]?.code ?? "FACTORY_WORKER_UNCAUGHT",
    fingerprint: createHash("sha256").update(JSON.stringify(causes)).digest("hex"),
  };
}

export function isWorkerFailure(value) {
  return value?.version === 1 && ["state-runtime", "worker-runtime"].includes(value.owner)
    && typeof value.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)
    && /^[a-f0-9]{64}$/.test(value.fingerprint ?? "");
}
