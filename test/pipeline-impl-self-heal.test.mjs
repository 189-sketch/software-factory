/**
 * Implementation failures use the unified budget and deterministic router.
 * Legacy string-matching healing remains a no-op compatibility API.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_AGENT_FAILURES,
  shouldSelfHealImplAttemptLimit,
  shouldSelfHealStaleParseFailure,
  rerouteInvalidatedFields,
} from "../dist/factory/orchestrator.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("implementation parse failure still has a typed diagnostic", async () => {
  const source = await readFile(path.join(root, "src/agents/implementation.ts"), "utf8");
  assert.match(source, /export class ImplementationParseError/);
});

test("legacy healing predicates cannot bypass the unified failure policy", () => {
  assert.equal(shouldSelfHealImplAttemptLimit({ status: "failed", attempts: 99, error: "limit exceeded" }, 1), false);
  assert.equal(shouldSelfHealStaleParseFailure({ status: "failed", error: "implementation parse failed" }), false);
  assert.ok(Number.isSafeInteger(MAX_AGENT_FAILURES) && MAX_AGENT_FAILURES > 0);
});

test("implementation reroute preserves the prior attempt and invalidates review", () => {
  const invalidated = rerouteInvalidatedFields("implementation");
  assert.ok(!invalidated.includes("implementation"));
  assert.ok(invalidated.includes("review"));
  assert.ok(invalidated.includes("verifiedSha"));
});

test("all stage failures enter the unified handler", async () => {
  const source = await readFile(path.join(root, "src/orchestrator/index.ts"), "utf8");
  assert.match(source, /await this\.handleStageFailure\(state, issue, context, error as Error\)/);
  assert.match(source, /state\.agentFailures = \(state\.agentFailures \?\? 0\) \+ 1/);
  assert.match(source, /state\.agentFailures > this\.config\.limits\.agentFailures/);
  assert.match(source, /const classified = classifyError\(error\)/);
  assert.match(source, /const decision = nextFailureAction\(/);
  assert.match(source, /const routing = decideRouting\(/);
  assert.ok(!source.includes("MAX_PARSE_FAILURE_HEALS"));
});

test("failure routing persists corrections and the next dispatch label", async () => {
  const source = await readFile(path.join(root, "src/orchestrator/index.ts"), "utf8");
  const retry = source.slice(source.indexOf("if (routing.action === 'retry')"), source.indexOf("if (routing.action === 'reroute')"));
  assert.match(retry, /state\.correction =/);
  assert.match(retry, /setNextLabelForStage\(state, target\)/);
  assert.match(retry, /await this\.store\.save\(state\)/);
  assert.match(retry, /await syncLabel\(state, state\.nextLabel \?\? null, this\.config, this\.store\)/);
});
