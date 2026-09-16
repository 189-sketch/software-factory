import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildWorkerInvocation } from "../runtime/worker-executor.mjs";

const base = {
  runner: process.execPath,
  entryPath: path.resolve("dist/factory/run-issue.js"),
  args: ["--issue", path.resolve(".factory/issue-1.json")],
  issueWorkdir: path.resolve("factory-workdir/issue-1"),
  issueGitDir: path.resolve("factory-workdir/repository/.git/worktrees/issue-1"),
  gitCommonDir: path.resolve("factory-workdir/repository/.git"),
  factoryRoot: path.resolve("."),
  stateDir: path.resolve(".factory"),
  env: { GH_TOKEN: "secret", FACTORY_GH_REPO: "acme/app" },
};

test("local worker refuses execution without an explicit trust grant", () => {
  assert.throws(
    () => buildWorkerInvocation({ ...base, execution: { adapter: "local", trusted: false } }),
    /FACTORY_TRUSTED_EXECUTION=1/,
  );
});

test("trusted local worker runs the selected entry in the issue worktree", () => {
  const invocation = buildWorkerInvocation({ ...base, execution: { adapter: "local", trusted: true } });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [base.entryPath, ...base.args]);
  assert.equal(invocation.options.cwd, base.issueWorkdir);
});

test("docker worker mounts the runtime, issue worktree, Git metadata, and state directory", () => {
  const invocation = buildWorkerInvocation({
    ...base,
    execution: { adapter: "docker", trusted: false, dockerImage: "node:22-bookworm" },
  });
  assert.equal(invocation.command, "docker");
  assert.ok(invocation.args.includes("node:22-bookworm"));
  assert.ok(invocation.args.includes("/factory/dist/factory/run-issue.js"));
  assert.ok(invocation.args.includes("/factory-state/issue-1.json"));
  assert.ok(invocation.args.includes(`${base.gitCommonDir}:/git-common`));
  assert.ok(invocation.args.includes("GIT_DIR"));
  assert.ok(invocation.args.includes("GIT_WORK_TREE"));
  assert.ok(invocation.args.includes("GH_TOKEN"));
  assert.ok(!invocation.args.includes("secret"));
});

test("docker worker requires an operator-provided runtime image", () => {
  assert.throws(
    () => buildWorkerInvocation({ ...base, execution: { adapter: "docker", trusted: false, dockerImage: "" } }),
    /FACTORY_DOCKER_IMAGE/,
  );
});

test("vm worker requires an explicit wrapper command", () => {
  assert.throws(
    () => buildWorkerInvocation({ ...base, execution: { adapter: "vm", trusted: false, vmCommand: "" } }),
    /FACTORY_VM_COMMAND/,
  );
});
