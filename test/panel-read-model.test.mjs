import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPanelReadModel } from "../runtime/panel-read-model.mjs";

async function project(root, name, issueNumber, stage) {
  await fs.mkdir(path.join(root, ".factory-daemon"), { recursive: true });
  await fs.mkdir(path.join(root, "state", "issues"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name }));
  await fs.writeFile(path.join(root, ".factory-daemon", ".env"), [
    `FACTORY_STATE_DIR=state`,
    `FACTORY_GH_REPO=acme/${name}`,
  ].join("\n"));
  await fs.writeFile(path.join(root, "state", "issues", `${issueNumber}.json`), JSON.stringify({
    issue: { number: issueNumber, title: `${name} issue`, labels: [] },
    stages: {
      [stage]: { startedAt: "2026-09-11T00:00:00.000Z", endedAt: "2026-09-11T00:01:00.000Z", status: "completed" },
    },
    events: [{ stage, startedAt: "2026-09-11T00:00:00.000Z", endedAt: "2026-09-11T00:01:00.000Z", status: "completed" }],
  }));
}

test("PanelReadModel loads explicit projects and each project's configured state directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-panel-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const second = path.join(root, "second");
  await project(root, "primary", 1, "review-spec");
  await project(second, "secondary", 2, "implementation");
  await fs.mkdir(path.join(root, ".factory"), { recursive: true });
  await fs.writeFile(path.join(root, ".factory", "projects.json"), JSON.stringify({
    projects: [{ id: "secondary", root: "second", name: "Secondary" }],
  }));

  const model = await createPanelReadModel(root, { includeGitHub: false });
  const projects = await model.projects();
  assert.deepEqual(projects.projects.map((entry) => entry.id), ["current", "secondary"]);
  assert.equal((await model.issues("current"))[0].issue.number, 1);
  assert.equal((await model.issues("secondary"))[0].issue.number, 2);
});

test("PanelReadModel does not leak the current project's path overrides into registered projects", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-panel-env-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const second = path.join(root, "second");
  await project(root, "primary", 1, "triage");
  await project(second, "secondary", 2, "implementation");
  await fs.mkdir(path.join(root, ".factory"), { recursive: true });
  await fs.writeFile(path.join(root, ".factory", "projects.json"), JSON.stringify({
    projects: [{ id: "secondary", root: "second" }],
  }));

  const previousStateDir = process.env.FACTORY_STATE_DIR;
  process.env.FACTORY_STATE_DIR = path.join(root, "state");
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.FACTORY_STATE_DIR;
    else process.env.FACTORY_STATE_DIR = previousStateDir;
  });

  const model = await createPanelReadModel(root, { includeGitHub: false });
  assert.equal((await model.issues("secondary"))[0].issue.number, 2);
});

test("PanelReadModel projects internal stage events onto canonical UI stages", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-panel-events-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await project(root, "primary", 7, "review-spec");

  const model = await createPanelReadModel(root, { includeGitHub: false });
  const [issue] = await model.issues("current");
  assert.equal(issue.stages.spec.status, "completed");
  const events = await model.events();
  assert.equal(events[0].stage, "spec");
  assert.equal(events[0].bindings.internalStage, "review-spec");
  assert.equal(events[0].projectId, "current");
});
