/**
 * Observability helper tests (M6).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  OBSERV_KEYS,
  formatRecoveryLog,
  summarizeUsage,
  validateRecovery,
  withObsBindings,
} from "../core/observability.js";

function captureLogger() {
  const lines: Array<{ level: string; msg: string; bindings: Record<string, unknown> }> = [];
  return {
    info(msg: string, ...rest: unknown[]) {
      lines.push({ level: "info", msg, bindings: (rest[0] as Record<string, unknown>) ?? {} });
    },
    warn() {},
    error() {},
    child(b: Record<string, unknown>) {
      const merged = { ...lines.find(() => true)?.bindings, ...b };
      return captureLoggerWith(lines, merged);
    },
    lines,
  };
}

function captureLoggerWith(lines: Array<{ level: string; msg: string; bindings: Record<string, unknown> }>, baseBindings: Record<string, unknown>) {
  return {
    info(msg: string, ...rest: unknown[]) {
      lines.push({ level: "info", msg, bindings: { ...baseBindings, ...((rest[0] as Record<string, unknown>) ?? {}) } });
    },
    warn() {},
    error() {},
    child(b: Record<string, unknown>) {
      return captureLoggerWith(lines, { ...baseBindings, ...b });
    },
  };
}

test("OBSERV_KEYS freezes the canonical binding names", () => {
  assert.equal(Object.isFrozen(OBSERV_KEYS), true);
  for (const key of ["repository", "issue", "runId", "stage", "artifactId", "operationId", "eventType"]) {
    assert.equal(typeof OBSERV_KEYS[key as keyof typeof OBSERV_KEYS], "string");
  }
});

test("withObsBindings drops undefined / null values and passes through others", () => {
  const captured = captureLogger();
  const child = withObsBindings(captured, {
    issueNumber: 7,
    runId: "r-1",
    stage: undefined,
    repository: null,
    eventType: "stage-start",
  });
  child.info("hi", { foo: 1 });
  assert.equal(captured.lines.length, 1);
  assert.equal(captured.lines[0]?.bindings.issueNumber, 7);
  assert.equal(captured.lines[0]?.bindings.runId, "r-1");
  assert.equal(captured.lines[0]?.bindings.stage, undefined, "undefined bindings are dropped");
  assert.equal(captured.lines[0]?.bindings.repository, undefined, "null bindings are dropped");
  assert.equal(captured.lines[0]?.bindings.eventType, "stage-start");
});

test("withObsBindings returns the original logger when no bindings survive filtering", () => {
  const captured = captureLogger();
  const child = withObsBindings(captured, { stage: undefined, repository: null });
  assert.equal(child, captured, "empty bindings must NOT wrap the logger");
});

test("summarizeUsage marks every field 'unavailable' when the upstream gave nothing", () => {
  const s = summarizeUsage(undefined);
  assert.equal(s.available, false);
  assert.equal(s.input, "unavailable");
  assert.equal(s.output, "unavailable");
  assert.equal(s.total, "unavailable");
});

test("summarizeUsage flags available=true when at least one field is numeric", () => {
  const s = summarizeUsage({ output: 42 });
  assert.equal(s.available, true);
  assert.equal(s.output, 42);
  assert.equal(s.input, "unavailable");
});

test("summarizeUsage ignores NaN and Infinity (zero-cost reads are forbidden)", () => {
  const s = summarizeUsage({ input: NaN, output: Infinity, totalTokens: null });
  assert.equal(s.input, "unavailable");
  assert.equal(s.output, "unavailable");
  assert.equal(s.total, "unavailable", "null total must surface as missing, not as zero");
});

test("validateRecovery accepts a succeeded record that carries receiptPath", () => {
  const problems = validateRecovery({
    kind: "lease-reclaim",
    issueNumber: 7,
    plan: "delete stale ref and retry",
    outcome: "succeeded",
    receiptPath: "<stateDir>/receipts/issue-7-lease-release.json",
  });
  assert.deepEqual(problems, []);
});

test("validateRecovery REJECTS a succeeded record without evidence (M6 item 4)", () => {
  const problems = validateRecovery({
    kind: "self-heal",
    issueNumber: 7,
    plan: "retry",
    outcome: "succeeded",
  });
  assert.ok(
    problems.some((p) => p.includes("receiptPath") && p.includes("verification")),
    `expected evidence requirement error, got ${JSON.stringify(problems)}`,
  );
});

test("validateRecovery allows 'unknown' outcome without evidence", () => {
  assert.deepEqual(validateRecovery({
    kind: "self-heal",
    issueNumber: 7,
    plan: "retry",
    outcome: "unknown",
  }), []);
});

test("formatRecoveryLog returns a structured payload including the validation problems", () => {
  const payload = formatRecoveryLog({
    kind: "self-heal",
    issueNumber: 7,
    plan: "retry",
    outcome: "succeeded",
  });
  assert.equal(payload.outcome, "succeeded");
  assert.equal(payload.issue, 7);
  assert.ok(Array.isArray(payload.problems));
  assert.ok(
    (payload.problems as string[]).some((p) => p.includes("receiptPath") && p.includes("verification")),
    `expected evidence requirement error in payload.problems`,
  );
});