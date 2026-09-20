/**
 * Spec `2026-09-20-decision-architecture` follow-up / Bug 2 regression.
 *
 * Direct unit test of `clearNeedsInfoWakeIfTriageAdvanced` (exported
 * from `scripts/factory-daemon.mjs`). The CLI smoke in
 * `test/needs-info-wake-clear.test.mjs` proves the integration; this
 * test proves the helper's predicate in isolation so it cannot regress
 * under a future change to the polling loop.
 *
 * The helper has three observable behaviours:
 *   1. removes `needs-info-wake-<n>` when summary.triageResult.label
 *      is set and !== "needs-info";
 *   2. leaves the marker untouched when triage did not run
 *      (summary.triageResult missing) — the wake must remain armed;
 *   3. leaves the marker untouched when triage decided
 *      `needs-info` itself — the wake is already in the right state.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const factoryRoot = path.resolve(__dirname, "..");

const helperModule = await import(
    pathToFileURL(path.join(factoryRoot, "scripts", "needs-info-wake.mjs")).href
);
const { clearNeedsInfoWakeIfTriageAdvanced } = helperModule;

async function makeTmpDir(prefix) {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("removes needs-info-wake-<n> when triage decided ready-to-implement", async () => {
    const stateDir = await makeTmpDir("wake-clear-impl-");
    try {
        const wakeFile = path.join(stateDir, "needs-info-wake-1");
        await fs.writeFile(wakeFile, "2026-09-20T07:41:33Z");
        const result = clearNeedsInfoWakeIfTriageAdvanced(
            stateDir,
            1,
            { triageResult: { label: "ready-to-implement" }, nextLabel: "ready-to-implement" },
            () => undefined,
        );
        assert.equal(result.removed, true);
        assert.equal(result.markerExisted, true);
        assert.equal(result.triageLabel, "ready-to-implement");
        assert.equal(result.finalLabel, "ready-to-implement");
        await assert.rejects(fs.stat(wakeFile), /ENOENT/);
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("removes the marker when triage decided ready-to-spec too", async () => {
    const stateDir = await makeTmpDir("wake-clear-spec-");
    try {
        const wakeFile = path.join(stateDir, "needs-info-wake-7");
        await fs.writeFile(wakeFile, "2026-09-20T07:41:33Z");
        const result = clearNeedsInfoWakeIfTriageAdvanced(
            stateDir,
            7,
            { triageResult: { label: "ready-to-spec" }, nextLabel: "ready-to-spec" },
            () => undefined,
        );
        assert.equal(result.removed, true);
        await assert.rejects(fs.stat(wakeFile), /ENOENT/);
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("leaves the marker untouched when summary.triageResult is missing", async () => {
    const stateDir = await makeTmpDir("wake-clear-missing-");
    try {
        const wakeFile = path.join(stateDir, "needs-info-wake-2");
        await fs.writeFile(wakeFile, "2026-09-20T07:41:33Z");
        const result = clearNeedsInfoWakeIfTriageAdvanced(
            stateDir,
            2,
            { nextLabel: "needs-info" },
            () => undefined,
        );
        assert.equal(result.removed, false);
        assert.equal(result.triageLabel, null);
        await fs.stat(wakeFile); // still present
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("leaves the marker untouched when triage itself decided needs-info", async () => {
    const stateDir = await makeTmpDir("wake-clear-stay-");
    try {
        const wakeFile = path.join(stateDir, "needs-info-wake-3");
        await fs.writeFile(wakeFile, "2026-09-20T07:41:33Z");
        const result = clearNeedsInfoWakeIfTriageAdvanced(
            stateDir,
            3,
            { triageResult: { label: "needs-info" }, nextLabel: "needs-info" },
            () => undefined,
        );
        assert.equal(result.removed, false);
        assert.equal(result.triageLabel, "needs-info");
        await fs.stat(wakeFile);
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("emits a needs-info-wake-cleared log entry with triageLabel and finalLabel", async () => {
    const stateDir = await makeTmpDir("wake-clear-log-");
    try {
        const wakeFile = path.join(stateDir, "needs-info-wake-4");
        await fs.writeFile(wakeFile, "2026-09-20T07:41:33Z");
        const captured = [];
        const fakeLogger = (level, event, payload) => captured.push({ level, event, payload });
        const result = clearNeedsInfoWakeIfTriageAdvanced(
            stateDir,
            4,
            { triageResult: { label: "ready-to-implement" }, nextLabel: "needs-info" },
            fakeLogger,
        );
        assert.equal(result.removed, true);
        const entry = captured.find((c) => c.event === "needs-info-wake-cleared");
        assert.ok(entry, `expected needs-info-wake-cleared log; captured=${JSON.stringify(captured)}`);
        assert.equal(entry.level, "INFO");
        assert.equal(entry.payload.issue, 4);
        assert.equal(entry.payload.triageLabel, "ready-to-implement");
        assert.equal(entry.payload.finalLabel, "needs-info");
        assert.equal(entry.payload.markerExisted, true);
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});

test("treats triageResult.label='' (empty) as missing", async () => {
    const stateDir = await makeTmpDir("wake-clear-empty-");
    try {
        const wakeFile = path.join(stateDir, "needs-info-wake-5");
        await fs.writeFile(wakeFile, "2026-09-20T07:41:33Z");
        const result = clearNeedsInfoWakeIfTriageAdvanced(
            stateDir,
            5,
            { triageResult: { label: "" }, nextLabel: "needs-info" },
            () => undefined,
        );
        assert.equal(result.removed, false);
        assert.equal(result.triageLabel, null);
        await fs.stat(wakeFile);
    } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
    }
});
