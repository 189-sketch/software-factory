#!/usr/bin/env node
// Inspect and promote failure-driven agent lessons (src/core/lessons.ts).
//
//   node scripts/lessons.mjs list    [--state-dir .factory] [--role implementation]
//   node scripts/lessons.mjs promote [--state-dir .factory] [--skills-dir skills]
//                                    [--min-successes 2] [--write]
//
// `promote` selects active lessons that have prevented their failure at
// least --min-successes times and recurred less often than they helped,
// and renders them into a marked section of each agent's SKILL.md. Without
// --write it prints the proposed sections (dry run). Re-running replaces the
// section, so promotion is idempotent; review and commit the change like
// any other skill edit.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const START = "<!-- factory-lessons:start -->";
const END = "<!-- factory-lessons:end -->";
// Lesson role -> the skill file that owns that agent's behaviour.
const SKILL_FOR_ROLE = {
  triage: "triage",
  spec: "spec",
  "review-spec": "review-spec",
  implementation: "implementation",
  "review-pr": "review-pr",
  "verify-behavior": "verify-behavior",
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { out._.push(arg); continue; }
    const key = arg.slice(2);
    if (key === "write") out.write = true;
    else out[key] = argv[++i];
  }
  return out;
}

function lessonsDir(args) {
  if (args["lessons-dir"]) return path.resolve(args["lessons-dir"]);
  if (process.env.FACTORY_LESSONS_DIR) return path.resolve(process.env.FACTORY_LESSONS_DIR);
  return path.join(path.resolve(args["state-dir"] || process.env.FACTORY_STATE_DIR || ".factory"), "lessons");
}

function readRoles(dir, only) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")))
    .filter((file) => file?.version === 1 && Array.isArray(file.lessons) && (!only || file.role === only));
}

export function promotable(lessons, minSuccesses) {
  return lessons
    .filter((lesson) => lesson.status === "active"
      && lesson.stats.successes >= minSuccesses
      && lesson.stats.recurrences < lesson.stats.successes)
    .sort((a, b) => b.stats.successes - a.stats.successes || a.id.localeCompare(b.id));
}

export function renderSection(lessons) {
  return [
    START,
    "## Learned from failures",
    "",
    "Distilled by the factory from failed checks and proven by later passing attempts.",
    "",
    ...lessons.map((lesson) => `- ${lesson.text} <!-- ${lesson.id}: ${lesson.stats.successes} passes, ${lesson.stats.recurrences} recurrences -->`),
    END,
  ].join("\n");
}

export function withSection(skillBody, section) {
  const start = skillBody.indexOf(START);
  const end = skillBody.indexOf(END);
  if (start !== -1 && end > start) return skillBody.slice(0, start) + section + skillBody.slice(end + END.length);
  return `${skillBody.trimEnd()}\n\n${section}\n`;
}

function list(args) {
  const files = readRoles(lessonsDir(args), args.role);
  if (!files.length) { console.log(`No lessons under ${lessonsDir(args)}`); return; }
  for (const file of files) {
    console.log(`\n${file.role} (${file.lessons.length} lessons)`);
    for (const lesson of file.lessons) {
      const { applied, successes, recurrences } = lesson.stats;
      console.log(`  ${lesson.id} ${lesson.status.padEnd(7)} [${lesson.kind}] applied=${applied} passes=${successes} recurrences=${recurrences} evidence=${lesson.evidence.length}`);
      console.log(`    ${lesson.text}`);
    }
  }
}

function promote(args) {
  const minSuccesses = Number(args["min-successes"] ?? 2);
  const skillsDir = path.resolve(args["skills-dir"] || "skills");
  let changed = 0;
  for (const file of readRoles(lessonsDir(args), args.role)) {
    const skill = SKILL_FOR_ROLE[file.role];
    const chosen = promotable(file.lessons, minSuccesses);
    if (!skill || !chosen.length) continue;
    const skillFile = path.join(skillsDir, skill, "SKILL.md");
    if (!existsSync(skillFile)) { console.error(`skip ${file.role}: ${skillFile} not found`); continue; }
    const section = renderSection(chosen);
    const before = readFileSync(skillFile, "utf8");
    const after = withSection(before, section);
    if (after === before) continue;
    changed++;
    if (args.write) {
      writeFileSync(skillFile, after);
      console.log(`updated ${skillFile} with ${chosen.length} lesson(s)`);
    } else {
      console.log(`--- ${skillFile} (dry run; pass --write to apply)\n${section}\n`);
    }
  }
  if (!changed) console.log(`No lessons meet the promotion bar (>= ${minSuccesses} passes, fewer recurrences than passes).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "list";
  if (command === "list") list(args);
  else if (command === "promote") promote(args);
  else {
    console.error(`Unknown command: ${command} (expected list or promote)`);
    process.exit(1);
  }
}
