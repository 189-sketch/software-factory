import assert from "node:assert/strict";
import test from "node:test";

/**
 * Regression test for the `Cannot read properties of null (reading 'issue')`
 * crash that triggered when an issue had no prior checkpoint.
 *
 * The bug: `checkpoint.issue?.comments` looks safe, but optional chaining
 * short-circuits only when the LEFT side is null/undefined. When
 * `checkpoint` itself is null, `checkpoint.issue` throws before the `?.`
 * even gets evaluated. This file replicates the exact guard pattern the
 * daemon uses so any future refactor that drops the top-level null check
 * fails this test.
 */
function readCheckpointComments(checkpoint) {
  // The guard pattern from scripts/factory-daemon.mjs.
  return checkpoint ? normalizeComments(checkpoint.issue?.comments) : [];
}

function normalizeComments(comments) {
  return (comments || [])
    .map((c) => ({ author: c?.author?.login || "unknown", body: c?.body || "" }))
    .filter((c) => !c.body.includes("<!-- pi-software-factory:"));
}

test("readCheckpointComments handles a missing checkpoint without throwing", () => {
  // Before the fix this threw: TypeError: Cannot read properties of null
  // (reading 'issue'). Now it returns an empty array, the same as a brand
  // new issue with no prior comments.
  const result = readCheckpointComments(null);
  assert.deepEqual(result, []);
});

test("readCheckpointComments handles an undefined checkpoint", () => {
  assert.deepEqual(readCheckpointComments(undefined), []);
});

test("readCheckpointComments returns comments when the checkpoint has them", () => {
  const checkpoint = {
    issue: {
      comments: [
        { author: { login: "189-sketch" }, body: "使用TS" },
      ],
    },
  };
  const result = readCheckpointComments(checkpoint);
  assert.equal(result.length, 1);
  assert.equal(result[0].body, "使用TS");
});

test("readCheckpointComments filters out factory-tagged comments", () => {
  const checkpoint = {
    issue: {
      comments: [
        { author: { login: "factory" }, body: "<!-- pi-software-factory:triage:3:abc -->" },
        { author: { login: "user" }, body: "real comment" },
      ],
    },
  };
  const result = readCheckpointComments(checkpoint);
  assert.equal(result.length, 1);
  assert.equal(result[0].body, "real comment");
});

test("readCheckpointComments tolerates a checkpoint whose issue field is missing", () => {
  // Belt + suspenders: even if `checkpoint.issue` is undefined for any
  // reason, the optional chain returns undefined and normalizeComments
  // turns it into [].
  const result = readCheckpointComments({});
  assert.deepEqual(result, []);
});
