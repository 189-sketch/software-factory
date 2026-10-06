import assert from "node:assert/strict";
import test from "node:test";

import { isFactoryComment, latestVoiceIsAuthor } from "../core/factory-comments.js";

test("isFactoryComment flags every factory marker", () => {
  const samples = [
    { body: "<!-- pi-software-factory:triage:24:abc --> triage notes" },
    { body: "<!-- pi-software-factory:spec-review:24:def --> review notes" },
    { body: "<!-- pi-software-factory:pr-review:24:xyz --> review notes" },
    { body: "<!-- factory-state:v1:hash:payload --> recovery record" },
    { body: "<!-- factory-stage:started --> stage audit" },
    { body: "<!-- factory-resume:stage=spec attempt=2 --> resume point" },
    { body: "<!-- factory-ledger:id=operation status=unknown --> receipt" },
  ];
  for (const s of samples) {
    assert.equal(isFactoryComment(s), true, `expected factory: ${s.body.slice(0, 40)}`);
  }
});

test("isFactoryComment returns false for plain author replies and empty bodies", () => {
  assert.equal(isFactoryComment({ body: "no marker here, author voice" }), false);
  assert.equal(isFactoryComment({ body: "" }), false);
  assert.equal(isFactoryComment({}), false);
  assert.equal(isFactoryComment(null), false);
  assert.equal(isFactoryComment(undefined), false);
});

test("latestVoiceIsAuthor is true only when the LAST comment is non-factory", () => {
  // All author
  assert.equal(
    latestVoiceIsAuthor([{ body: "use TypeScript" }, { body: "thanks" }]),
    true,
  );
  // Last is factory
  assert.equal(
    latestVoiceIsAuthor([
      { body: "use TypeScript" },
      { body: "<!-- pi-software-factory:triage:1:hash --> waiting" },
    ]),
    false,
  );
  // Mixed but ends with author
  assert.equal(
    latestVoiceIsAuthor([
      { body: "<!-- pi-software-factory:spec-review:1:hash --> REJECT" },
      { body: "no existing model, design from scratch" },
    ]),
    true,
  );
  // Empty
  assert.equal(latestVoiceIsAuthor([]), false);
  assert.equal(latestVoiceIsAuthor(null), false);
  assert.equal(latestVoiceIsAuthor(undefined), false);
});

/**
 * Regression for issue #24: when the checkpoint already contains the
 * author's reply (saved on the previous poll) and no NEW comment has
 * arrived since, the orchestrator's JSON.stringify-equality returns
 * false and the issue stays parked at needs-info. The author-voice
 * check is supposed to override that: latestVoiceIsAuthor returns true
 * because the LAST entry is a non-factory comment. This test pins down
 * the signal the orchestrator now relies on.
 */
test("author-voice signal survives when the checkpoint already has the reply", () => {
  const checkpointComments = [
    { body: "<!-- pi-software-factory:spec-review:24:hash --> REJECT" },
    { body: "没有任何存在的模型，需要重新设计" }, // author reply, already in checkpoint
  ];
  // On the next poll we re-fetch and get the same array back.
  const freshComments = checkpointComments;
  assert.equal(JSON.stringify(checkpointComments) === JSON.stringify(freshComments), true);
  // But the author spoke last.
  assert.equal(latestVoiceIsAuthor(freshComments), true);
});

// Regression test for the helper's stability: the export surface must
// stay frozen so triage, spec, orchestrator, and the daemon all agree.
test("FACTORY_COMMENT_MARKERS is frozen and contains decision and recovery prefixes", async () => {
  const { FACTORY_COMMENT_MARKERS } = await import("../core/factory-comments.js");
  assert.equal(Object.isFrozen(FACTORY_COMMENT_MARKERS), true);
  assert.deepEqual(
    Array.from(FACTORY_COMMENT_MARKERS),
    [
      "<!-- pi-software-factory:triage:",
      "<!-- pi-software-factory:spec-review:",
      "<!-- pi-software-factory:pr-review:",
      "<!-- pi-software-factory:operator-wait:",
      "<!-- factory-state:v1:",
      "<!-- factory-state-chunk:v1:",
      "<!-- factory-stage:",
      "<!-- factory-resume:",
      "<!-- factory-ledger:",
    ],
  );
});
