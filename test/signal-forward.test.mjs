/**
 * Verifies the factory CLI's `start` command actually forwards signals
 * to the spawned daemon child. Without this, daemon processes survive
 * Ctrl+C on POSIX and become zombies.
 *
 * Strategy: spawn `factory start --interval 1` (shortest possible poll
 * interval so the daemon stays busy) and send SIGTERM after a short
 * delay. The parent must exit within 7s; the daemon child must also
 * exit. We verify by checking that no factory-daemon.mjs process is
 * still alive afterward.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const factoryCli = path.resolve(__dirname, "..", "bin", "factory.js");

function listDaemonPids() {
    try {
        const stdout = execFileSync(
            process.platform === "win32" ? "tasklist" : "ps",
            process.platform === "win32"
                ? ["/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"]
                : ["-eo", "pid,command"],
            { encoding: "utf-8" },
        );
        const lines = stdout.split(/\r?\n/).filter((l) => /factory-daemon/.test(l));
        return lines.length;
    } catch {
        return 0;
    }
}

test("factory start forwards SIGTERM to daemon and both exit", async () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "factory-signal-"));
    const before = listDaemonPids();
    const child = spawn(process.execPath, [
        factoryCli,
        "start",
        "--interval",
        "1",
        "--local-dir",
        path.join(fixtureDir, "issues"),
        "--state-dir",
        path.join(fixtureDir, "state"),
        "--no-env-file",
        "--no-fallback-env",
    ], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            ...process.env,
            FACTORY_POLL_INTERVAL: "1",
            ANTHROPIC_AUTH_TOKEN: "test-token",
            ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
            ANTHROPIC_MODEL: "test-model",
        },
    });

    // Capture stdout/stderr so a failing test can print them.
    const chunks = [];
    child.stdout.on("data", (b) => chunks.push(b));
    child.stderr.on("data", (b) => chunks.push(b));
    const exited = new Promise((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    // Let the daemon start.
    await new Promise((r) => setTimeout(r, 1500));

    // SIGTERM the parent; it must propagate.
    assert.equal(child.exitCode, null, `parent exited before SIGTERM:\n${Buffer.concat(chunks).toString()}`);
    assert.ok(child.kill("SIGTERM"), "SIGTERM could not be sent to parent");

    // Parent should exit within 7s. Daemon child must exit too.
    let timeout;
    try {
        await Promise.race([
            exited,
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error(`parent did not exit within 7s:\n${Buffer.concat(chunks).toString()}`)), 7000);
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }

    // Give the daemon child up to 5s to exit too.
    await new Promise((r) => setTimeout(r, 5000));

    const after = listDaemonPids();
    assert.ok(
        after <= before,
        `daemon processes leaked: before=${before} after=${after}\noutput:\n${Buffer.concat(chunks).toString()}`,
    );
    rmSync(fixtureDir, { recursive: true, force: true });
});
