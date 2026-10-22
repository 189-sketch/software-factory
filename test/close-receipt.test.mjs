/**
 * Unit tests for the Session Close Receipt helper (issue #1).
 *
 * Exercises every ExitReason branch, the enum guard, the stateFile
 * invariant, the required-field-only verifier contract, the atomic
 * tmp-then-rename write, and a fault injection that simulates a SIGKILL
 * between the tmp write and the rename. No daemon is booted here — the
 * integration tests under factory-close-receipt.test.mjs cover `factory
 * start` end-to-end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import {
    EXIT_REASONS,
    REQUIRED_FIELDS,
    isValidExitReason,
    classifyExit,
    makeSessionId,
    composeCloseReceipt,
    writeCloseReceipt,
    beginSession,
} from "../scripts/session-close-receipt.mjs";

function tmpStateDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-unit-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** Mirrors the spec's "verifier asserts only the required-field set". */
function missingRequiredFields(receipt) {
    return REQUIRED_FIELDS.filter((field) => receipt[field] === undefined);
}

function sample(overrides = {}) {
    const startedAt = new Date("2025-01-15T12:00:00.000Z");
    return {
        sessionId: makeSessionId(startedAt, 1234),
        mode: "once",
        startedAt,
        endedAt: new Date("2025-01-15T12:00:02.500Z"),
        exitCode: 0,
        exitReason: "idle",
        issueNumber: null,
        stateFile: null,
        pid: 1234,
        factoryVersion: "0.1.2",
        ...overrides,
    };
}

test("EXIT_REASONS is the closed set and the guard accepts only its members", () => {
    assert.deepEqual([...EXIT_REASONS], ["idle", "processed", "failed", "signaled"]);
    for (const reason of EXIT_REASONS) assert.equal(isValidExitReason(reason), true, reason);
    for (const bad of ["", "idle ", "processed2", "cloud", null, undefined, 42]) {
        assert.equal(isValidExitReason(bad), false, JSON.stringify(bad));
    }
});

test("classifyExit maps existing facts to the four reasons and translates signals", () => {
    assert.deepEqual(classifyExit({ exitCode: 0, issueNumber: null }), { exitReason: "idle", exitCode: 0 });
    assert.deepEqual(classifyExit({ exitCode: 0, issueNumber: 7 }), { exitReason: "processed", exitCode: 0 });
    assert.deepEqual(classifyExit({ exitCode: 1 }), { exitReason: "failed", exitCode: 1 });
    assert.deepEqual(classifyExit({ exitCode: 42 }), { exitReason: "failed", exitCode: 42 });
    // signaled short-circuits everything, using the POSIX 128+signum convention.
    assert.deepEqual(classifyExit({ signaled: true, signum: "SIGTERM", exitCode: 0, issueNumber: 7 }),
        { exitReason: "signaled", exitCode: 143 });
    assert.deepEqual(classifyExit({ signaled: true, signum: "SIGINT" }), { exitReason: "signaled", exitCode: 130 });
    // coerces junk exit codes to 0 so a missing process.exitCode reads as a clean exit.
    assert.equal(classifyExit({ exitCode: undefined }).exitReason, "idle");
});

test("makeSessionId is filesystem-safe and chronologically sortable", () => {
    const a = makeSessionId(new Date("2025-01-15T12:00:01.100Z"), 111);
    const b = makeSessionId(new Date("2025-01-15T12:00:09.900Z"), 222);
    assert.ok(!a.includes(":"), "must be legal as a Windows filename");
    assert.ok(!a.includes("."), "no dot besides the file suffix keeps ls stable");
    assert.ok(a < b, "later start must sort after earlier start");
    assert.notEqual(a, b);
});

test("composeCloseReceipt builds a valid receipt a required-only verifier accepts", () => {
    const receipt = composeCloseReceipt(sample({ exitReason: "processed", issueNumber: 7, stateFile: "/abs/.factory/state-7.json", exitCode: 0 }));
    assert.deepEqual(missingRequiredFields(receipt), []);
    assert.equal(receipt.durationMs, 2500);
    assert.equal(Number.isInteger(receipt.durationMs) && receipt.durationMs >= 0, true);
    // extras are preserved but never required.
    assert.equal(receipt.pid, 1234);
    assert.equal(receipt.factoryVersion, "0.1.2");
    // A verifier that only knows the required set still passes on the shipped shape.
    assert.deepEqual(missingRequiredFields({ ...receipt, pid: undefined, factoryVersion: undefined }), []);
});

test("composeCloseReceipt rejects an unknown exitReason before any disk write", () => {
    assert.throws(() => composeCloseReceipt(sample({ exitReason: "cloud" })), /invalid exitReason/);
    assert.throws(() => composeCloseReceipt(sample({ mode: "cloud" })), /mode must be/);
    assert.throws(() => composeCloseReceipt(sample({ issueNumber: "7" })), /issueNumber/);
    assert.throws(() => composeCloseReceipt(sample({ exitCode: 1.5 })), /exitCode/);
});

test("composeCloseReceipt enforces the stateFile invariant (idle=null, processed=absolute)", () => {
    // idle ⇒ null
    assert.throws(() => composeCloseReceipt(sample({ exitReason: "idle", stateFile: "/abs/x.json" })), /idle receipt must carry stateFile null/);
    // processed ⇒ absolute path
    assert.throws(() => composeCloseReceipt(sample({ exitReason: "processed", issueNumber: 7, stateFile: null })), /processed receipt must carry an absolute/);
    assert.throws(() => composeCloseReceipt(sample({ exitReason: "processed", issueNumber: 7, stateFile: "relative/state-7.json" })), /absolute/);
    // positive cases
    assert.equal(composeCloseReceipt(sample({ exitReason: "processed", issueNumber: 7, stateFile: path.resolve("state-7.json") })).stateFile, path.resolve("state-7.json"));
    // failed may carry stateFile or null (invariant only pins idle/processed)
    assert.equal(composeCloseReceipt(sample({ exitReason: "failed", exitCode: 1, stateFile: null })).exitReason, "failed");
});

test("writeCloseReceipt persists atomically under sessions/ and emits one session-closed log line", (t) => {
    const stateDir = tmpStateDir(t);
    const receipt = composeCloseReceipt(sample({ exitReason: "idle" }));

    const written = writeCloseReceipt(receipt, stateDir);

    assert.equal(written, path.join(stateDir, "sessions", `${receipt.sessionId}-close.json`));
    // singular `.factory` name is guaranteed by callers; here just confirm the
    // sessions subdirectory and the -close.json suffix.
    assert.equal(path.basename(path.dirname(written)), "sessions");
    assert.ok(written.endsWith("-close.json"));

    // No temp file is left behind, and the committed file is valid JSON.
    const dir = path.join(stateDir, "sessions");
    const entries = fs.readdirSync(dir);
    assert.deepEqual(entries.filter((n) => n.endsWith(".tmp")), []);
    const onDisk = JSON.parse(fs.readFileSync(written, "utf8"));
    assert.deepEqual(missingRequiredFields(onDisk), []);

    // Exactly one session-closed line, matching the receipt.
    const logLines = fs.readFileSync(path.join(stateDir, "daemon.log"), "utf8").split(/\r?\n/).filter((l) => l.startsWith("session-closed "));
    assert.equal(logLines.length, 1);
    assert.equal(logLines[0], `session-closed ${receipt.sessionId} idle`);
});

test("a kill between tmp write and rename leaves no committed receipt", (t) => {
    const stateDir = tmpStateDir(t);
    const receipt = composeCloseReceipt(sample({ exitReason: "idle" }));

    // Simulate SIGKILL landing after the tmp write but before the rename:
    // the real writeFileSync runs, then renameSync throws.
    const io = {
        mkdirSync: fs.mkdirSync,
        writeFileSync: fs.writeFileSync,
        renameSync: () => { throw new Error("simulated hard kill mid-write"); },
        appendFileSync: fs.appendFileSync,
    };
    assert.throws(() => writeCloseReceipt(receipt, stateDir, io), /simulated hard kill/);

    // No -close.json for this session; only the abandoned temp file remains,
    // and no session-closed line was appended (append runs after rename).
    const dir = path.join(stateDir, "sessions");
    const finals = fs.readdirSync(dir).filter((n) => n.endsWith("-close.json"));
    assert.deepEqual(finals, []);
    assert.ok(fs.readdirSync(dir).some((n) => n.endsWith(".json.tmp")), "tmp payload is left, not a committed receipt");
    const log = fs.existsSync(path.join(stateDir, "daemon.log")) ? fs.readFileSync(path.join(stateDir, "daemon.log"), "utf8") : "";
    assert.ok(!log.includes(receipt.sessionId), "no session-closed line for the killed session");

    // The next successful run commits a complete receipt and the directory
    // holds no JSON-invalid committed file.
    const written = writeCloseReceipt(receipt, stateDir);
    JSON.parse(fs.readFileSync(written, "utf8"));
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith("-close.json"))) {
        assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
    }
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
});

test("beginSession composes one receipt per branch and is idempotent", (t) => {
    const originalExitCode = process.exitCode;
    t.after(() => { process.exitCode = originalExitCode; });

    const cases = [
        {
            name: "idle",
            setup: (s) => { process.exitCode = 0; },
            expect: (r) => { assert.equal(r.exitReason, "idle"); assert.equal(r.exitCode, 0); assert.equal(r.issueNumber, null); assert.equal(r.stateFile, null); },
        },
        {
            name: "processed",
            setup: (s) => { process.exitCode = 0; s.recordProcessed(7, path.join(s.__stateDir, "state-7.json")); },
            expect: (r) => {
                assert.equal(r.exitReason, "processed"); assert.equal(r.exitCode, 0);
                assert.equal(r.issueNumber, 7); assert.ok(path.isAbsolute(r.stateFile) && r.stateFile.endsWith("state-7.json"));
            },
        },
        {
            name: "failed",
            setup: (s) => { process.exitCode = 1; s.recordProcessed(7, path.join(s.__stateDir, "state-7.json")); },
            expect: (r) => { assert.equal(r.exitReason, "failed"); assert.equal(r.exitCode, 1); },
        },
        {
            name: "signaled",
            setup: (s) => { process.exitCode = 0; s.signal("SIGTERM"); },
            expect: (r) => { assert.equal(r.exitReason, "signaled"); assert.equal(r.exitCode, 143); },
        },
    ];

    for (const tc of cases) {
        const stateDir = tmpStateDir(t);
        const session = beginSession({ stateDir, mode: "once", startedAt: new Date() });
        session.__stateDir = stateDir;
        tc.setup(session);
        const written = session.emit();
        assert.ok(written, `${tc.name}: receipt written`);
        const receipt = JSON.parse(fs.readFileSync(written, "utf8"));
        assert.deepEqual(missingRequiredFields(receipt), []);
        assert.equal(receipt.mode, "once");
        tc.expect(receipt);

        // Idempotent: a second emit produces no additional file.
        assert.equal(session.emit(), null, "second emit is a no-op");
        const dir = path.join(stateDir, "sessions");
        assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith("-close.json")).length, 1);
    }
});
