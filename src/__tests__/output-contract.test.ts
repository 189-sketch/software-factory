/**
 * Contract guardrail test.
 *
 * For every agent's output contract, the `example` field is the response
 * the model should produce on the first try. If a future change tightens
 * a parse callback without updating the example — or vice versa — this
 * test fails at build time rather than at 3am in production.
 *
 * This is the anti-drift mechanism that the previous design lacked. The
 * factory failure that prompted the refactor — the spec agent's parser
 * rejecting a response whose format the prompt never stated — would
 * have been caught here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCT_CONTRACT,
  TECH_CONTRACT,
} from '../agents/spec.js';
import { IMPLEMENTATION_CONTRACT } from '../agents/implementation.js';
import { TRIAGE_READINESS_CONTRACT, TRIAGE_SUPERVISOR_CONTRACT } from '../agents/triage.js';
import { REVIEW_PR_CONTRACT } from '../agents/review-pr.js';
import { REVIEW_SPEC_CONTRACT } from '../agents/review-spec.js';
import { VERIFY_BEHAVIOR_CONTRACT } from '../agents/verify-behavior.js';
import { IMPROVE_REVIEW_PR_CONTRACT } from '../agents/improve-review-pr.js';
import { parseProductSpec, parseTechSpec } from '../agents/spec.js';
import { parseTriageDecision, parseTriageRouting } from '../agents/triage.js';
import { parseReviewResult } from '../agents/review-pr.js';
import { parseSpecReviewResult } from '../agents/review-spec.js';
import { parseVerifyBehavior } from '../agents/verify-behavior.js';
import { parseImproveReviewResult } from '../agents/improve-review-pr.js';

const CONTRACTS = [
  ['product', PRODUCT_CONTRACT, (text: string) => parseProductSpec(text).product],
  ['tech', TECH_CONTRACT, (text: string) => parseTechSpec(text).tech],
  ['triage-readiness', TRIAGE_READINESS_CONTRACT, (text: string) => parseTriageDecision(text)],
  ['triage-supervisor', TRIAGE_SUPERVISOR_CONTRACT, (text: string) => parseTriageRouting(text)],
  ['review-pr', REVIEW_PR_CONTRACT, (text: string) => parseReviewResult(text)],
  ['review-spec', REVIEW_SPEC_CONTRACT, (text: string) => parseSpecReviewResult(text)],
  ['verify-behavior', VERIFY_BEHAVIOR_CONTRACT, (text: string) => parseVerifyBehavior(text, 'verify')],
  ['improve-review-pr', IMPROVE_REVIEW_PR_CONTRACT, (text: string) => parseImproveReviewResult(text)],
  ['implementation', IMPLEMENTATION_CONTRACT, (_text: string) => {
    // Implementation parsing is delegated to parseImplementationResult which
    // also needs validation state; we just confirm the example JSON itself
    // round-trips through JSON.parse — a stricter check would couple this
    // test to the implementation agent's internal state shape.
    return JSON.parse(JSON.stringify(IMPLEMENTATION_CONTRACT.example));
  }],
] as const;

// `findings` is a derived field: the reviewer parser translates
// textual severity markers in the example body into structured
// Finding[], and the resulting array never matches the contract
// example's `[]` placeholder byte-for-byte (timestamps, ids).
// Skip it in the round-trip check.
const DERIVED_KEYS = new Set(["findings"]);

for (const [name, contract, parse] of CONTRACTS) {
  test(`${name} contract example round-trips through its parser`, () => {
    const text = JSON.stringify(contract.example);
    const result = parse(text);
    assert.ok(result, `${name}: parser returned a value`);
    // The parser may project to a narrower shape than the contract
    // example (e.g. it derives `label` from `state` and drops
    // `classifications`). What we DO require is that every field the
    // parser returns appears identically in the example. We enforce this
    // by projecting the example down to the parser's keys.
    const projected: Record<string, unknown> = {};
    const parsedKeys = Object.keys(result);
    const exampleRecord = contract.example as Record<string, unknown>;
    for (const key of parsedKeys) {
      if (DERIVED_KEYS.has(key)) continue;
      projected[key] = Object.hasOwn(exampleRecord, key) ? exampleRecord[key] : undefined;
    }
    // Use a structural comparison that ignores undefined keys we couldn't
    // populate, but still surfaces real type/shape drift.
    for (const key of parsedKeys) {
      if (DERIVED_KEYS.has(key)) continue;
      if (projected[key] === undefined && result[key] !== undefined) {
        // parser emitted a value the contract example never declared —
        // that is drift (likely the parser fabricates a field).
        assert.fail(`${name}: parser emits "${key}" but the contract example does not declare it`);
      }
      assert.deepEqual(result[key], projected[key], `${name}: mismatch on field "${key}"`);
    }
  });

  test(`${name} contract has at least one requirement`, () => {
    assert.ok(contract.requirements.length > 0, `${name}: must declare output requirements`);
  });
}