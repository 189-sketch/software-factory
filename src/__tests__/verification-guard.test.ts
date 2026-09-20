/**
 * Verification Guard (M5) — plan §29. The guard must catch the
 * standard "agent cheated" patterns so they can never reach
 * `mergePullRequest`. Each rule is covered by at least one test
 * so a future change to the rule set has to update the suite.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  runVerificationGuard,
  isBlocked,
  groupByRule,
  type DiffLine,
  type DiffPath,
} from "../core/verification-guard.js";

test("catches test.skip / it.skip / xit", () => {
  const findings = runVerificationGuard(
    [
      { path: "src/foo.test.ts", sign: "+", line: 1, text: "  it.skip('does not work', () => {});" },
    ],
    [],
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, "test-skip-method");
  assert.equal(findings[0].severity, "blocking");
  assert.ok(isBlocked(findings));
});

test("catches @Disabled / @Ignore", () => {
  const findings = runVerificationGuard(
    [
      { path: "src/FooTest.java", sign: "+", line: 1, text: "  @Disabled" },
    ],
    [],
  );
  assert.equal(findings[0].ruleId, "test-disabled-annotation");
  assert.equal(findings[0].severity, "blocking");
});

test("catches @ts-ignore and friends", () => {
  const findings = runVerificationGuard(
    [
      { path: "src/foo.ts", sign: "+", line: 1, text: "// @ts-ignore" },
    ],
    [],
  );
  assert.equal(findings[0].ruleId, "ts-ignore");
  assert.equal(findings[0].severity, "blocking");
});

test("catches eslint-disable / biome-ignore", () => {
  const findings = runVerificationGuard(
    [
      { path: "src/foo.ts", sign: "+", line: 1, text: "// eslint-disable-next-line no-console" },
      { path: "src/bar.ts", sign: "+", line: 5, text: "  // biome-ignore lint/correctness/noUnusedVariables" },
    ],
    [],
  );
  const ids = findings.map((f) => f.ruleId);
  assert.ok(ids.includes("eslint-disable"));
});

test("catches empty catch blocks", () => {
  const findings = runVerificationGuard(
    [
      { path: "src/foo.ts", sign: "+", line: 1, text: "try { doX(); } catch {}" },
    ],
    [],
  );
  assert.equal(findings[0].ruleId, "empty-catch");
  assert.equal(findings[0].severity, "important");
});

test("catches CI workflow modifications", () => {
  const findings = runVerificationGuard(
    [],
    [{ path: ".github/workflows/ci.yml", kind: "modified" }],
  );
  assert.equal(findings[0].ruleId, "ci-workflow-modified");
  assert.equal(findings[0].severity, "blocking");
});

test("catches specs/ being touched outside a spec stage", () => {
  const findings = runVerificationGuard(
    [],
    [{ path: "specs/issue-1/PRODUCT.md", kind: "modified" }],
  );
  assert.equal(findings[0].ruleId, "specs-touched-outside-spec-stage");
  assert.equal(findings[0].severity, "blocking");
});

test("counts >5 mock declarations in a single file as important", () => {
  const lines: DiffLine[] = [];
  for (let i = 1; i <= 6; i += 1) {
    lines.push({ path: "src/foo.test.ts", sign: "+", line: i, text: "  jest.mock(`./m${i}`);" });
  }
  const findings = runVerificationGuard(lines, []);
  const mock = findings.find((f) => f.ruleId === "mock-explosion-threshold");
  assert.ok(mock);
  assert.equal(mock.severity, "important");
  assert.ok(mock.excerpt.includes("6"));
});

test("deletions of test files do not flag the old 'test.skip' lines", () => {
  const findings = runVerificationGuard(
    [{ path: "src/foo.test.ts", sign: "-", line: 1, text: "  it.skip('x', () => {});" }],
    [{ path: "src/foo.test.ts", kind: "removed" }],
  );
  // No line-level finding because we filter sign === '-'.
  // Path-level: no rule matches 'src/foo.test.ts' kind === 'removed'.
  assert.equal(findings.length, 0);
});

test("isBlocked returns true when at least one finding is blocking", () => {
  const findings = [
    { category: "lint" as const, ruleId: "x", severity: "important" as const, path: "a.ts", rule: "x", excerpt: "x" },
    { category: "lint" as const, ruleId: "y", severity: "blocking" as const, path: "b.ts", rule: "y", excerpt: "y" },
  ];
  assert.ok(isBlocked(findings));
});

test("groupByRule collapses identical rule hits", () => {
  const findings = [
    { category: "test" as const, ruleId: "test-skip-method", severity: "blocking" as const, path: "a.ts", line: 1, rule: "x", excerpt: "x" },
    { category: "test" as const, ruleId: "test-skip-method", severity: "blocking" as const, path: "a.ts", line: 2, rule: "x", excerpt: "x" },
  ];
  const grouped = groupByRule(findings);
  assert.equal(grouped["test-skip-method"].count, 2);
  assert.equal(grouped["test-skip-method"].severity, "blocking");
});
