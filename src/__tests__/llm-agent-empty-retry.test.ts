import test from "node:test";
import assert from "node:assert/strict";
import { isEmptyResponseError } from "../core/llm-agent.js";

/**
 * Regression coverage for the one-shot retry that protects `driveEngine`
 * against transient empty responses (observed on MiniMax-M3: the
 * endpoint returns 200 with an empty body, pi-agent-core resolves the
 * lane prompt as ok=true, no assistant entry is written, and the caller
 * used to fail with "LLM returned no assistant text").
 *
 * These tests pin the regex the harness error message must match so a
 * copy-paste edit on either side can't silently break the retry.
 */

test("isEmptyResponseError matches the harness 'settled without producing any entry' error", () => {
    assert.equal(
        isEmptyResponseError(new Error("harness lane settled without producing any entry (model returned empty response); status=completed tipId=null")),
        true,
    );
});

test("isEmptyResponseError matches the legacy 'returned empty response' phrasing", () => {
    assert.equal(isEmptyResponseError(new Error("model returned empty response")), true);
});

test("isEmptyResponseError rejects unrelated harness failures", () => {
    assert.equal(isEmptyResponseError(new Error("harness lane run failed: Closed")), false);
    assert.equal(isEmptyResponseError(new Error("harness lane run failed: UnknownSkill")), false);
});

test("isEmptyResponseError tolerates non-Error inputs", () => {
    assert.equal(isEmptyResponseError("settled without producing any entry"), true);
    assert.equal(isEmptyResponseError(undefined), false);
    assert.equal(isEmptyResponseError(null), false);
});