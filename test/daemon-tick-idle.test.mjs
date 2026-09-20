/**
 * Spec `2026-09-20-decision-architecture` / Phase E / T11.x bug-fix test.
 *
 * Bug: when `freshnessOutcomes` is empty (no issues fetched this tick —
 * either an empty inbox or an empty GitHub issue list) the polling
 * loop's `daemon-tick` log line still reports `"health":0` because
 * `computeHealthJs({spec:0, impl:0, review:0, verify:0})` returns 0.
 * Operators reading the daemon log interpret that as "system
 * unhealthy" even though the daemon is just idle.
 *
 * Fix: when there are no freshness outcomes the daemon-tick log line
 * carries `"idle":true` and omits the composite `health` value
 * (or sets it to `null`). The composite health field only carries a
 * numeric score when there is actual data to score.
 *
 * The complementary default-on assertion (seeded inbox → `daemon-tick`
 * carries a numeric `"health":`) lives in `test/freshness-poc-cli.test.mjs`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const factoryRoot = path.resolve(__dirname, "..");

async function makeTmpDir(prefix) {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function runDaemon({ stateDir, workdir, env, args = [] }) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [path.join(factoryRoot, "scripts", "factory-daemon.mjs"), "--once", ...args],
            {
                cwd: factoryRoot,
                env: {
                    ...process.env,
                    ...env,
                    FACTORY_LOCAL_DIR: env.FACTORY_LOCAL_DIR ?? path.join(os.tmpdir(), "empty-inbox-" + Date.now()),
                    FACTORY_STATE_DIR: stateDir,
                    FACTORY_WORKDIR: workdir,
                    FACTORY_GH_REPO: "",
                    GH_TOKEN: "",
                    GITHUB_TOKEN: "",
                    ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN ?? "sk-test",
                    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL ?? "http://localhost:0",
                    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL ?? "claude-test",
                    FACTORY_TYPESAFE_OFF: env.FACTORY_TYPESAFE_OFF ?? "1",
                    TYPESAFE_API_KEY: env.TYPESAFE_API_KEY ?? "",
                    FACTORY_DECISIONS_ENABLED: env.FACTORY_DECISIONS_ENABLED ?? "1",
                    FACTORY_NO_FALLBACK_ENV: "1",
                    FACTORY_TRUSTED_EXECUTION: "1",
                    FACTORY_EXECUTION_ADAPTER: "docker",
                    FACTORY_DOCKER_IMAGE: "scratch",
                },
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (b) => { stdout += b.toString(); });
        child.stderr.on("data", (b) => { stderr += b.toString(); });
        child.on("error", reject);
        const timeout = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch {}
        }, 10_000);
        child.on("exit", (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal, stdout, stderr });
        });
    });
}

test("daemon-tick marks idle ticks with idle:true and omits numeric health when there are no issues to check", async () => {
    // Empty inbox — no issue JSON files. Combined with FACTORY_GH_REPO=""
    // and GH_TOKEN="" this guarantees `fetchNextIssue()` returns null and
    // `freshnessOutcomes` is empty for the entire tick.
    const inbox = await makeTmpDir("daemon-tick-idle-inbox-");
    const stateDir = await makeTmpDir("daemon-tick-idle-state-");
    const workdir = await makeTmpDir("daemon-tick-idle-workdir-");

    try {
        const result = await runDaemon({
            inbox,
            stateDir,
            workdir,
            env: {
                FACTORY_POLL_INTERVAL: "1",
                FACTORY_LOCAL_DIR: inbox,
            },
        });

        const combined = `${result.stdout}\n${result.stderr}`;

        // The daemon should still emit a daemon-tick log line — it is
        // the heartbeat. (decisions-enabled-gate.test.mjs covers the
        // case where the whole tick is suppressed by the opt-out.)
        assert.match(
            combined,
            /daemon-tick/,
            `daemon must emit a daemon-tick log per cycle. Saw:\n${combined}`,
        );

        // Idle ticks MUST carry `idle:true` so an operator can tell
        // "no work" apart from "all freshness checks failed".
        assert.match(
            combined,
            /daemon-tick[^\n]*"idle":true/,
            `idle daemon-tick must carry idle:true. Saw:\n${combined}`,
        );

        // Idle ticks MUST NOT carry a misleading `"health":0` (or any
        // other numeric health value) — there is nothing to score.
        assert.doesNotMatch(
            combined,
            /daemon-tick[^\n]*"health":\s*-?\d/,
            `idle daemon-tick must not carry a numeric health score. Saw:\n${combined}`,
        );

        // And `fetched:0` so an operator can also confirm the count.
        assert.match(
            combined,
            /daemon-tick[^\n]*"fetched":0/,
            `idle daemon-tick must report fetched:0. Saw:\n${combined}`,
        );
    } finally {
        await fs.rm(inbox, { recursive: true, force: true });
        await fs.rm(stateDir, { recursive: true, force: true });
        await fs.rm(workdir, { recursive: true, force: true });
    }
});
