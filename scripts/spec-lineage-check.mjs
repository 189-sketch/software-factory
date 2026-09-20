#!/usr/bin/env node
// scripts/spec-lineage-check.mjs
// Phase A spec-lineage validator for specs/2026-09-20-decision-architecture/.
// Asserts every L1 / L4 acceptance criterion listed in validation.md.
//
// Usage:
//   node scripts/spec-lineage-check.mjs                 # run all checks
//   node scripts/spec-lineage-check.mjs --check <name>  # run one check
//   node scripts/spec-lineage-check.mjs --list          # list available checks
//   node scripts/spec-lineage-check.mjs --help         # usage
//
// Exit codes:
//   0  all selected checks passed
//   1  one or more checks failed (errors printed to stderr)
//   2  invalid usage (bad --check name)

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SPEC_DIR = path.join("specs", "2026-09-20-decision-architecture");
const REQUIREMENTS = path.join(SPEC_DIR, "requirements.md");
const PLAN = path.join(SPEC_DIR, "plan.md");
const VALIDATION = path.join(SPEC_DIR, "validation.md");

const ALL_CHECKS = [
  "required-files",
  "frontmatter",
  "sections",
  "inventory",
  "lineage",
  "decisions-yaml",
  "composite-weights",
  "decisions-count",
  "cjk-fallback",
  "out-of-scope",
  "roadmap-changelog",
  "validation-pyramid",
];

const failures = [];

function ok(name) {
  process.stdout.write(`  PASS  ${name}\n`);
}

function fail(name, msg) {
  process.stderr.write(`  FAIL  ${name}: ${msg}\n`);
  failures.push({ name, msg });
}

function readText(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`File not found: ${p}`);
  }
  return fs.readFileSync(p, "utf8");
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { check: null, list: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--check") {
      const v = args[i + 1];
      if (!v) throw new Error("--check requires a value");
      out.check = v;
      i++;
    } else if (a === "--list") {
      out.list = true;
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return out;
}

// Extract a section of a markdown file starting at the heading matching
// `headerRe` and ending at the next heading of the same or higher level.
//
// Heading detection ignores content inside fenced code blocks (``` fences),
// so YAML / TS examples do not get their `# comment` lines misread as
// markdown headings.
function extractSection(text, headerRe) {
  const m = text.match(headerRe);
  if (!m) return null;
  const startIdx = m.index + m[0].length;
  const headerLevel = (m[0].match(/^#+/)?.[0].length ?? 1);
  let i = startIdx;
  let inFence = false;
  while (i < text.length) {
    // Detect fenced code block boundaries (``` at start of a line).
    if (
      !inFence &&
      text[i] === "\n" &&
      text.slice(i + 1, i + 4) === "```"
    ) {
      inFence = true;
      i += 4;
      continue;
    }
    if (
      inFence &&
      text[i] === "\n" &&
      text.slice(i + 1, i + 4) === "```"
    ) {
      inFence = false;
      i += 4;
      continue;
    }
    if (!inFence && text[i] === "\n") {
      // Check if the next line starts a heading of level 1..headerLevel.
      let j = i + 1;
      let hashCount = 0;
      while (
        j < text.length &&
        text[j] === "#" &&
        hashCount < headerLevel
      ) {
        hashCount++;
        j++;
      }
      if (
        hashCount >= 1 &&
        hashCount <= headerLevel &&
        (text[j] === " " || text[j] === "\n" || text[j] === "\r")
      ) {
        return text.slice(startIdx, i + 1);
      }
    }
    i++;
  }
  return text.slice(startIdx);
}

const checks = {
  "required-files": () => {
    for (const f of [REQUIREMENTS, PLAN, VALIDATION]) {
      if (!fs.existsSync(f)) {
        fail("required-files", `${f} missing`);
      } else {
        ok(`file present: ${f}`);
      }
    }
  },

  frontmatter: () => {
    const r = readText(REQUIREMENTS);
    if (!/^- test_runner:/m.test(r)) {
      fail("frontmatter", "test_runner field missing in requirements.md frontmatter");
    } else {
      ok("test_runner field present");
    }
    if (!/^- parent_phase:/m.test(r)) {
      fail("frontmatter", "parent_phase field missing in requirements.md frontmatter");
    } else {
      ok("parent_phase field present");
    }
  },

  sections: () => {
    const r = readText(REQUIREMENTS);
    const required = [
      /^## Scope\b/m,
      /^## Decisions\b/m,
      /^## Decision Inventory\b/m,
      /^## State Shape Contract\b/m,
      /^## Freshness Protocol\b/m,
      /^## `decisions\.yaml` Schema\b/m,
      /^## Composite Scoring Rubric\b/m,
      /^## CJK Fallback Contract\b/m,
      /^## Context\b/m,
      /^## Technical Risks/m,
    ];
    for (const re of required) {
      if (!re.test(r)) {
        fail("sections", `section matching ${re} missing in requirements.md`);
      } else {
        ok(`section present: ${re.source}`);
      }
    }
  },

  inventory: () => {
    const r = readText(REQUIREMENTS);
    const expected = { A: 5, B: 16, C: 4, D: 5, E: 4 };
    let total = 0;
    for (const [letter, exp] of Object.entries(expected)) {
      // Find the table starting with "| ID | Judgment | ..." and stop at the
      // next "### " or "## " heading.
      const headerRe = new RegExp(
        `^### ${letter} —[\\s\\S]*?^\\| ID \\| Judgment`,
        "m",
      );
      const headerMatch = r.match(headerRe);
      if (!headerMatch) {
        fail("inventory", `could not locate table for ${letter}`);
        continue;
      }
      const tableStart = headerMatch.index + headerMatch[0].length;
      // Stop at next heading.
      const nextHeading = r.slice(tableStart).search(/^#{2,3} /m);
      const tableEnd = nextHeading === -1 ? r.length : tableStart + nextHeading;
      const slice = r.slice(tableStart, tableEnd);
      const rowRe = new RegExp(`^\\|\\s*${letter}\\d+\\s*\\|`, "gm");
      const rows = slice.match(rowRe) ?? [];
      if (rows.length !== exp) {
        fail("inventory", `${letter} expected ${exp} rows, got ${rows.length}`);
      } else {
        ok(`${letter} table has ${exp} rows`);
        total += rows.length;
      }
    }
    if (total !== 34) {
      fail(
        "inventory",
        `total rows across A/B/C/D/E = ${total}, expected 34 (excluding 3 deterministic annotations on A4, B15, B16)`,
      );
    } else {
      ok("total migratable rows = 34 across A/B/C/D/E");
    }
  },

  lineage: () => {
    const r = readText(REQUIREMENTS);
    // Match `path/to/file.ext:NNN` references like `src/agents/triage.ts:182`.
    const refs = r.match(/[A-Za-z0-9_./-]+\.(ts|mjs|d\.mts|js):\d+/g) ?? [];
    if (refs.length === 0) {
      fail("lineage", "no file:line references found in requirements.md");
      return;
    }
    let unresolvable = 0;
    const seen = new Set();
    for (const ref of refs) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      const colonIdx = ref.lastIndexOf(":");
      const file = ref.slice(0, colonIdx);
      const line = parseInt(ref.slice(colonIdx + 1), 10);
      if (!fs.existsSync(file)) {
        fail("lineage", `file not found: ${file} (ref ${ref})`);
        unresolvable++;
        continue;
      }
      const content = fs.readFileSync(file, "utf8").split("\n");
      if (line < 1 || line > content.length) {
        fail("lineage", `line out of range: ${ref} (file has ${content.length} lines)`);
        unresolvable++;
      }
    }
    if (unresolvable === 0) {
      ok(`all ${refs.length} file:line references resolve at HEAD`);
    }
  },

  "decisions-yaml": () => {
    const r = readText(REQUIREMENTS);
    // Find the YAML block in the decisions.yaml Schema section.
    const section = extractSection(r, /^## `decisions\.yaml` Schema\b/m);
    if (!section) {
      fail("decisions-yaml", "`decisions.yaml` Schema section missing");
      return;
    }
    const yamlMatch = section.match(/```yaml\n([\s\S]*?)\n```/);
    if (!yamlMatch) {
      fail("decisions-yaml", "no fenced YAML block found in decisions.yaml Schema section");
      return;
    }
    const block = yamlMatch[1];
    const actions = (block.match(/^\s*-\s*action:\s*(\S+)/gm) ?? []).length;
    if (actions < 3) {
      fail("decisions-yaml", `expected ≥3 action rows in YAML block, got ${actions}`);
    } else {
      ok(`decisions.yaml block has ${actions} action rows`);
    }
  },

  "composite-weights": () => {
    const r = readText(REQUIREMENTS);
    const section = extractSection(r, /^## Composite Scoring Rubric\b/m);
    if (!section) {
      fail("composite-weights", "Composite Scoring Rubric section missing");
      return;
    }
    const weightLines = section.match(/\| (spec|impl|review|verify) \| (0\.\d+) \|/g) ?? [];
    if (weightLines.length !== 4) {
      fail("composite-weights", `expected 4 dimension rows in composite rubric, got ${weightLines.length}`);
      return;
    }
    let sum = 0;
    for (const line of weightLines) {
      const m = line.match(/\| (spec|impl|review|verify) \| (0\.\d+) \|/);
      sum += parseFloat(m[2]);
    }
    if (Math.abs(sum - 1.0) > 0.01) {
      fail("composite-weights", `weights sum to ${sum.toFixed(3)}, expected 1.00 ± 0.01`);
    } else {
      ok(`composite weights sum to ${sum.toFixed(2)}`);
    }
  },

  "decisions-count": () => {
    const r = readText(REQUIREMENTS);
    const section = extractSection(r, /^## Decisions\b/m);
    if (!section) {
      fail("decisions-count", "Decisions section missing");
      return;
    }
    const decisions = (section.match(/^### Decision \d+ —/gm) ?? []).length;
    if (decisions !== 8) {
      fail("decisions-count", `expected 8 decisions, found ${decisions}`);
    } else {
      ok("all 8 decisions present (Decision 1 through Decision 8)");
    }
  },

  "cjk-fallback": () => {
    const r = readText(REQUIREMENTS);
    const section = extractSection(r, /^## CJK Fallback Contract\b/m);
    if (!section) {
      fail("cjk-fallback", "CJK Fallback Contract section missing");
      return;
    }
    const required = [
      ["trigger conditions", /trigger conditions/i],
      ["behaviour clauses", /\b[Bb]ehaviour\b/],
      ["observability clauses", /[Oo]bservability/],
      ["test contract", /test contract/i],
    ];
    for (const [label, re] of required) {
      if (!re.test(section)) {
        fail("cjk-fallback", `clause "${label}" missing`);
      } else {
        ok(`CJK fallback clause present: ${label}`);
      }
    }
  },

  "out-of-scope": () => {
    const r = readText(REQUIREMENTS);
    // Find subsection "### Out of Scope (Phase A → Phase B / C)" specifically.
    // No `\b` after `)` — `)` is non-word, the following `\n` is non-word,
    // so `\b` would never match. The heading text is already specific.
    const section = extractSection(
      r,
      /^### Out of Scope \(Phase A → Phase B \/ C\)/m,
    );
    if (!section) {
      fail("out-of-scope", "Out of Scope (Phase A → Phase B / C) section missing");
      return;
    }
    // Items are written as "1. **Phase B** — ..." in markdown bold.
    const phaseB = (section.match(/\*\*Phase B\*\*/g) ?? []).length;
    const phaseC = (section.match(/\*\*Phase C\*\*/g) ?? []).length;
    const phaseD = (section.match(/\*\*Phase D\*\*/g) ?? []).length;
    // Plus the two items that say "Phase A is purely additive" / "are referenced
    // but not edited" — both implicitly defer to Phase B.
    const implicit =
      (section.match(/Phase A is purely additive/g) ?? []).length +
      (section.match(/are referenced but not edited/g) ?? []).length;
    const total = phaseB + phaseC + phaseD + implicit;
    if (total < 7) {
      fail(
        "out-of-scope",
        `expected ≥7 deferred items (B/C/D tagged or implicit), found ${total} (B=${phaseB}, C=${phaseC}, D=${phaseD}, implicit=${implicit})`,
      );
    } else {
      ok(
        `Out of Scope has ${total} deferred items (B=${phaseB}, C=${phaseC}, D=${phaseD}, implicit=${implicit})`,
      );
    }
  },

  "roadmap-changelog": () => {
    const roadmapPath = path.join("specs", "roadmap.md");
    const changelogPath = "CHANGELOG.md";
    if (!fs.existsSync(roadmapPath)) {
      fail("roadmap-changelog", `${roadmapPath} missing`);
      return;
    }
    const roadmap = readText(roadmapPath);
    if (!/### Phase 12: Decision Architecture/m.test(roadmap)) {
      fail("roadmap-changelog", "Phase 12 entry missing in specs/roadmap.md");
    } else {
      ok("Phase 12 entry present in specs/roadmap.md");
    }
    if (!fs.existsSync(changelogPath)) {
      fail("roadmap-changelog", `${changelogPath} missing`);
      return;
    }
    const changelog = readText(changelogPath);
    if (!/^## Unreleased[^\n]*Decision Architecture/m.test(changelog)) {
      fail(
        "roadmap-changelog",
        "'## Unreleased ... Decision Architecture' heading missing in CHANGELOG.md",
      );
    } else {
      ok("'## Unreleased ... Decision Architecture' heading present in CHANGELOG.md");
    }
  },

  "validation-pyramid": () => {
    const v = readText(VALIDATION);
    const layers = ["L1", "L2", "L3", "L4", "L5", "L6", "L7"];
    for (const layer of layers) {
      const re = new RegExp(`^## ${layer}\\b`, "m");
      if (!re.test(v)) {
        fail("validation-pyramid", `${layer} missing in validation.md`);
      } else {
        ok(`${layer} present in validation.md`);
      }
    }
    if (!/^## Definition of Done/m.test(v)) {
      fail("validation-pyramid", "Definition of Done missing");
    } else {
      ok("Definition of Done present");
    }
  },
};

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    process.stderr.write(`Usage error: ${err.message}\n`);
    process.exit(2);
  }

  if (args.help) {
    process.stdout.write(
      `Usage: node scripts/spec-lineage-check.mjs [--check <name>] [--list]\n\nAvailable checks:\n  ${ALL_CHECKS.join("\n  ")}\n`,
    );
    process.exit(0);
  }
  if (args.list) {
    process.stdout.write(ALL_CHECKS.join("\n") + "\n");
    process.exit(0);
  }

  const toRun = args.check ? [args.check] : ALL_CHECKS;
  for (const name of toRun) {
    if (!ALL_CHECKS.includes(name)) {
      process.stderr.write(
        `Unknown check: ${name}\nAvailable: ${ALL_CHECKS.join(", ")}\n`,
      );
      process.exit(2);
    }
    process.stdout.write(`[check] ${name}\n`);
    try {
      checks[name]();
    } catch (err) {
      fail(name, `unexpected error: ${err.message}`);
    }
  }

  process.stdout.write("\n");
  if (failures.length > 0) {
    process.stderr.write(`FAIL: ${failures.length} check(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write(`OK: all ${toRun.length} check(s) passed\n`);
  process.exit(0);
}

main();
