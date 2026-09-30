import test from "node:test";
import assert from "node:assert/strict";
import { businessInputHash, FACTORY_COMMENT_MARKERS } from "../runtime/business-input.mjs";

const issue = {
  number: 48, title: "Implement login", body: "Check the real browser flow.",
  labels: ["ready-to-implement", "bug"],
  comments: [{ author: "operator", body: "Use password login", createdAt: "2026-09-30T00:00:00Z" }],
};

test("factory comments and issue timestamps cannot trigger the business hash", () => {
  for (const marker of FACTORY_COMMENT_MARKERS) {
    assert.equal(businessInputHash({ ...issue, updatedAt: "new timestamp", comments: [
      ...issue.comments, { author: "shared-account", body: `${marker} example -->`, createdAt: "later" },
    ] }), businessInputHash(issue));
  }
});

test("title, body, human comment edits and deletions, labels, and closed status trigger freshness", () => {
  for (const patch of [
    { title: "New title" }, { body: "New acceptance criteria" }, { state: "closed" },
    { comments: [{ ...issue.comments[0], body: "Use passkeys instead" }] },
    { comments: [] }, { labels: ["needs-info"] },
  ]) assert.notEqual(businessInputHash({ ...issue, ...patch }), businessInputHash(issue));
});

test("label ordering and duplicate labels are not business changes", () => {
  assert.equal(businessInputHash({ ...issue, labels: ["bug", "ready-to-implement", "bug"] }), businessInputHash(issue));
  assert.equal(businessInputHash({ ...issue, labels: issue.labels.map((name) => ({ name })) }), businessInputHash(issue));
});
