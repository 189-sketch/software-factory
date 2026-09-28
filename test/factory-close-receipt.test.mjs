/**
 * CLI integration tests for the Session Close Receipt (issue #1).
 *
 * These run a real `factory start` against throwaway target repos and assert
 * the persisted `<stateDir>/sessions/<id>-close.json` artifact and its paired
 * `session-closed <sessionId> <exitReason>` log line. They complement the
 * pure-logic unit tests in close-receipt.test.mjs.
 *
 * Coverage maps to the spec validation plan:
 *   - two `--once` runs  → items #2 (chronological, non-overwriting, log pairing)
 *   - `--state-dir`      → item #7 (receipts follow the resolved state dir)
 *   - dir name           → item #6 (singular `.factory/sessions/`, never `.factories`)
 *   - misconfigured LLM  → the `failed`/exit-handler branch on every platform
 *   - SIGTERM            → item #3 (signaled receipt); POSIX-only, see below
 *
 * Platform note: on Windows, an externally sent signal force-terminates the
 * child (TerminateProcess is uncatchable), so the cross-process SIGTERM test
 * is skipped there on purpose. The `signaled` classification and atomic write
 * are still covered on every platform by close-receipt.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const factoryCli = path.join(repoRoot, "bin", "factory.js");
const requiredFields = ["sessionId", "mode", "startedAt", "endedAt", "durationMs", "exitCode", "exitReason", "issueNumber", "stateFile"];

/** A minimal, actually-valid-looking env that seals off real credentials. */
function sealedEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^(FACTORY_|ANTHROPIC_|GH_|GITHUB_|NODE_OPTIONS$)/i.test(key)) delete env[key];
    }
    env.ANTHROPIC_AUTH_TOKEN = "test-token";
    env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
    env.ANTHROPIC_MODEL = "test-model";
    return env;
}

function makeTarget(stateDir) {
    const root = os.tmpdir();
    const target = path.join(root, `receipt-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(target, { recursive: true });
    const emptyInbox = path.join(target, "inbox");
    mkdirSync(emptyInbox, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    // Pre-seed the 24h daily-improvement cooldown so a `--once` run stays a
    // clean idle (otherwise the improve stage would fire and mark `processed`).
    writeFileSync(path.join(stateDir, "last-improve-review-pr"), new Date().toISOString());
    return { target, emptyInbox };
}

function runFactory(args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--", factoryCli, ...args], {
            stdio: ["ignore", "pipe", "pipe"],
            env: opts.env ?? sealedEnv(),
            cwd: opts.cwd,
        });
        let out = "";
        child.stdout.on("data", (b) => { out += b.toString(); });
        child.stderr.on("data", (b) => { out += b.toString(); });
        const timer = setTimeout(() => {
            try { if (process.platform === "win32") { spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]); } else { child.kill("SIGKILL"); } } catch { /* noop */ }
            reject(new Error(`factory start did not exit in time:\n${out.slice(0, 2000)}`));
        }, opts.timeoutMs ?? 15000);
        child.on("error", reject);
        child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, out }); });
    });
}

function listReceipts(stateDir) {
    const dir = path.join(stateDir, "sessions");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => n.endsWith("-close.json")).sort();
}

function readReceipt(stateDir, name) {
    return JSON.parse(readFileSync(path.join(stateDir, "sessions", name), "utf8"));
}

function sessionClosedLines(stateDir) {
    const logPath = path.join(stateDir, "daemon.log");
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8").split(/\r?\n/).filter((l) => /^session-closed \S+ \S+$/.test(l));
}

test("two consecutive `factory start --once` runs write two sorted receipts", async (t) => {
    const stateDir = path.join(os.tmpdir(), `receipt-two-${Date.now()}`);
    const { target, emptyInbox } = makeTarget(stateDir);
    t.after(() => rmSync(target, { recursive: true, force: true }));

    const first = await runFactory(["start", "--once", "--state-dir", stateDir, "--local-dir", emptyInbox, "--no-env-file", "--no-fallback-env"], { cwd: target });
    assert.equal(first.code, 0, `--once idle must exit 0:\n${first.out.slice(0, 2000)}`);
    const afterFirst = listReceipts(stateDir);
    assert.equal(afterFirst.length, 1, "exactly one receipt after the first run");

    const second = await runFactory(["start", "--once", "--state-dir", stateDir, "--local-dir", emptyInbox, "--no-env-file", "--no-fallback-env"], { cwd: target });
    assert.equal(second.code, 0, `--once idle must exit 0:\n${second.out.slice(0, 2000)}`);
    const afterSecond = listReceipts(stateDir);
    assert.equal(afterSecond.length, 2, "a second file, the first not overwritten");

    // Receipts sort chronologically; the second run is strictly later.
    const sorted = [...afterSecond].sort();
    assert.deepEqual(afterSecond, sorted, "names sorted == listing order");
    assert.ok(afterFirst[0] < sorted[1], "second run did not overwrite the first and sorts later");

    for (const name of afterSecond) {
        const r = readReceipt(stateDir, name);
        for (const field of requiredFields) assert.ok(r[field] !== undefined, `${name} missing ${field}`);
        assert.equal(r.exitReason, "idle");
        assert.equal(r.issueNumber, null);
        assert.equal(r.stateFile, null);
        assert.equal(r.mode, "once");
        assert.ok(Number.isInteger(r.durationMs) && r.durationMs >= 0);
        // Exactly one pairing log line per receipt.
        const matching = sessionClosedLines(stateDir).filter((l) => l === `session-closed ${r.sessionId} idle`);
        assert.equal(matching.length, 1, `one session-closed line for ${r.sessionId}`);
    }
    assert.equal(sessionClosedLines(stateDir).length, 2, "one log line per receipt");
});

test("receipts follow --state-dir and land nowhere else", async (t) => {
    const altStateDir = path.join(os.tmpdir(), `alt-state-${Date.now()}`);
    const { target, emptyInbox } = makeTarget(altStateDir);
    t.after(() => rmSync(target, { recursive: true, force: true }));

    const run = await runFactory(["start", "--once", "--state-dir", altStateDir, "--local-dir", emptyInbox, "--no-env-file", "--no-fallback-env"], { cwd: target });
    assert.equal(run.code, 0, run.out.slice(0, 2000));

    const receipts = listReceipts(altStateDir);
    assert.equal(receipts.length, 1, "receipt under the resolved alt state dir");
    assert.ok(!existsSync(path.join(target, ".factory", "sessions")), "no default .factory/sessions is created when --state-dir is set");
});

test("the default sessions directory is singular `.factory/sessions/`, never `.factories`", async (t) => {
    // Run with NO --state-dir so the resolved state dir is the default
    // `.factory` inside the target cwd. This pins the reviewed path-typo
    // regression (plural `.factories` was rejected in spec review).
    const target = path.join(os.tmpdir(), `receipt-name-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const emptyInbox = path.join(target, "inbox");
    const stateDir = path.join(target, ".factory");
    mkdirSync(emptyInbox, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "last-improve-review-pr"), new Date().toISOString());
    t.after(() => rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

    const run = await runFactory(["start", "--once", "--local-dir", emptyInbox, "--no-env-file", "--no-fallback-env"], { cwd: target });
    assert.equal(run.code, 0, run.out.slice(0, 2000));

    const receipts = listReceipts(stateDir);
    assert.equal(receipts.length, 1, "receipt under the default .factory/sessions/");
    assert.equal(path.basename(stateDir), ".factory", "resolved default state dir is singular .factory");
    assert.equal(path.basename(path.dirname(stateDir)), path.basename(target), "the state dir is `.factory` inside the target root");

    // The plural form (or any other variant) must never be produced.
    const siblings = readdirSync(target);
    assert.ok(siblings.includes(".factory"), "`.factory` exists in the target root");
    for (const bad of [".factories", "factories"]) {
        assert.ok(!siblings.includes(bad), `the ${bad} variant must never be produced`);
    }
});

test("a misconfigured run still emits a `failed` receipt on every platform", async (t) => {
    const stateDir = path.join(os.tmpdir(), `receipt-failed-${Date.now()}`);
    const { target, emptyInbox } = makeTarget(stateDir);
    t.after(() => rmSync(target, { recursive: true, force: true }));

    // No LLM configuration + fallbacks disabled → daemon exits non-zero via
    // the standard exit handler, which must still produce exactly one receipt.
    const bareEnv = { ...sealedEnv() };
    delete bareEnv.ANTHROPIC_AUTH_TOKEN;
    delete bareEnv.ANTHROPIC_BASE_URL;
    delete bareEnv.ANTHROPIC_MODEL;

    const run = await runFactory(["start", "--once", "--state-dir", stateDir, "--local-dir", emptyInbox, "--no-env-file", "--no-fallback-env"], { cwd: target, env: bareEnv });
    assert.notEqual(run.code, 0, "misconfigured run must exit non-zero");

    const receipts = listReceipts(stateDir);
    assert.equal(receipts.length, 1, "exactly one receipt on the failed path");
    const r = readReceipt(stateDir, receipts[0]);
    assert.equal(r.exitReason, "failed");
    assert.equal(r.exitCode, run.code);
    const lines = sessionClosedLines(stateDir).filter((l) => l === `session-closed ${r.sessionId} failed`);
    assert.equal(lines.length, 1);
});

test("SIGTERM to a continuous run yields one `signaled` receipt", { skip: process.platform === "win32" ? "Windows force-kills child processes; graceful SIGTERM delivery is POSIX-only (see module note)" : false }, async (t) => {
    const stateDir = path.join(os.tmpdir(), `receipt-sig-${Date.now()}`);
    const { target, emptyInbox } = makeTarget(stateDir);
    t.after(() => rmSync(target, { recursive: true, force: true }));

    const child = spawn(process.execPath, ["--", factoryCli, "start", "--state-dir", stateDir, "--local-dir", emptyInbox, "--interval", "1", "--no-env-file", "--no-fallback-env"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: sealedEnv(),
        cwd: target,
    });
    let out = "";
    child.stdout.on("data", (b) => { out += b.toString(); });
    child.stderr.on("data", (b) => { out += b.toString(); });

    // Let it enter the polling loop, then SIGTERM the CLI (it forwards to the daemon).
    await new Promise((r) => setTimeout(r, 2000));
    child.kill("SIGTERM");

    const exit = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`factory start did not exit after SIGTERM:\n${out.slice(0, 2000)}`)), 10000);
        child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });

    const receipts = listReceipts(stateDir);
    assert.equal(receipts.length, 1, "exactly one receipt after SIGTERM teardown");
    const r = readReceipt(stateDir, receipts[0]);
    assert.equal(r.exitReason, "signaled", "SIGTERM must translate to a signaled close");
    assert.equal(r.exitCode, 143, "translated exit code is 128+SIGTERM(15)");
    assert.equal(r.mode, "continuous");
    const lines = sessionClosedLines(stateDir).filter((l) => l === `session-closed ${r.sessionId} signaled`);
    assert.equal(lines.length, 1, "session-closed <id> signaled logged once");
    void exit;
});
