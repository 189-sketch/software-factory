// Promotion of proven failure-driven lessons into SKILL.md (scripts/lessons.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promotable, renderSection, withSection } from "../scripts/lessons.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "lessons.mjs");
const lesson = (id, successes, recurrences, status = "active") => ({
  id, role: "implementation", kind: "REVIEW_REJECTED", text: `Rule ${id}`, status, revision: 1,
  createdAt: "", updatedAt: "", evidence: [], stats: { applied: successes + recurrences, successes, recurrences },
});

test("only active lessons that helped more often than they failed are promoted", () => {
  const chosen = promotable([lesson("L-a", 3, 0), lesson("L-b", 1, 0), lesson("L-c", 2, 2), lesson("L-d", 5, 0, "retired")], 2);
  assert.deepEqual(chosen.map((item) => item.id), ["L-a"]);
});

test("the promoted section is appended once and replaced on later promotions", () => {
  const first = withSection("# Implementation\n\nbody\n", renderSection([lesson("L-a", 2, 0)]));
  const second = withSection(first, renderSection([lesson("L-a", 3, 0), lesson("L-b", 2, 0)]));
  assert.equal(second.match(/factory-lessons:start/g).length, 1);
  assert.match(second, /- Rule L-a <!-- L-a: 3 passes/);
  assert.match(second, /- Rule L-b/);
  assert.ok(second.startsWith("# Implementation\n\nbody\n"));
});

test("promote is a dry run unless --write is passed", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-promote-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "state", "lessons"), { recursive: true });
  mkdirSync(path.join(root, "skills", "implementation"), { recursive: true });
  const skill = path.join(root, "skills", "implementation", "SKILL.md");
  writeFileSync(skill, "# Implementation\n");
  writeFileSync(path.join(root, "state", "lessons", "implementation.json"),
    JSON.stringify({ version: 1, role: "implementation", lessons: [lesson("L-a", 2, 0)], pending: {} }));
  const run = (...extra) => execFileSync(process.execPath, [script, "promote", "--state-dir", path.join(root, "state"),
    "--skills-dir", path.join(root, "skills"), ...extra], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.match(run(), /dry run/);
  assert.equal(readFileSync(skill, "utf8"), "# Implementation\n");
  assert.match(run("--write"), /updated/);
  assert.match(readFileSync(skill, "utf8"), /## Learned from failures[\s\S]*Rule L-a/);
});
