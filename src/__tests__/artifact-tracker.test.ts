/**
 * Artifact tracker (M5): verify that the tracker records every
 * spec / review / implementation artifact with stable hashes and
 * chains parent revisions correctly. The tracker is the single
 * source of truth for what the checkpoint believes the spec said
 * (Recovery Walk §10.3).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  recordArtifact,
  recordSpecArtifacts,
  recordSpecReviewArtifact,
  recordImplementationArtifacts,
  revisionsOfKind,
} from "../core/artifact-tracker.js";
import { hashText } from "../core/artifact-hash.js";
import type { FactoryIssueState, SpecPair, SpecReviewResult, ImplementationResult, Issue, ArtifactRevision } from "../core/types.js";

function baseState(): FactoryIssueState {
  const issue: Issue = {
    number: 29,
    title: "看板",
    body: "",
    labels: [],
    author: "tester",
    url: "https://example.com/29",
    createdAt: "2026-09-17T00:00:00Z",
    comments: [],
  };
  return { issue, schemaVersion: 2, revision: 0, merged: false, agentMode: "llm" };
}

function pair(slug: string, productBody: string, techBody: string): SpecPair {
  return {
    product: { slug, title: "x", problem: "", goals: [], nonGoals: [], stories: [], acceptanceCriteria: [], openQuestions: [], body: productBody },
    tech:    { slug, approach: "", affectedAreas: [], dataModel: "", apiChanges: [], migrationPlan: "", validationPlan: [], alternatives: [], openQuestions: [], body: techBody },
    specBranch: `spec/${slug}`,
    specPrUrl: "",
  };
}

test("recordArtifact appends on new hash, no-op on same hash", () => {
  const state = baseState();
  const a1 = recordArtifact(state, { kind: "spec-product", body: "v1", path: "specs/x/PRODUCT.md", sourceStage: "spec", sourceRunId: "r1" });
  assert.equal(a1.length, 1);
  assert.equal(a1[0].hash, hashText("v1"));
  // Same body again — no-op, same array reference.
  const a2 = recordArtifact({ ...state, artifacts: a1 }, { kind: "spec-product", body: "v1", path: "specs/x/PRODUCT.md", sourceStage: "spec", sourceRunId: "r1" });
  assert.equal(a2.length, 1);
  assert.equal(a2, a1, "no-op should return the same array reference");
  // New body — append, chain parent.
  const a3 = recordArtifact({ ...state, artifacts: a1 }, { kind: "spec-product", body: "v2", path: "specs/x/PRODUCT.md", sourceStage: "spec", sourceRunId: "r2" });
  assert.equal(a3.length, 2);
  assert.equal(a3[1].parentRevision, a1[0].id);
  assert.equal(a3[1].hash, hashText("v2"));
});

test("recordSpecArtifacts writes both product and tech with paths", () => {
  const state = baseState();
  const spec = pair("issue-29-kanban", "product body", "tech body");
  const arts = recordSpecArtifacts(state, spec, "spec", "r1");
  const kinds = arts.map((a) => a.kind);
  assert.deepEqual(kinds, ["spec-product", "spec-tech"]);
  assert.equal(arts[0].path, "specs/issue-29-kanban/PRODUCT.md");
  assert.equal(arts[1].path, "specs/issue-29-kanban/TECH.md");
  assert.equal(arts[0].hash, hashText("product body"));
  assert.equal(arts[1].hash, hashText("tech body"));
});

test("recordSpecReviewArtifact is keyed on body, not verdict", () => {
  const state = baseState();
  const review: SpecReviewResult = { verdict: "REJECT", body: "- [CRITICAL] dup dir", comments: [], notes: "" };
  const a1 = recordSpecReviewArtifact(state, review, "review-spec", "rr1");
  const review2: SpecReviewResult = { verdict: "APPROVE", body: "- [CRITICAL] dup dir", comments: [], notes: "" };
  const a2 = recordSpecReviewArtifact({ ...state, artifacts: a1 }, review2, "review-spec", "rr2");
  // Same body → no-op even if verdict changed.
  assert.equal(a2.length, 1);
});

test("recordImplementationArtifacts chains commit SHAs", () => {
  const state = baseState();
  const impl: ImplementationResult = {
    issueNumber: 29, branch: "feature/29", commitSha: "aaaa111", prUrl: "https://x/1", prNumber: 1,
    filesChanged: [], validation: [], comment: "shipped",
  };
  const a1 = recordImplementationArtifacts(state, impl, "implementation", "i1");
  assert.equal(a1.length, 1);
  assert.equal(a1[0].hash, "aaaa111");
  // Same commit SHA → no-op.
  const a2 = recordImplementationArtifacts({ ...state, artifacts: a1 }, impl, "implementation", "i1");
  assert.equal(a2.length, 1);
  // New commit → new entry, parentRevision chained.
  const impl2: ImplementationResult = { ...impl, commitSha: "bbbb222", prNumber: 2 };
  const a3 = recordImplementationArtifacts({ ...state, artifacts: a1 }, impl2, "implementation", "i2");
  assert.equal(a3.length, 2);
  assert.equal(a3[1].parentRevision, a1[0].id);
});

test("revisionsOfKind returns chronological list of one kind", () => {
  const state = baseState();
  const spec = pair("issue-29-kanban", "v1", "v1");
  const a1 = recordSpecArtifacts(state, spec, "spec", "r1");
  const spec2 = pair("issue-29-kanban", "v2", "v2");
  const a2 = recordSpecArtifacts({ ...state, artifacts: a1 }, spec2, "spec", "r2");
  const products = revisionsOfKind({ ...state, artifacts: a2 }, "spec-product");
  assert.equal(products.length, 2);
  assert.equal(products[0].hash, hashText("v1"));
  assert.equal(products[1].hash, hashText("v2"));
  assert.equal(products[1].parentRevision, products[0].id);
});

test("parentRevision undefined for first revision of a kind", () => {
  const state = baseState();
  const arts = recordArtifact(state, { kind: "verify-evidence", body: "{}", sourceStage: "verify", sourceRunId: "v1" });
  assert.equal(arts[0].parentRevision, undefined);
});
