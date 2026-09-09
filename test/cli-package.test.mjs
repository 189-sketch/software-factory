import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const source = fileURLToPath(new URL("../", import.meta.url));

test("packed CLI installs, serves the panel, and preserves credentials", { timeout: 180000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory packed CLI "));
  let panel;
  async function stopPanel() {
    if (panel && panel.exitCode === null) {
      if (process.platform === "win32") {
        await exec("taskkill", ["/PID", String(panel.pid), "/T", "/F"]).catch(() => {});
      } else {
        const closed = new Promise((resolve) => panel.once("close", resolve));
        panel.kill("SIGTERM");
        await closed;
      }
    }
  }
  t.after(async () => {
    await stopPanel();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(FACTORY_|ANTHROPIC_|GH_|GITHUB_|NODE_OPTIONS$)/i.test(key)) delete env[key];
  }
  env.NODE_ENV = "production";
  env.ANTHROPIC_AUTH_TOKEN = "test-token";
  env.ANTHROPIC_BASE_URL = "https://example.invalid";
  env.ANTHROPIC_MODEL = "test-model";
  env.npm_config_prefer_offline = "true";
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "Run this test with npm run test:cli");
  const npm = (args, cwd = root) => exec(process.execPath, [npmCli, ...args], { cwd, env, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  const packed = JSON.parse((await npm(["pack", "--json", "--pack-destination", root], source)).stdout)[0];
  const packageFiles = new Set(packed.files.map((file) => file.path));
  for (const file of [
    "bin/factory.js",
    "bin/factory-panel.js",
    "scripts/factory-daemon.mjs",
    "scripts/install-windows-service.ps1",
    "dist/factory/run-issue.js",
    "dist/factory/orchestrator.js",
    "dist/panel/index.html",
    "dist/factory/templates/github/workflows/triage-issues.yml",
  ]) {
    assert.ok(packageFiles.has(file), `missing package runtime file: ${file}`);
  }
  // Source-only files that must NOT ship in the npm tarball — install no
  // longer copies them to the target, the package is the only runtime
  // artifact users receive.
  for (const file of ["src/cli/run-issue.ts", "skills/triage/SKILL.md"]) {
    assert.ok(!packageFiles.has(file), `forbidden package file: ${file}`);
  }
  assert.deepEqual(
    [...packageFiles].filter((file) => file.endsWith(".map")),
    [],
    "source maps embed project source and must not ship",
  );
  await fs.writeFile(path.join(root, "package.json"), '{"private":true}');
  await npm(["install", path.join(root, packed.filename), "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
  const help = await npm(["exec", "--offline", "--", "factory", "--help"]);
  assert.match(help.stdout, /factory start/);
  t.diagnostic("packed npm executable installed and --help passed");
  const installed = path.join(root, "node_modules/software-factory-cli");
  const cli = path.join(installed, "bin/factory.js");
  const target = path.join(root, "target repo");
  await fs.mkdir(target);
  await exec("git", ["init", target], { env });
  // Simulate an upgrade from the old installer, which copied the factory
  // source and daemon into every target.
  for (const file of [
    "factory/src/cli/run-issue.ts",
    "factory/scripts/factory-daemon.mjs",
    "factory/skills/triage/SKILL.md",
    ".factory-daemon/factory-daemon.mjs",
  ]) {
    const destination = path.join(target, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, "legacy factory runtime\n");
  }
  const run = (args) => exec(process.execPath, ["--", cli, ...args], { cwd: target, env, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  // Pass --package so install uses the local tarball we just packed
  // (install-factory.mjs runs `npm install <pkg>` which would otherwise
  // hit the public registry). npm install runs with cwd=target, so the
  // tarball path must be absolute or it won't resolve.
  const tarballPath = path.join(root, packed.filename);
  await run(["install", target, "--mode", "local", "--repo", "example/target", "--non-interactive", "--package", tarballPath]);
  assert.ok(!existsSync(path.join(target, "factory")), "legacy source copy must be removed during upgrade");
  assert.ok(!existsSync(path.join(target, ".factory-daemon/factory-daemon.mjs")), "legacy copied daemon must be removed during upgrade");
  const envPath = path.join(target, ".factory-daemon/.env");
  const credentials = "# preserved test configuration\nANTHROPIC_BASE_URL=https://example.test\nANTHROPIC_MODEL=test-model\nANTHROPIC_AUTH_TOKEN=sk-test\n";
  await fs.writeFile(envPath, credentials);
  await run(["install", target, "--mode", "local", "--repo", "example/target", "--non-interactive", "--package", tarballPath]);
  assert.equal(await fs.readFile(envPath, "utf8"), credentials);
  const ignored = await exec("git", ["check-ignore", ".factory-daemon/.env", ".factory/state-14.json"], { cwd: target, env });
  assert.match(ignored.stdout, /\.factory-daemon\/\.env/);
  assert.match(ignored.stdout, /\.factory\/state-14\.json/);
  // Daemon script lives in node_modules; .factory-daemon/ is just wrappers.
  assert.ok(await fs.stat(path.join(installed, "scripts/factory-daemon.mjs")));
  assert.ok(!existsSync(path.join(target, ".factory-daemon/factory-daemon.mjs")));
  // Start wrapper points at the installed daemon script.
  const startSh = await fs.readFile(path.join(target, ".factory-daemon/start.sh"), "utf8");
  assert.match(startSh, /node_modules\/software-factory-cli\/scripts\/factory-daemon\.mjs/);
  t.diagnostic("install, reinstall, dependency setup and credential preservation passed");

  // Smoke-check the installed CLI starts a polling daemon. We do NOT
  // exercise the LLM-backed pipeline here — that needs real model
  // credentials and is covered by integration tests against a real
  // endpoint.
  const safe = ["--no-env-file", "--no-fallback-env", "--workdir", path.join(root, "work")];
  const inbox = path.join(root, "inbox");
  await fs.mkdir(inbox);
  const started = spawn(process.execPath, ["--", cli, "start", "--once", "--local-dir", inbox, ...safe], { cwd: target, env, stdio: ["ignore", "pipe", "pipe"] });
  const startedOutput = [];
  started.stdout.on("data", (b) => startedOutput.push(b));
  started.stderr.on("data", (b) => startedOutput.push(b));
  const startedExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, signal: null }), 8000);
    started.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  const combined = Buffer.concat(startedOutput).toString();
  assert.match(combined, /Reading factory state|factory-daemon\.mjs|factory/i, `daemon must start; got: ${combined.slice(0, 400)}`);
  if (started.exitCode === null && startedExit.code === null) {
    if (process.platform === "win32") {
      await exec("taskkill", ["/PID", String(started.pid), "/T", "/F"]).catch(() => {});
    } else {
      started.kill("SIGTERM");
    }
  }
  t.diagnostic("bundled CLI starts polling without crashing");

  for (const combinedPanel of [false, true]) {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const command = combinedPanel
      ? ["start", "--panel", "--port", String(port), "--local-dir", inbox, ...safe]
      : ["panel", "--port", String(port), "--target", target];
    panel = spawn(process.execPath, [cli, ...command], { cwd: combinedPanel ? target : root, env, stdio: ["ignore", "pipe", "pipe"] });
    let panelOutput = "";
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`panel startup timeout: ${panelOutput}`)), 10000);
      panel.on("error", (error) => { clearTimeout(timer); reject(error); });
      panel.on("exit", () => { clearTimeout(timer); reject(new Error(`panel exited: ${panelOutput}`)); });
      panel.stdout.on("data", (chunk) => {
        panelOutput += chunk;
        if (panelOutput.includes("Reading factory state")) { clearTimeout(timer); resolve(); }
      });
      panel.stderr.on("data", (chunk) => { panelOutput += chunk; });
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.projects[0].name, "target repo");
    const agents = await (await fetch(`http://127.0.0.1:${port}/api/agents`)).json();
    assert.equal(agents.agents.length, 6);
    assert.ok(agents.agents.every((agent) => agent.stage && agent.label && agent.skillBody));
    assert.ok(agents.agents.every((agent) => agent.mode === "llm"), "every agent must report the only supported mode");
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);
    await stopPanel();
    panel = undefined;
  }
  t.diagnostic("standalone panel and start --panel HTTP checks passed");
});
