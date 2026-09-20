/**
 * Spec `2026-09-20-decision-architecture` / Phase B / T8.4 smoke.
 *
 * Runs `scripts/factory-daemon.mjs` for ~10 s against a temporary
 * local-inbox directory with `FACTORY_TYPESAFE_OFF=1`, then asserts
 * the daemon emitted at least one `process-issue-start` log line.
 *
 * The intent is the regression gate from plan.md R7:
 *
 *   "T8.4 acceptance includes `npm run test:cli` plus a dedicated
 *    smoke that runs the daemon for 60 s with `FACTORY_TYPESAFE_OFF=1`
 *    (so every issue is enqueued) and asserts ≥ 1 `process-issue-start`
 *    log; the L1 unit test mocks `freshnessCheck` and asserts the
 *    original `fetchNextIssue → enqueueIssue` flow still works when
 *    the freshness module throws."
 *
 * We use a local-inbox directory so the test does not depend on
 * GitHub credentials or the daemon's lease / worker pipeline.
 * Each issue file is a small JSON payload shaped like a GitHub
 * issue; the daemon picks it up, runs the freshness check (which
 * returns `freshness_unavailable` because `TYPESAFE_API_KEY` is
 * missing AND the checkpoint is absent), persists the new
 * `lastJudgmentHash`, and proceeds to enqueue. The
 * `process-issue-start` log is the proof.
 *
 * The test uses `--once` so the daemon exits after one cycle, so
 * the wall-clock is bounded to a few seconds rather than the full
 * 60 s from the plan.
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
                    // Force the daemon into local-inbox mode so it
                    // does not need GitHub credentials.
                    FACTORY_LOCAL_DIR: inbox,
                    FACTORY_STATE_DIR: stateDir,
                    FACTORY_WORKDIR: workdir,
                    // No GitHub interaction — empty repo + empty token.
                    FACTORY_GH_REPO: "",
                    GH_TOKEN: "",
                    GITHUB_TOKEN: "",
                    // Required by the daemon's main(): AGENT_MODE is llm
                    // and `LLM_CONFIGURED` must hold.
                    ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN ?? "sk-test",
                    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL ?? "http://localhost:0",
                    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL ?? "claude-test",
                    // SPEC: T8.4 keeps the enqueue path reachable
                    // even when typesafe is unavailable.
                    FACTORY_TYPESAFE_OFF: env.FACTORY_TYPESAFE_OFF ?? "1",
                    TYPESAFE_API_KEY: env.TYPESAFE_API_KEY ?? "",
                    // T11.1 production flip: decision routing is LIVE
                    // BY DEFAULT. Pin the gate on for this smoke so an
                    // ambient FACTORY_DECISIONS_ENABLED=0 in the
                    // developer's shell cannot silently disable the
                    // freshness path under test. The opt-out (=0) is
                    // covered by test/decisions-enabled-gate.test.mjs.
                    FACTORY_DECISIONS_ENABLED: env.FACTORY_DECISIONS_ENABLED ?? "1",
                    // Belt + suspenders: avoid touching the real
                    // user's ~/.claude/settings.json fallback.
                    FACTORY_NO_FALLBACK_ENV: "1",
                    // The daily improvement pass runs first inside
                    // the polling loop; the worker refuses to spawn
                    // unless `FACTORY_TRUSTED_EXECUTION=1`. We don't
                    // care about the daily pass for this smoke (the
                    // `process-issue-start` log we assert on comes
                    // from the polling loop's issue pick-up, NOT
                    // from the worker), so we set the flag and let
                    // the worker die at the LLM-stub layer instead.
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
        // `process-issue-start` is logged INSIDE the polling loop
        // BEFORE `enqueueIssue` actually runs the worker. The worker
        // will try to spawn the LLM CLI and fail (no real LLM
        // configured); we don't care about the worker outcome,
        // only that the polling loop emitted `process-issue-start`.
        // 10 s is enough for one tick on a cold start.
        const timeout = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch {}
        }, 10_000);
        child.on("exit", (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal, stdout, stderr });
        });
    });
}

test("daemon enqueues at least one issue when FACTORY_TYPESAFE_OFF=1 (freshness unavailable, original path preserved)", async () => {
    const inbox = await makeTmpDir("freshness-poc-inbox-");
    const stateDir = await makeTmpDir("freshness-poc-state-");
    const workdir = await makeTmpDir("freshness-poc-workdir-");

    try {
        // Seed a single issue. The daemon reads JSON files from
        // `FACTORY_LOCAL_DIR` and processes them in lexical order.
        const issueBody = {
            number: 1,
            title: "T8.4 freshness PoC smoke",
            body: "Verify the original enqueue path still works with the freshness gate in front.",
            labels: [],
            author: "operator",
            url: "",
            createdAt: "2026-09-20T10:00:00Z",
            comments: [],
        };
        await fs.writeFile(
            path.join(inbox, "001.json"),
            JSON.stringify(issueBody, null, 2),
        );

        const result = await runDaemon({
            inbox,
            stateDir,
            workdir,
            env: {
                FACTORY_POLL_INTERVAL: "1",
            },
        });

        // Daemon exits with non-zero on pipeline failure (the LLM
        // worker will fail because the local backend is a stub).
        // We assert on the LOG content, not the exit code, because
        // `process-issue-start` is logged BEFORE the worker runs.
        const combined = `${result.stdout}\n${result.stderr}`;
        assert.match(
            combined,
            /process-issue-start/,
            `daemon must log at least one process-issue-start. Saw:\n${combined}`,
        );

        // The daemon MUST also emit a `daemon-tick` log line per cycle
        // (T8.4 acceptance bullet 4). The line carries the composite
        // `health` and the freshness stats; assert both are present.
        assert.match(
            combined,
            /daemon-tick/,
            `daemon must emit a daemon-tick log per cycle. Saw:\n${combined}`,
        );
        assert.match(
            combined,
            /"health":/,
            `daemon-tick log must carry the composite health value. Saw:\n${combined}`,
        );

        // T11.1 production flip: with the gate at its default (1), the
        // daemon-start log must advertise `decisionsEnabled: true` —
        // decision routing is live with no opt-in flag.
        assert.match(
            combined,
            /daemon-start[^\n]*"decisionsEnabled":true/,
            `daemon-start must log decisionsEnabled:true by default. Saw:\n${combined}`,
        );
    } finally {
        await fs.rm(inbox, { recursive: true, force: true });
        await fs.rm(stateDir, { recursive: true, force: true });
        await fs.rm(workdir, { recursive: true, force: true });
    }
});
