/**
 * Spec `2026-09-20-decision-architecture` follow-up / issue-#36 regression.
 *
 * The triage agent's Claude Code CLI session is `--resume`'d on every
 * poll (M6 incremental principle). On a resumed run, re-sending the
 * full evidence block burns tokens — prior replies, body, and prior
 * triage decision are already in the CLI's session memory and the
 * model can read them back. The fix exposes `buildTriageEvidenceBlock`
 * so this contract is pinned by tests:
 *
 *   - cold start (no `lastTriageAt`, no `sessionResumed`): the full
 *     block is sent — author replies, spec-review questions, and
 *     other factory comments all appear.
 *   - resumed run with `lastTriageAt` between comments: only NEW
 *     author replies (createdAt > lastTriageAt) appear; the "in your
 *     conversation memory" hint tells the model the rest is intact.
 *   - resumed run where every author reply is already new: the
 *     incremental shape is used only when filtering actually shrinks
 *     the block — otherwise fall back to the full block.
 *
 * These cases are the M6 incremental contract: prior replies never
 * leak into the new turn's user message on a resumed session.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildTriageEvidenceBlock } from "../agents/triage.js";
import type { Issue } from "../core/types.js";

function fixtureIssue(): Issue {
    return {
        number: 7,
        title: "Make the nav respond to arrow keys",
        body: "Add ←/→ shortcuts to switch kanban columns.",
        labels: ["needs-info"],
        author: "alice",
        url: "https://example.com/7",
        createdAt: "2026-09-19T10:00:00Z",
        comments: [
            {
                author: "alice",
                body: "Use whatever library you like.",
                createdAt: "2026-09-20T01:00:00Z",
            },
            {
                author: "factory",
                body: "<!-- pi-software-factory:triage:ready-to-spec -->\nNoted.",
                createdAt: "2026-09-20T01:05:00Z",
            },
            {
                author: "alice",
                body: "Prefer no new dependencies if possible.",
                createdAt: "2026-09-20T08:00:00Z",
            },
            {
                author: "alice",
                body: "Actually, react-aria is fine.",
                createdAt: "2026-09-20T11:30:00Z",
            },
        ],
    };
}

test("cold start: full evidence block with all author replies", () => {
    const issue = fixtureIssue();
    const block = buildTriageEvidenceBlock(issue, undefined, false);
    // Issue body always present
    assert.match(block, /Issue #7 — Make the nav respond to arrow keys/);
    assert.match(block, /Body: Add [\s\S]+ shortcuts/);
    // All three author replies present
    assert.match(block, /Use whatever library you like\./);
    assert.match(block, /Prefer no new dependencies if possible\./);
    assert.match(block, /Actually, react-aria is fine\./);
    // Factory / "Other" sections present on cold start
    assert.match(block, /Latest spec-review questions raised/);
});

test("resumed run with lastTriageAt between comments: only NEW author replies", () => {
    const issue = fixtureIssue();
    // Triage last ran at 09:00 — the 11:30 reply is the only NEW one.
    const block = buildTriageEvidenceBlock(
        issue,
        "2026-09-20T09:00:00Z",
        true,
    );
    // The newest author reply IS present (it is the only delta).
    assert.match(block, /Actually, react-aria is fine\./);
    // The two older author replies are NOT present in the incremental
    // shape — they live in the resumed session's memory.
    assert.doesNotMatch(block, /Use whatever library you like\./);
    assert.doesNotMatch(block, /Prefer no new dependencies if possible\./);
    // The hint that tells the model where to find prior replies.
    assert.match(block, /prior replies are in your conversation memory/);
    assert.match(block, /1 of 3 total/);
});

test("resumed run with lastTriageAt before all comments: every author reply is new → fall back to full block", () => {
    // The incremental shape advertises "X of Y total; prior replies
    // are in your conversation memory" — when every reply IS new
    // there are no prior replies to hide, and the "in memory"
    // framing misleads the model. `buildTriageEvidenceBlock`
    // detects this (newAuthorComments.length === authorComments.length)
    // and falls back to the canonical full shape.
    const issue = fixtureIssue();
    const block = buildTriageEvidenceBlock(
        issue,
        "2026-01-01T00:00:00Z",
        true,
    );
    assert.match(block, /Use whatever library you like\./);
    assert.match(block, /Prefer no new dependencies if possible\./);
    assert.match(block, /Actually, react-aria is fine\./);
    // Full shape — no "in your conversation memory" hint.
    assert.match(block, /Author replies \(3 — binding decisions\)/);
    assert.doesNotMatch(block, /prior replies are in your conversation memory/);
});

test("resumed run with no NEW replies (all comments older than lastTriageAt): incremental shape with 0-new-author note", () => {
    const issue = fixtureIssue();
    // lastTriageAt in the future of every comment: zero new author replies.
    // isIncremental is still true because newAuthorComments.length < authorComments.length.
    const block = buildTriageEvidenceBlock(
        issue,
        "2026-12-31T00:00:00Z",
        true,
    );
    assert.match(block, /no new author replies/);
    assert.match(block, /0 of 3 total/);
});

test("resumed run with lastTriageAt equal to a comment's createdAt → that comment is NOT new (strict >)", () => {
    const issue = fixtureIssue();
    // Use the 08:00 reply's exact createdAt: a reply at exactly that
    // timestamp is NOT strictly newer, so it stays in memory.
    const block = buildTriageEvidenceBlock(
        issue,
        "2026-09-20T08:00:00Z",
        true,
    );
    assert.match(block, /Actually, react-aria is fine\./);
    assert.doesNotMatch(block, /Use whatever library you like\./);
    assert.doesNotMatch(block, /Prefer no new dependencies if possible\./);
});

test("cold-start shape is used when session is NOT resumed, even if lastTriageAt is set", () => {
    // sessionResumed=false simulates a CLI that declined --resume (or
    // a fresh state). The full block must be sent so the cold CLI has
    // enough context to re-orient.
    const issue = fixtureIssue();
    const block = buildTriageEvidenceBlock(
        issue,
        "2026-09-20T09:00:00Z",
        false,
    );
    assert.match(block, /Use whatever library you like\./);
    assert.match(block, /Prefer no new dependencies if possible\./);
    assert.match(block, /Actually, react-aria is fine\./);
});

test("cold-start shape is used when newAuthorComments equals authorComments (filtering would not shrink)", () => {
    // lastTriageAt before every comment → every author reply is "new",
    // newAuthorComments.length === authorComments.length → fall back
    // to the full block shape (no value in filtering).
    const issue = fixtureIssue();
    const block = buildTriageEvidenceBlock(
        issue,
        "1970-01-01T00:00:00Z",
        true,
    );
    // Full shape: has "Author replies (N — binding decisions):" header,
    // NOT the incremental "Author replies NEW since last triage".
    assert.match(block, /Author replies \(3 — binding decisions\)/);
    assert.doesNotMatch(block, /prior replies are in your conversation memory/);
});
