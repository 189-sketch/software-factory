/**
 * Failure classifier (M5): the deterministic categoriser that
 * runs before the supervisor LLM. The spec-review dead loop on
 * issue #29 (2026-09) was kept alive because the supervisor
 * repeatedly chose `retry spec` for the same root cause. The
 * per-(stage, FailureClass) counter + retry policy short-circuit
 * the loop the moment a class hits its budget.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyError, nextFailureAction, DEFAULT_FAILURE_POLICY } from "../core/failure-classifier.js";

test('command budget exhaustion is an execution environment failure, not agent reasoning', () => {
  const error = Object.assign(new Error('Validation command timed out'), { code: 'FACTORY_COMMAND_TIMEOUT' });
  assert.equal(classifyError(error).class, 'ENVIRONMENT');
  assert.match(classifyError(error).reason, /FACTORY_COMMAND_TIMEOUT_MS/);
});

test("classifies network errors as TRANSIENT", () => {
  const r = classifyError(new Error("schannel: failed to receive handshake, SSL/TLS connection failed"));
  assert.equal(r.class, "TRANSIENT");
  assert.equal(r.confident, true);
  assert.equal(r.maxAttempts, 3);
});

test("classifies SpecHashMismatchError as CONTRACT_VIOLATION", () => {
  const err = new Error("Spec product body does not match file (body sha256=abc, file sha256=def)");
  err.name = "SpecHashMismatchError";
  const r = classifyError(err);
  assert.equal(r.class, "CONTRACT_VIOLATION");
  assert.equal(r.maxAttempts, 2);
});

test("classifies policy refusals as POLICY_BLOCK (maxAttempts=0)", () => {
  const err = new Error("Command not allowed by assertSafeAgentCommand");
  const r = classifyError(err);
  assert.equal(r.class, "POLICY_BLOCK");
  assert.equal(r.maxAttempts, 0);
  assert.equal(r.defaultAction, "needs-info");
});

test("classifies exec errors as EXECUTOR_CRASH", () => {
  const r = classifyError(new Error("claude exited with code 1"));
  assert.equal(r.class, "EXECUTOR_CRASH");
});

test("classifies git lock as ENVIRONMENT", () => {
  const r = classifyError(new Error("fatal: Unable to create '.git/index.lock': File exists."));
  assert.equal(r.class, "ENVIRONMENT");
});

test("classifies JSON parse errors as AGENT_FORMAT_ERROR", () => {
  const r = classifyError(new Error("SyntaxError: Unexpected end of JSON input"));
  assert.equal(r.class, "AGENT_FORMAT_ERROR");
});

test("classifies ambiguous errors using the canonical AGENT_REASONING budget", () => {
  const r = classifyError(new Error("Spec review REJECTED: reviewer body had no findings block"));
  assert.equal(r.class, "AGENT_REASONING");
  assert.equal(r.confident, false);
  assert.equal(r.maxAttempts, DEFAULT_FAILURE_POLICY.AGENT_REASONING.maxAttempts);
});

test("nextFailureAction escalates after budget exhausted", () => {
  const state: { failureCounts?: Record<string, Record<string, number>> } = {};
  // P3: budget is 2 not 3. First retry routes to the supervisor.
  const a1 = nextFailureAction(state, "spec", "AGENT_REASONING");
  assert.equal(a1.action, "supervisor");
  assert.equal(a1.budgetLeft, 1);
  // Second attempt hits the budget → auto-escalate to needs-info.
  const a2 = nextFailureAction(state, "spec", "AGENT_REASONING");
  assert.equal(a2.action, "needs-info");
  assert.equal(a2.budgetLeft, 0);
});

test("nextFailureAction for POLICY_BLOCK goes straight to needs-info", () => {
  const state: { failureCounts?: Record<string, Record<string, number>> } = {};
  const a = nextFailureAction(state, "implementation", "POLICY_BLOCK");
  assert.equal(a.action, "needs-info");
});

test("nextFailureAction counts each (stage, class) independently", () => {
  const state: { failureCounts?: Record<string, Record<string, number>> } = {};
  // spec: 2 AGENT_REASONING — auto-escalates to needs-info
  nextFailureAction(state, "spec", "AGENT_REASONING");
  const a2 = nextFailureAction(state, "spec", "AGENT_REASONING");
  assert.equal(a2.action, "needs-info");
  // implementation: independent counter
  const impl = nextFailureAction(state, "implementation", "AGENT_REASONING");
  assert.equal(impl.budgetLeft, 1, "implementation counter not affected by spec counter");
});

test("DEFAULT_FAILURE_POLICY matches plan §3.6", () => {
  assert.equal(DEFAULT_FAILURE_POLICY.POLICY_BLOCK.maxAttempts, 0);
  assert.equal(DEFAULT_FAILURE_POLICY.PERMANENT.maxAttempts, 0);
  assert.equal(DEFAULT_FAILURE_POLICY.TRANSIENT.maxAttempts, 3);
  // P3: AGENT_REASONING budget tightened to 2 so the spec-review
  // dead loop escalates after 2 same-class retries instead of 3.
  assert.equal(DEFAULT_FAILURE_POLICY.AGENT_REASONING.maxAttempts, 2);
  assert.equal(DEFAULT_FAILURE_POLICY.AGENT_REASONING.defaultAction, "needs-info");
});
