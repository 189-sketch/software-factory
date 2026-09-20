import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveFactoryConfig } from "../runtime/factory-config.mjs";

test("FactoryConfig owns safe operational defaults", () => {
  const cwd = path.resolve("workspace");
  const config = resolveFactoryConfig({ env: {}, cwd });

  assert.equal(config.autoMerge, false);
  assert.equal(config.syncLabels, true);
  assert.equal(config.syncProjects, true);
  assert.equal(config.execution.adapter, "local");
  assert.equal(config.execution.trusted, false);
  assert.equal(config.execution.dockerImage, "");
  assert.equal(config.lease.staleMs, 0);
  assert.equal(config.paths.stateDir, path.join(cwd, ".factory"));
  assert.equal(config.paths.workdir, path.join(cwd, "factory-workdir"));
});

test("FactoryConfig parses operator booleans once", () => {
  const config = resolveFactoryConfig({
    env: {
      FACTORY_AUTO_MERGE: "1",
      FACTORY_SYNC_LABELS: "false",
      FACTORY_SYNC_PROJECTS: "off",
      FACTORY_TRUSTED_EXECUTION: "yes",
    },
    cwd: path.resolve("workspace"),
  });

  assert.equal(config.autoMerge, true);
  assert.equal(config.syncLabels, false);
  assert.equal(config.syncProjects, false);
  assert.equal(config.execution.trusted, true);
});

test("FactoryConfig rejects ambiguous booleans", () => {
  assert.throws(
    () => resolveFactoryConfig({ env: { FACTORY_AUTO_MERGE: "enabled" } }),
    /Invalid FACTORY_AUTO_MERGE/,
  );
});

test("FactoryConfig applies CLI path overrides before environment defaults", () => {
  const cwd = path.resolve("workspace");
  const config = resolveFactoryConfig({
    cwd,
    env: {
      FACTORY_STATE_DIR: "env-state",
      FACTORY_WORKDIR: "env-work",
      FACTORY_GH_REPO: "env/repo",
    },
    cli: {
      stateDir: "cli-state",
      workdir: "cli-work",
      repo: "cli/repo",
    },
  });

  assert.equal(config.paths.stateDir, path.resolve(cwd, "cli-state"));
  assert.equal(config.paths.workdir, path.resolve(cwd, "cli-work"));
  assert.equal(config.github.repository, "env/repo");
});

test("FactoryConfig parses FACTORY_LEASE_STALE_MS as a non-negative integer", () => {
  const cwd = path.resolve("workspace");

  const off = resolveFactoryConfig({ env: {}, cwd });
  assert.equal(off.lease.staleMs, 0);

  const set = resolveFactoryConfig({ env: { FACTORY_LEASE_STALE_MS: "600000" }, cwd });
  assert.equal(set.lease.staleMs, 600000);

  assert.throws(
    () => resolveFactoryConfig({ env: { FACTORY_LEASE_STALE_MS: "abc" }, cwd }),
    /Invalid FACTORY_LEASE_STALE_MS/,
  );
});

test("FactoryConfig accepts FACTORY_EXECUTION_MODE as a deprecated alias for FACTORY_EXECUTION_ADAPTER", () => {
  const cwd = path.resolve("workspace");
  // Capture stderr so the WARN line doesn't pollute test output.
  const originalWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  try {
    const config = resolveFactoryConfig({ env: { FACTORY_EXECUTION_MODE: "docker" }, cwd });
    assert.equal(config.execution.adapter, "docker", "alias must resolve to the same value");
    assert.match(captured, /FACTORY_EXECUTION_MODE is deprecated/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("FactoryConfig prefers FACTORY_EXECUTION_ADAPTER over the legacy alias", () => {
  const cwd = path.resolve("workspace");
  const config = resolveFactoryConfig({
    env: {
      FACTORY_EXECUTION_ADAPTER: "docker",
      FACTORY_EXECUTION_MODE: "local", // would resolve to 'local' if it won
    },
    cwd,
  });
  assert.equal(config.execution.adapter, "docker");
});
