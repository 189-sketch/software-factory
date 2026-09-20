import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

const workflowDirectory = path.resolve("templates/github/workflows");

async function workflow(name) {
  return fs.readFile(path.join(workflowDirectory, name), "utf8");
}

test("every workflow scheduler that invokes the factory holds and releases a lease", async () => {
  const names = [
    "triage-issues.yml",
    "spec-ready-issues.yml",
    "implement-ready-issues.yml",
    "review-pull-requests.yml",
    "improve-review-pr.yml",
  ];

  for (const name of names) {
    const body = await workflow(name);
    const acquire = body.indexOf("factory-lease.mjs acquire");
    const execute = body.indexOf("dist/factory/run-issue.js");
    const release = body.indexOf("factory-lease.mjs release");
    assert.ok(acquire >= 0 && acquire < execute, `${name} must acquire before execution`);
    assert.ok(release > execute, `${name} must release after execution`);
    assert.match(body, /if: always\(\) && steps\.lease\.outcome == 'success'/, `${name} must release on failures`);
  }
});

test("workflow runtime and merge policy match the package contract", async () => {
  const names = await fs.readdir(workflowDirectory);
  for (const name of names.filter((entry) => entry.endsWith(".yml"))) {
    assert.doesNotMatch(await workflow(name), /node-version:\s*["']?20\b/, `${name} uses unsupported Node 20`);
  }

  for (const name of ["spec-ready-issues.yml", "implement-ready-issues.yml"]) {
    assert.match(
      await workflow(name),
      /FACTORY_AUTO_MERGE:\s*\$\{\{ vars\.FACTORY_AUTO_MERGE \|\| '0' \}\}/,
      `${name} must default auto merge off`,
    );
  }
});
