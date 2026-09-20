/**
 * Spec `2026-09-20-decision-architecture` / Phase E / T11.1 smoke.
 *
 * Production-flip escape hatch: with `FACTORY_DECISIONS_ENABLED=0` the
 * daemon must bypass the freshnessCheck step entirely and restore the
 * original `fetchNextIssue → enqueueIssue` flow:
 *
 *   - NO `judgment.skip` log lines;
 *   - NO `daemon-tick` health line (per-tick health accounting belongs
 *     to the decision-routing surface);
 *   - `process-issue-start` STILL appears (the issue is enqueued);
 *   - the `daemon-start` log shows `"decisionsEnabled":false`.
 *
 * Same local-inbox harness as `test/freshness-poc-cli.test.mjs` (T8.4):
 * `--once` bounds the run to a single tick, `FACTORY_TYPESAFE_OFF=1`
 * keeps the freshness module offline, and the assertions are on LOG
 * content — the worker itself fails fast against the docker `scratch`
 * stub, which is irrelevant here.
 *
 * The complementary default-on assertions (`decisionsEnabled: true`,
 * `daemon-tick` present) live in `test/freshness-poc-cli.test.mjs`.
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

function runDaemon({ inbox, stateDir, workdir, env, args = [] }) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [path.join(factoryRoot, "scripts", "factory-daemon.mjs"), "--once", ...args],
            {
                cwd: factoryRoot,
                env: {
                    ...process.env,
                    ...env,
                    FACTORY_LOCAL_DIR: inbox,
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

test("FACTORY_DECISIONS_ENABLED=0 bypasses freshnessCheck: no judgment.skip, no daemon-tick, enqueue path intact, daemon-start shows decisionsEnabled:false", async () => {
    const inbox = await makeTmpDir("decisions-gate-inbox-");
    const stateDir = await makeTmpDir("decisions-gate-state-");
    const workdir = await makeTmpDir("decisions-gate-workdir-");

    try {
        const issueBody = {
            number: 1,
            title: "T11.1 decisions gate opt-out smoke",
            body: "验证 FACTORY_DECISIONS_ENABLED=0 时原始 enqueue 路径保持不变。",
            labels: [],
            author: "operator",
            url: "",
            createdAt: "2026-09-20T10:00:00Z",
            comments: [],
        };
        await fs.writeFile(path.join(inbox, "001.json"), JSON.stringify(issueBody, null, 2));

        const result = await runDaemon({
            inbox,
            stateDir,
            workdir,
            env: {
                FACTORY_POLL_INTERVAL: "1",
                // The opt-out under test.
                FACTORY_DECISIONS_ENABLED: "0",
                FACTORY_TYPESAFE_OFF: "1",
            },
        });

        const combined = `${result.stdout}\n${result.stderr}`;

        // Gate state is visible in the daemon-start log.
        assert.match(
            combined,
            /daemon-start[^\n]*"decisionsEnabled":false/,
            `daemon-start must log decisionsEnabled:false when FACTORY_DECISIONS_ENABLED=0. Saw:\n${combined}`,
        );

        // No decision-routing surface: no judgment.skip, no daemon-tick health.
        assert.doesNotMatch(
            combined,
            /judgment\.skip/,
            `FACTORY_DECISIONS_ENABLED=0 must not emit judgment.skip logs. Saw:\n${combined}`,
        );
        assert.doesNotMatch(
            combined,
            /daemon-tick/,
            `FACTORY_DECISIONS_ENABLED=0 must not emit the daemon-tick health line. Saw:\n${combined}`,
        );

        // Original enqueue path preserved.
        assert.match(
            combined,
            /process-issue-start/,
            `daemon must still enqueue and log process-issue-start with the gate off. Saw:\n${combined}`,
        );
    } finally {
        await fs.rm(inbox, { recursive: true, force: true });
        await fs.rm(stateDir, { recursive: true, force: true });
        await fs.rm(workdir, { recursive: true, force: true });
    }
});
