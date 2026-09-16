/**
 * Contract tests for the implementation-parse self-heal pipeline.
 *
 * When the implementation agent's parser cannot turn the LLM's final
 * assistant text into a usable result, the orchestrator must
 * self-heal by re-routing the issue through triage instead of
 * halting the pipeline with "Task requires operator intervention".
 * The recovery contract is:
 *
 *   - on ImplementationParseError, clear implementation / review /
 *     attempts and route through triage;
 *   - bound the self-heals by MAX_PARSE_FAILURE_HEALS so a
 *     persistently confused LLM doesn't loop forever;
 *   - log the recovery via appendEvent so the trail is auditable;
 *   - surface other implementation errors as-is (they are real
 *     failures, not low-level noise).
 *
 * These tests pin the source-level contracts that downstream code
 * (orchestrator, control panel, daemon) rely on. If the recovery
 * path regresses, this test fails fast.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

test("implementation.ts exports an ImplementationParseError class", async () => {
  const source = await readFile(
    path.join(root, "src/agents/implementation.ts"),
    "utf8",
  );
  assert.ok(
    /export class ImplementationParseError/.test(source),
    "ImplementationParseError is no longer exported; the orchestrator cannot self-heal without it",
  );
});

test("implementation.ts parse path falls back to salvage instead of throwing", async () => {
  // The parse() callback must funnel through parseImplementationResult
  // and that function must produce a usable result when the LLM
  // returned prose instead of JSON.
  const source = await readFile(
    path.join(root, "src/agents/implementation.ts"),
    "utf8",
  );
  assert.ok(
    /parse:\s*\(text\)\s*=>\s*parseImplementationResult\(/.test(source),
    "implementation agent no longer routes the parser through parseImplementationResult",
  );
});

test("orchestrator catches ImplementationParseError specifically", async () => {
  // `instanceof ImplementationParseError` is the discriminator that
  // decides between self-heal (parse error) and rethrow (real impl
  // failure). A `message.includes(...)` check would be brittle.
  const source = await readFile(
    path.join(root, "src/orchestrator/index.ts"),
    "utf8",
  );
  assert.ok(
    /implError instanceof ImplementationParseError/.test(source),
    "orchestrator no longer narrows on ImplementationParseError type",
  );
});

test("orchestrator imports ImplementationParseError from implementation.js", async () => {
  const source = await readFile(
    path.join(root, "src/orchestrator/index.ts"),
    "utf8",
  );
  assert.ok(
    /import\s*\{[^}]*ImplementationParseError[^}]*\}\s*from\s*['"]\.\.\/agents\/implementation\.js['"]/.test(source),
    "ImplementationParseError is not imported into the orchestrator",
  );
});

test("orchestrator self-heal clears implementation state and routes through triage", async () => {
  // The self-heal block must (1) increment parseFailureHeals, (2)
  // bail out at MAX_PARSE_FAILURE_HEALS, (3) clear implementation
  // / review / attempts / nextLabel, (4) syncLabel(issue, null) so
  // the GH label is unstuck, (5) re-dispatch to triage by setting
  // label = null.
  const source = await readFile(
    path.join(root, "src/orchestrator/index.ts"),
    "utf8",
  );
  // Find the self-heal block — locate the `catch (implError)` line
  // and read until the next `continue;` inside the implementation
  // branch. A brittle regex is fine here because the contract IS the
  // exact sequence of statements.
  const healIdx = source.indexOf("} catch (implError) {");
  assert.ok(healIdx > 0, "self-heal catch block not found in orchestrator");
  // Read a generous slice to cover the whole block.
  const slice = source.slice(healIdx, healIdx + 4000);
  assert.ok(
    /parseFailureHeals\s*=/.test(slice),
    "self-heal does not increment parseFailureHeals",
  );
  assert.ok(
    /MAX_PARSE_FAILURE_HEALS/.test(slice),
    "self-heal does not bound by MAX_PARSE_FAILURE_HEALS",
  );
  assert.ok(
    /state\.implementation\s*=\s*undefined/.test(slice),
    "self-heal does not clear state.implementation",
  );
  assert.ok(
    /delete state\.review/.test(slice),
    "self-heal does not clear state.review",
  );
  assert.ok(
    /state\.attempts\s*=\s*0/.test(slice),
    "self-heal does not reset attempts to 0",
  );
  assert.ok(
    /state\.nextLabel\s*=\s*undefined/.test(slice),
    "self-heal does not clear state.nextLabel so triage re-runs",
  );
  assert.ok(
    /syncLabel\(issue,\s*null\)/.test(slice),
    "self-heal does not clear the GH label via syncLabel",
  );
  assert.ok(
    /label\s*=\s*null/.test(slice),
    "self-heal does not set label=null so the dispatcher re-routes to triage",
  );
  assert.ok(
    /appendEvent\(\s*state,\s*\{[\s\S]*?'self-healed'/.test(slice),
    "self-heal does not log a self-healed event for audit",
  );
});

test("FactoryIssueState carries parseFailureHeals counter", async () => {
  const types = await readFile(
    path.join(root, "src/core/types.ts"),
    "utf8",
  );
  assert.ok(
    /parseFailureHeals\?:\s*number/.test(types),
    "FactoryIssueState.parseFailureHeals is missing; orchestrator counter won't survive a checkpoint reload",
  );
});

test("MAX_PARSE_FAILURE_HEALS is exported with a sane default", async () => {
  const source = await readFile(
    path.join(root, "src/orchestrator/index.ts"),
    "utf8",
  );
  const match = source.match(/export const MAX_PARSE_FAILURE_HEALS\s*=\s*(\d+)/);
  assert.ok(match, "MAX_PARSE_FAILURE_HEALS is not exported");
  const value = Number(match[1]);
  assert.ok(value >= 1 && value <= 10, `MAX_PARSE_FAILURE_HEALS=${value} is outside the expected [1,10] range`);
});

test("orchestrator auto-heals stale pre-fix parse-failure checkpoints on load", async () => {
  // A checkpoint persisted as status=failed by a PRE-FIX version (error
  // = "implementation parse failed") must be auto-recovered on the next
  // run, so an operator never has to hand-edit the JSON. This pins both
  // the predicate and its wiring into runForIssue's load path.
  const source = await readFile(
    path.join(root, "src/orchestrator/index.ts"),
    "utf8",
  );
  assert.ok(
    /export function shouldSelfHealStaleParseFailure\(/.test(source),
    "shouldSelfHealStaleParseFailure is not exported",
  );
  assert.ok(
    /implementation parse failed/i.test(source),
    "stale-parse predicate does not match the 'implementation parse failed' error class",
  );
  // The predicate must be invoked in runForIssue BEFORE the
  // `status === 'failed'` rethrow, and its reset must clear status+error.
  const healIdx = source.indexOf("shouldSelfHealStaleParseFailure(state)");
  const rethrowIdx = source.indexOf("Task requires operator intervention");
  assert.ok(healIdx > 0, "runForIssue never calls shouldSelfHealStaleParseFailure");
  assert.ok(rethrowIdx > 0, "failed-state rethrow not found");
  assert.ok(
    healIdx < rethrowIdx,
    "stale-parse self-heal must run BEFORE the failed-state rethrow",
  );
});
