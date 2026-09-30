/**
 * Session Close Receipt — one canonical, machine-readable artifact per
 * factory daemon run.
 *
 * Every `factory start` invocation (both `--once` and continuous, with or
 * without a runnable issue, and including the SIGINT/SIGTERM → signaled
 * teardown path) writes exactly one receipt to:
 *
 *     <stateDir>/sessions/<sessionId>-close.json
 *
 * where the default `<stateDir>` is the daemon's resolved `.factory`
 * directory (singular, never `.factories`; overridable via `--state-dir`).
 * Immediately after the receipt's atomic rename a single line
 *
 *     session-closed <sessionId> <exitReason>
 *
 * is appended to `<stateDir>/daemon.log` for tail-friendly correlation.
 *
 * Contract / ownership:
 *   - This module is the SOLE writer of `<stateDir>/sessions/` and the SOLE
 *     emitter of the `session-closed` log line. No other module may create
 *     files there or append that line.
 *   - The write is atomic (sibling temp file + rename) so a SIGKILL mid-write
 *     can never leave a half-written `-close.json` on disk.
 *   - The pure functions (`isValidExitReason`, `classifyExit`,
 *     `composeCloseReceipt`, `makeSessionId`) are exported so the unit test
 *     can exercise every branch without booting the daemon. `beginSession`
 *     is the imperative wiring used by the daemon; it must not be called at
 *     import time (no top-level side effects) so the module stays testable.
 */
import * as fs from "node:fs";
import path from "node:path";

/**
 * The complete, closed set of exit reasons a receipt may carry. `signaled`
 * takes precedence over everything else (a signal drove the exit); otherwise
 * a non-zero exit is `failed`, an exit-with-processed-issue is `processed`,
 * and a clean exit with no issue is `idle`.
 */
export const EXIT_REASONS = Object.freeze(["idle", "processed", "failed", "signaled"]);

/** Required fields — a verifier asserts exactly this set and ignores extras. */
export const REQUIRED_FIELDS = Object.freeze([
    "sessionId",
    "mode",
    "startedAt",
    "endedAt",
    "durationMs",
    "exitCode",
    "exitReason",
    "issueNumber",
    "stateFile",
]);

const VALID_MODES = Object.freeze(["once", "continuous"]);

/** Runtime guard for the exitReason enum. */
export function isValidExitReason(value) {
    return typeof value === "string" && EXIT_REASONS.includes(value);
}

/**
 * Map a POSIX signal name to its number, using the shell 128+signum exit
 * convention. Unknown signals default to SIGTERM (15) so a translated exit
 * is always produced deterministically.
 */
export function signalNumber(sig) {
    if (typeof sig === "number" && sig > 0) return sig;
    switch (sig) {
        case "SIGINT": return 2;
        case "SIGHUP": return 1;
        case "SIGTERM": return 15;
        default: return 15;
    }
}

/**
 * Pure classifier: from the facts the exit path already knows, derive
 * `{ exitReason, exitCode }`. `signaled` short-circuits; a non-zero exit is
 * `failed`; a zero exit with a processed issue number is `processed`; a zero
 * exit with no issue is `idle`.
 */
export function classifyExit({ signaled = false, signum = null, exitCode = 0, issueNumber = null } = {}) {
    if (signaled) {
        return { exitReason: "signaled", exitCode: 128 + signalNumber(signum) };
    }
    const code = Number.isInteger(exitCode) ? exitCode : 0;
    if (code !== 0) {
        return { exitReason: "failed", exitCode: code };
    }
    if (issueNumber !== null && issueNumber !== undefined) {
        return { exitReason: "processed", exitCode: 0 };
    }
    return { exitReason: "idle", exitCode: 0 };
}

function toIso(value) {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Build a filesystem-safe, chronologically sortable session id.
 * The ISO start timestamp (colons and the millisecond dot replaced with
 * dashes so the token is legal on Windows) is a fixed-width prefix, so a
 * lexicographic `ls -1` of the sessions directory orders receipts
 * chronologically. `pid` and a short random suffix keep two runs in the same
 * millisecond distinct without disturbing the timestamp-major ordering.
 */
export function makeSessionId(startedAt, pid) {
    const stamp = toIso(startedAt).replace(/[:.]/g, "-");
    const rand = Math.random().toString(36).slice(2, 8);
    return `${stamp}-${pid}-${rand}`;
}

/**
 * Build and validate a receipt. Throws BEFORE any disk write if `exitReason`
 * is outside the enum, a required field is missing or mis-typed, or the
 * stateFile invariant is violated. Extra fields (`pid`, `factoryVersion`)
 * are preserved and never fail the guard — a required-field-only verifier
 * must accept them.
 */
export function composeCloseReceipt(fields) {
    const {
        sessionId, mode, startedAt, endedAt,
        exitCode, exitReason,
        issueNumber = null, stateFile = null,
        pid, factoryVersion,
    } = fields;

    if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error("close-receipt: sessionId must be a non-empty string");
    }
    if (!VALID_MODES.includes(mode)) {
        throw new Error(`close-receipt: mode must be one of ${VALID_MODES.join("|")}, got ${JSON.stringify(mode)}`);
    }
    if (!isValidExitReason(exitReason)) {
        throw new Error(`close-receipt: invalid exitReason ${JSON.stringify(exitReason)}`);
    }
    if (!Number.isInteger(exitCode)) {
        throw new Error("close-receipt: exitCode must be an integer");
    }
    const startMs = Date.parse(toIso(startedAt));
    const endMs = Date.parse(toIso(endedAt));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        throw new Error("close-receipt: startedAt/endedAt must be ISO 8601 timestamps");
    }
    if (issueNumber !== null && !Number.isInteger(issueNumber)) {
        throw new Error("close-receipt: issueNumber must be an integer or null");
    }
    if (stateFile !== null && typeof stateFile !== "string") {
        throw new Error("close-receipt: stateFile must be an absolute path string or null");
    }
    // Invariant: idle ⇒ stateFile null; processed ⇒ stateFile an absolute path.
    if (exitReason === "idle" && stateFile !== null) {
        throw new Error("close-receipt: an idle receipt must carry stateFile null");
    }
    if (exitReason === "processed" && !(typeof stateFile === "string" && path.isAbsolute(stateFile))) {
        throw new Error("close-receipt: a processed receipt must carry an absolute stateFile path");
    }

    const receipt = {
        sessionId,
        mode,
        startedAt: toIso(startedAt),
        endedAt: toIso(endedAt),
        durationMs: Math.max(0, Math.floor(endMs - startMs)),
        exitCode,
        exitReason,
        issueNumber: issueNumber ?? null,
        stateFile: stateFile ?? null,
    };
    if (Number.isInteger(pid)) receipt.pid = pid;
    if (typeof factoryVersion === "string" && factoryVersion.length > 0) receipt.factoryVersion = factoryVersion;
    return receipt;
}

/**
 * Default filesystem operations, injectable only so tests can fault-inject
 * (e.g. throw from `renameSync` to simulate a hard kill between the tmp
 * write and the rename). The daemon always uses these real operations.
 */
function defaultIo() {
    return {
        mkdirSync: fs.mkdirSync,
        writeFileSync: fs.writeFileSync,
        renameSync: fs.renameSync,
        appendFileSync: fs.appendFileSync,
    };
}

/**
 * Atomically persist one receipt and emit its correlation log line.
 *
 * Writes to a sibling `<sessionId>.json.tmp`, renames to
 * `<sessionId>-close.json`, then appends exactly one
 * `session-closed <sessionId> <exitReason>` line to `<stateDir>/daemon.log`.
 * Ordering matters: a hard kill between the rename and the append leaves a
 * complete receipt with (at most) a missing log line, never a partial file.
 *
 * Returns the absolute path of the written receipt.
 */
export function writeCloseReceipt(receipt, stateDir, io = defaultIo()) {
    if (!isValidExitReason(receipt?.exitReason)) {
        throw new Error("close-receipt: refusing to write a receipt with an invalid exitReason");
    }
    if (!stateDir || typeof stateDir !== "string") {
        throw new Error("close-receipt: stateDir is required");
    }
    const sessionsDir = path.join(stateDir, "sessions");
    io.mkdirSync(sessionsDir, { recursive: true });
    const finalPath = path.join(sessionsDir, `${receipt.sessionId}-close.json`);
    const tmpPath = path.join(sessionsDir, `${receipt.sessionId}.json.tmp`);
    io.writeFileSync(tmpPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
    io.renameSync(tmpPath, finalPath);
    io.appendFileSync(path.join(stateDir, "daemon.log"), `session-closed ${receipt.sessionId} ${receipt.exitReason}\n`);
    return finalPath;
}

function normalizeExitCode(code) {
    const n = Number(code);
    return Number.isInteger(n) ? n : 0;
}

/**
 * Begin a session and return a controller that emits exactly one receipt on
 * process teardown.
 *
 *  - `recordProcessed(issueNumber, stateFile)` is called by the daemon after
 *    it persists a state file; the most recent call wins, so a `--once` run
 *    reports its single issue and a continuous run reports the last one.
 *  - `install()` registers a `process.on("exit")` handler that runs on every
 *    normal termination (clean return, `process.exit`, uncaught error) and
 *    SIGINT/SIGTERM handlers that translate a catchable signal into a clean
 *    teardown, so a `signaled` receipt is written deterministically. SIGKILL
 *    cannot be caught — by design, it produces no receipt.
 *
 * The controller is idempotent: `emit` writes at most once.
 */
export function beginSession({ stateDir, mode, startedAt = new Date(), factoryVersion } = {}) {
    const started = startedAt instanceof Date ? startedAt : new Date(startedAt);
    const sessionId = makeSessionId(started, process.pid);
    const ctx = { issueNumber: null, stateFile: null, signaled: false, signum: null, written: false };

    function emit() {
        if (ctx.written) return null;
        ctx.written = true;
        try {
            const { exitReason, exitCode } = classifyExit({
                signaled: ctx.signaled,
                signum: ctx.signum,
                exitCode: normalizeExitCode(process.exitCode),
                issueNumber: ctx.issueNumber,
            });
            const receipt = composeCloseReceipt({
                sessionId,
                mode,
                startedAt: started,
                endedAt: new Date(),
                exitCode,
                exitReason,
                issueNumber: ctx.issueNumber,
                stateFile: ctx.stateFile,
                pid: process.pid,
                factoryVersion,
            });
            return writeCloseReceipt(receipt, stateDir);
        } catch (err) {
            // A receipt failure must never change or block the real exit.
            try { process.stderr.write(`close-receipt: ${err && err.message ? err.message : err}\n`); } catch { /* noop */ }
            return null;
        }
    }

    const controller = {
        sessionId,
        startedAt: started.toISOString(),
        recordProcessed(issueNumber, stateFile) {
            if (issueNumber !== null && issueNumber !== undefined) ctx.issueNumber = Number(issueNumber);
            if (typeof stateFile === "string" && stateFile.length > 0) ctx.stateFile = path.resolve(stateFile);
        },
        signal(sig) {
            if (!ctx.signaled) {
                ctx.signaled = true;
                ctx.signum = signalNumber(sig);
            }
        },
        emit,
        install() {
            process.on("exit", () => { emit(); });
            const handle = (sig) => {
                const code = 128 + signalNumber(sig);
                // A second signal while already tearing down exits hard.
                if (ctx.written) { process.exit(code); return; }
                controller.signal(sig);
                // process.exit runs the `exit` listener → emit() → signaled receipt.
                process.exit(code);
            };
            process.on("SIGINT", () => handle("SIGINT"));
            process.on("SIGTERM", () => handle("SIGTERM"));
        },
    };
    return controller;
}
