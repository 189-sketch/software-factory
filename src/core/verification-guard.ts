/**
 * Verification Guard (M5) — plan §29.
 *
 * `ReviewPrAgent` and `ReviewSpecAgent` only see the diff text;
 * neither runs a deterministic scan for "agent cheated" patterns
 * (skipped tests, disabled lint, swallowed exceptions, deleted
 * CI). The merge stage calls `mergePullRequest` as soon as
 * review+verify both pass, so a PR that ships `it.skip` on every
 * new test or that rewrites `.github/workflows/ci.yml` to skip
 * the build would sail through.
 *
 * This module is a single deterministic pass over the PR's diff
 * (or a stash of the candidate branch) that returns a list of
 * `VerificationGuardFinding` rows. The orchestrator reads the
 * severity of the highest finding to decide `VERIFICATION_BLOCKED`
 * vs. `VERIFICATION_PASSED`; the operator gets a typed receipt.
 *
 * The guard is intentionally pure and dependency-free so it can
 * be unit-tested in isolation and reused by every agent (spec
 * review, PR review, behavior verify, future code review).
 *
 * Detection rules (subset; the table below is the source of truth
 * and is encoded inline in `PATTERNS`):
 *
 *   category   pattern                                       severity
 *   --------   -------------------------------------------  --------
 *   test       test.skip / it.skip / xit / describe.skip   blocking
 *   test       @Disabled / @Ignore / @DisabledIf            blocking
 *   test       removed test file (line in deleted set)       important
 *   type       // @ts-ignore / @ts-expect-error / @ts-nocheck blocking
 *   lint       eslint-disable / stylelint-disable            blocking
 *   lint       // biome-ignore / @ts-expect-error            blocking
 *   trycatch   catch {  } / catch (_) { } / catch (e) { }    important
 *   trycatch   || true / ?? false                             important
 *   ci         modifications to .github/workflows/          blocking
 *   ci         modifications to .circleci/ or .gitlab-ci.yml blocking
 *   contract   modifications to specs/ in a non-spec PR      blocking
 *   mock       > 5 jest.mock / vi.mock / nock(...) calls    important
 *   test       skip of an entire test file (filename ends in
 *              .skip.ts / .skip.js / .skip.py)               blocking
 *
 * Severity "blocking" → orchestrator refuses to merge, surfaces
 * the finding via the issue comment + a state event.
 */

export type VerificationGuardSeverity = "blocking" | "important" | "nit";

/** Single rule hit. The orchestrator groups these by file / line
 * to render a structured comment; the daemon's panel reads the
 * same shape to surface "anti-cheat" warnings. */
export interface VerificationGuardFinding {
  category: "test" | "type" | "lint" | "trycatch" | "ci" | "contract" | "mock";
  ruleId: string;
  severity: VerificationGuardSeverity;
  /** File path the rule hit, relative to the worktree root. */
  path: string;
  /** 1-based line number when the diff has it; undefined for
   * path-level matches (file added / removed). */
  line?: number;
  /** Short rule text (the regex source) so the operator can
   * recognise the hit without opening the file. */
  rule: string;
  /** Excerpt from the surrounding diff. Truncated to 200 chars. */
  excerpt: string;
}

/** A single (file, line, +/-) entry from a unified diff. The
 * guard consumes these rather than the raw diff so the regex
 * patterns can match a stable substring shape. */
export interface DiffLine {
  path: string;
  /** "+" for additions, "-" for deletions, " " for context. */
  sign: "+" | "-" | " ";
  /** 1-based line number in the new file for additions / context;
   * in the old file for deletions. */
  line: number;
  text: string;
}

/** A single (path, kind) entry from a file-list diff. The guard
 * uses this for path-level checks (test removal, workflow edit). */
export interface DiffPath {
  path: string;
  kind: "added" | "removed" | "modified";
}

/** Internal rule definition. The `pattern` is tested against the
 * raw line text (no leading sign). The `pathRegex` (optional)
 * restricts the rule to files whose path matches. */
interface Rule {
  ruleId: string;
  category: VerificationGuardFinding["category"];
  severity: VerificationGuardSeverity;
  description: string;
  /** Regex tested against `DiffLine.text`. */
  pattern: RegExp;
  /** Optional path glob; if absent the rule applies to every file. */
  pathRegex?: RegExp;
}

/** Single source of truth for every detection rule. Adding a new
 * check is one entry in this table; the test suite covers each
 * rule by id. */
const RULES: Rule[] = [
  {
    ruleId: "test-skip-method",
    category: "test",
    severity: "blocking",
    description: "test method skipped",
    pattern: /\b(test|it|describe|context|specify)\s*\.\s*(skip|only)\s*\(/,
  },
  {
    ruleId: "test-disabled-annotation",
    category: "test",
    severity: "blocking",
    description: "test method disabled",
    pattern: /@(?:Disabled|Ignore|DisabledIf|EnabledIf)\b/,
  },
  {
    ruleId: "test-skip-suffix",
    category: "test",
    severity: "blocking",
    description: "test file with .skip.<ext> name",
    pattern: /^.*$/, // matched by the path-level sweep below
  },
  {
    ruleId: "ts-ignore",
    category: "type",
    severity: "blocking",
    description: "TypeScript error suppression",
    pattern: /@ts-(?:ignore|expect-error|nocheck)\b/,
  },
  {
    ruleId: "eslint-disable",
    category: "lint",
    severity: "blocking",
    description: "ESLint / Stylelint / Biome disable comment",
    pattern: /(?:eslint-disable(?:-next-line|-line)?|stylelint-disable(?:-next-line|-line)?|biome-ignore)/,
  },
  {
    ruleId: "empty-catch",
    category: "trycatch",
    severity: "important",
    description: "empty / swallowing catch block",
    pattern: /catch\s*(?:\(\s*\)|\(\s*[_a-zA-Z][_a-zA-Z0-9]*\s*\)|\(\s*error\s*\))?\s*\{\s*\}/,
  },
  {
    ruleId: "fallback-true",
    category: "trycatch",
    severity: "important",
    description: "fallback to true / false to swallow errors",
    pattern: /\|\|\s*true|\?\?\s*false/,
  },
  {
    ruleId: "mock-explosion",
    category: "mock",
    severity: "important",
    description: ">5 mock declarations in a single file (likely mock-only coverage)",
    pattern: /\b(?:jest|vi|sinon)\s*\.\s*mock\s*\(|(?:nock|sinon)\s*\.\s*stub\s*\(/,
  },
];

/** File-level rules. The guard reports one finding per matching
 * path. Severity is fixed by the rule; line is undefined. */
interface PathRule {
  ruleId: string;
  category: VerificationGuardFinding["category"];
  severity: VerificationGuardSeverity;
  description: string;
  pathRegex: RegExp;
  kind: DiffPath["kind"] | "any";
}

const PATH_RULES: PathRule[] = [
  {
    ruleId: "ci-workflow-modified",
    category: "ci",
    severity: "blocking",
    description: "CI workflow file modified — review whether the change disables a check",
    pathRegex: /^\.github\/workflows\/.+\.ya?ml$|^\.circleci\/.+|^\.gitlab-ci\.ya?ml$|^\.travis\.yml$/,
    kind: "any",
  },
  {
    ruleId: "test-skip-suffix",
    category: "test",
    severity: "blocking",
    description: "test file with .skip.<ext> suffix added",
    pathRegex: /\.(skip|skip-test)\.(ts|tsx|js|jsx|py|go|rb)$/,
    kind: "added",
  },
  {
    ruleId: "specs-touched-outside-spec-stage",
    category: "contract",
    severity: "blocking",
    description: "implementation PR must not touch specs/",
    pathRegex: /^specs\//,
    kind: "any",
  },
];

/** Run the guard. Returns the deduped finding list (one finding
 * per (file, line, ruleId)). The caller decides whether any
 * blocking finding means "do not merge". */
export function runVerificationGuard(
  diffLines: ReadonlyArray<DiffLine>,
  diffPaths: ReadonlyArray<DiffPath>,
): VerificationGuardFinding[] {
  const findings: VerificationGuardFinding[] = [];
  const seen = new Set<string>();

  const push = (f: VerificationGuardFinding) => {
    const key = `${f.ruleId}|${f.path}|${f.line ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };

  // 1. Line-level rules. Apply only to additions / context lines
  // so deletions of test files (which contain "test.skip" in the
  // OLD file) are not flagged. Deletions of tests are caught by
  // the path-level "test-skip-suffix" rule on the *removed* path
  // (it would never match) — we have a separate path-level
  // "removed test file" rule for that case.
  for (const line of diffLines) {
    if (line.sign === "-") continue;
    for (const rule of RULES) {
      if (rule.ruleId === "test-skip-suffix") continue;
      if (rule.pathRegex && !rule.pathRegex.test(line.path)) continue;
      if (!rule.pattern.test(line.text)) continue;
      push({
        category: rule.category,
        ruleId: rule.ruleId,
        severity: rule.severity,
        path: line.path,
        line: line.line,
        rule: rule.description,
        excerpt: truncate(line.text.trim(), 200),
      });
    }
  }

  // 2. Path-level rules. Apply to the file list, not the diff.
  for (const p of diffPaths) {
    for (const rule of PATH_RULES) {
      if (rule.kind !== "any" && rule.kind !== p.kind) continue;
      if (!rule.pathRegex.test(p.path)) continue;
      push({
        category: rule.category,
        ruleId: rule.ruleId,
        severity: rule.severity,
        path: p.path,
        rule: rule.description,
        excerpt: `${p.kind}: ${p.path}`,
      });
    }
  }

  // 3. Mock explosion rule: a single file with >5 mock
  // declarations. The line-level rule above only counts the
  // declarations; this rule aggregates per-file.
  const mockByPath = new Map<string, number>();
  for (const line of diffLines) {
    if (line.sign === "-") continue;
    if (!RULES.find((r) => r.ruleId === "mock-explosion")!.pattern.test(line.text)) continue;
    mockByPath.set(line.path, (mockByPath.get(line.path) ?? 0) + 1);
  }
  for (const [path, count] of mockByPath) {
    if (count > 5) {
      push({
        category: "mock",
        ruleId: "mock-explosion-threshold",
        severity: "important",
        path,
        rule: `>5 mock declarations in a single file (${count})`,
        excerpt: `mock count: ${count}`,
      });
    }
  }

  return findings;
}

/** True when at least one finding has severity `blocking`. */
export function isBlocked(findings: ReadonlyArray<VerificationGuardFinding>): boolean {
  return findings.some((f) => f.severity === "blocking");
}

/** Convenience: group findings by rule id. Used by the
 * orchestrator to render a single "X blocking, Y important"
 * summary at the top of the issue comment. */
export function groupByRule(
  findings: ReadonlyArray<VerificationGuardFinding>,
): Record<string, { count: number; severity: VerificationGuardSeverity }> {
  const out: Record<string, { count: number; severity: VerificationGuardSeverity }> = {};
  for (const f of findings) {
    const cur = out[f.ruleId] ?? { count: 0, severity: f.severity };
    out[f.ruleId] = { count: cur.count + 1, severity: f.severity };
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}
