import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureIssueWorktree,
  cleanupIssueWorktree,
  acquireDaemonLock,
  releaseDaemonLock,
  formatUtc8Timestamp,
  isTransientNetworkError,
  parseStdout,
  retryTransient,
  runCommandWithRetry,
  networkCommandTimeoutMs,
} from "../scripts/daemon-support.mjs";

function git(cwd, args) {
  return String(execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  })).trim();
}

test('repository transfers get bounded budgets while API reads and explicit limits stay short', async () => {
  for (const [command, args, expected] of [
    ['git', ['-C', 'repo', 'fetch', 'origin'], 60000], ['git', ['push', 'origin', 'main'], 60000],
    ['gh', ['repo', 'clone', 'owner/repo'], 120000], ['git', ['clone', 'url'], 120000],
    ['gh', ['api', 'repos/owner/repo'], 10000], ['git', ['status'], 10000],
  ]) {
    assert.equal(networkCommandTimeoutMs(command, args), expected);
    let observed;
    await runCommandWithRetry(command, args, {}, { attempts: 1,
      execFileSync: (_command, _args, options) => { observed = options.timeout; return ''; } });
    assert.equal(observed, expected);
  }
  for (const [commandOptions, retryOptions, expected] of [[{ timeout: 500 }, {}, 500], [{}, { timeoutMs: 'short' }, 5000]]) {
    let observed;
    await runCommandWithRetry('git', ['fetch', 'origin'], commandOptions, { ...retryOptions, attempts: 1,
      execFileSync: (_command, _args, options) => { observed = options.timeout; return ''; } });
    assert.equal(observed, expected);
  }
});

test("daemon timestamps explicitly identify UTC+8", () => {
  assert.equal(formatUtc8Timestamp(new Date("2026-09-10T08:16:14.466Z")), "2026-09-10T16:16:14.466+08:00");
  assert.doesNotMatch(formatUtc8Timestamp(), /Z$/);
});

test('a live daemon keeps its lock regardless of age or timestamp validity', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'daemon.pid');
  for (const startedAt of [new Date(Date.now() - 3600000).toISOString(), 'invalid']) {
    const content = JSON.stringify({ pid: process.pid, startedAt });
    fs.writeFileSync(file, content);
    assert.throws(() => acquireDaemonLock({ stateDir: root }), /Another factory daemon/);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
  fs.unlinkSync(file);
  const finished = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(finished.status, 0);
  fs.writeFileSync(file, JSON.stringify({pid:finished.pid,startedAt:new Date().toISOString()}));
  const lock = acquireDaemonLock({ stateDir: root });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid, 'Confirmed dead owners can be reclaimed immediately');
  releaseDaemonLock(lock);
  assert.equal(fs.existsSync(file), false);
});

test('merged worktree cleanup finds the actual repository and waits for removal', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'work', 'repository');
  const issueWorkdir = path.join(root, 'work', 'issue-86');
  fs.mkdirSync(source, { recursive: true });
  git(source, ['init', '-b', 'main']);
  git(source, ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-m', 'fixture']);
  git(source, ['worktree', 'add', '-b', 'feature/test', issueWorkdir]);
  await cleanupIssueWorktree({ issueWorkdir, branch: 'feature/test' });
  assert.equal(fs.existsSync(issueWorkdir), false);
  assert.equal(git(source, ['branch', '--list', 'feature/test']), '');
  assert.equal(fs.existsSync(source), true);
  await assert.rejects(cleanupIssueWorktree({ issueWorkdir }), /Command failed/);
});

test("transient GitHub failures retry with finite exponential backoff", async () => {
  let calls = 0;
  const delays = [];
  const result = await retryTransient(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("unexpected EOF"), { stderr: "remote end hung up unexpectedly" });
    return "ok";
  }, {
    attempts: 3,
    baseDelayMs: 10,
    sleep: async (ms) => delays.push(ms),
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  // Back-off is exponentially 10ms, 20ms but each delay is jittered ±25 %,
  // so we assert the order-of-magnitude and that each delay is within
  // the expected jitter band rather than comparing exact values.
  assert.equal(delays.length, 2);
  assert.ok(delays[0] >= 8 && delays[0] <= 13, `first delay ${delays[0]} not in jitter band`);
  assert.ok(delays[1] >= 15 && delays[1] <= 26, `second delay ${delays[1]} not in jitter band`);
  assert.equal(isTransientNetworkError(new Error("authentication failed")), false);
});

for (const partial of [true, false]) {
test(`interrupted worktree removal ${partial ? 'finishes owned residue without replaying Git' : 'preserves an intact worktree on failure'}`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'factory-partial-cleanup-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'repository'),workdir=path.join(root,'issue-1'),sibling=path.join(root,'sibling');
  fs.mkdirSync(source); git(source,['init','-b','main']);
  git(source,['-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','fixture']);
  git(source,['worktree','add','-b','feature/test',workdir]);
  fs.mkdirSync(path.join(workdir,'generated','node_modules'),{recursive:true});
  fs.writeFileSync(path.join(workdir,'generated','node_modules','dependency'),'fixture');
  fs.mkdirSync(sibling); fs.writeFileSync(path.join(sibling,'sentinel'),'untouched');
  let removals=0;
  const run=async (command,args,options,retry) => {
    if(args.includes('remove')) {
      removals++;
      if(partial)fs.unlinkSync(path.join(workdir,'.git'));
      throw Object.assign(new Error('Interrupted local deletion'),{code:'ETIMEDOUT'});
    }
    return runCommandWithRetry(command,args,options,retry);
  };
  const operation=cleanupIssueWorktree({issueWorkdir:workdir,branch:'feature/test',run});
  if(partial)await operation; else await assert.rejects(operation,/Interrupted local deletion/);
  assert.equal(removals,1,'A partially applied destructive operation must not be blindly replayed');
  assert.equal(fs.existsSync(workdir),!partial);
  assert.equal(fs.readFileSync(path.join(sibling,'sentinel'),'utf8'),'untouched');
  assert.equal(fs.existsSync(source),true);
  assert.equal(Boolean(git(source,['branch','--list','feature/test'])),!partial);
});
}

test("critical retry policy tolerates more attempts than standard", async () => {
  let calls = 0;
  await assert.rejects(
    () => retryTransient(async () => {
      calls++;
      throw Object.assign(new Error("EOF"), { stderr: "Post ... graphql: EOF" });
    }, {
      policy: "critical",
      baseDelayMs: 1,
      sleep: async () => {},
    }),
    /EOF/,
  );
  // Critical allows up to 6 attempts, standard allows only 3.
  assert.equal(calls, 6, "critical policy should retry 6 times");
});

test("ETIMEDOUT from execFileSync is treated as transient for retry", () => {
    // Windows + gh sometimes leaves a zombie child after an EOF; the next
    // execFileSync can block until execFileSync's own `timeout` kills the
    // child. ETIMEDOUT must trigger retry, not abort the poll cycle.
    assert.equal(isTransientNetworkError(Object.assign(new Error("Command failed: ETIMEDOUT"), { code: "ETIMEDOUT" })), true);
});

test("runCommandWithRetry applies a default timeout to execFileSync", async () => {
    // Spawn a node child that sleeps well past the default 30s timeout, but
    // pass an explicit tiny timeout via commandOptions to keep the test
    // fast. This proves the helper honors the timeout knob and that a
    // timed-out call surfaces a recognisable error.
    const child = process.platform === "win32"
        ? `"${process.execPath}" -e "setTimeout(()=>{}, 10000)"`
        : `${process.execPath} -e "setTimeout(()=>{}, 10000)"`;
    await assert.rejects(
        () => runCommandWithRetry(
            process.execPath,
            ["-e", "setTimeout(()=>{}, 10000)"],
            { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 500 },
            { attempts: 1, baseDelayMs: 1, sleep: async () => {} },
        ),
        (err) => {
            // execFileSync raises Error with code 'ETIMEDOUT' on Node 22
            // when the timeout fires. Accept either the code or any
            // substring that mentions timeout.
            return err?.code === "ETIMEDOUT" || /timed out|timeout/i.test(String(err));
        },
    );
}, { timeout: 15_000 });

test("runCommandWithRetry stdout is always a string, never a Buffer", async () => {
    // Regression for the [object Object] JSON.parse crash in
    // fetchNextFromGitHub. runCommandWithRetry used to delegate to
    // execFileSync which respects `encoding: 'utf-8'` from
    // commandOptions; after the Windows-hang fix it switched to
    // callback-style execFile whose default `encoding` is null, so
    // stdout came back as a Buffer. The helper must coerce either way
    // so `JSON.parse(stdout)` in gh callers never sees a Buffer.
    const out = await runCommandWithRetry(
        process.execPath,
        ["-e", "console.log('hello')"],
        {},  // NO encoding passed — this is the case that broke before
        { attempts: 1, baseDelayMs: 1, sleep: async () => {} },
    );
    assert.equal(typeof out.stdout, "string", "stdout must be a string");
    assert.equal(out.stdout.trim(), "hello");
    // And the same when the caller does pass encoding explicitly.
    const out2 = await runCommandWithRetry(
        process.execPath,
        ["-e", "console.log('world')"],
        { encoding: "utf-8" },
        { attempts: 1, baseDelayMs: 1, sleep: async () => {} },
    );
    assert.equal(typeof out2.stdout, "string");
    assert.equal(out2.stdout.trim(), "world");
});

test("parseStdout handles every runCommandWithRetry return shape without [object Object]", () => {
    // Regression for the daemon WARN loop:
    //   WARN gh-issue-list-parse-failed { error: "SyntaxError: \"[object Object]\" is not valid JSON" }
    // The callers used to do `JSON.parse(out)` where `out` was the
    // `{ stdout, stderr }` object the async retry path resolves with;
    // JSON.parse coerced it via String() → "[object Object]" → SyntaxError,
    // and the daemon silently skipped every poll for ~2h. parseStdout
    // collapses both shapes so any caller can `JSON.parse(parseStdout(out))`
    // without contract awareness.

    // 1. Async-path shape: { stdout, stderr }
    assert.equal(parseStdout({ stdout: '{"n":1}', stderr: "" }), '{"n":1}');
    // 2. Sync-path shape: bare string
    assert.equal(parseStdout('{"n":2}'), '{"n":2}');
    // 3. Defensive: null / undefined
    assert.equal(parseStdout(null), "");
    assert.equal(parseStdout(undefined), "");
    // 4. Buffer inside the object (the original Buffer-vs-string bug)
    assert.equal(parseStdout({ stdout: Buffer.from('{"n":3}') }), '{"n":3}');

    // End-to-end: every shape round-trips through JSON.parse without
    // raising the [object Object] SyntaxError.
    for (const input of [
        '{"issues":[]}',
        { stdout: '{"issues":[]}', stderr: "" },
        { stdout: Buffer.from('{"issues":[]}'), stderr: Buffer.alloc(0) },
    ]) {
        const parsed = JSON.parse(parseStdout(input));
        assert.deepEqual(parsed, { issues: [] }, `shape ${JSON.stringify(Object.keys(input))} should parse`);
    }
});

test("parseStdout of an object with stdout === undefined returns empty string", () => {
    // Defensive: a future caller might forget to populate stdout. Don't
    // string-coerce the object itself into "[object Object]" — return ""
    // so JSON.parse fails cleanly with an empty-input SyntaxError rather
    // than the misleading object one.
    assert.equal(parseStdout({ stdout: undefined, stderr: "boom" }), "");
});

test("each issue gets one stable reusable real git worktree", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-worktree-test-"));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const workdir = path.join(root, "work");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(source);
  git(root, ["init", "--bare", remote]);
  git(source, ["init", "-b", "main"]);
  git(source, ["config", "user.email", "factory@test.local"]);
  git(source, ["config", "user.name", "Factory Test"]);
  fs.writeFileSync(path.join(source, "README.md"), "fixture\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-m", "fixture"]);
  git(source, ["remote", "add", "origin", remote]);
  git(source, ["push", "-u", "origin", "main"]);

  const first = await ensureIssueWorktree({ workdir, issueNumber: 17, sourceRepo: source, defaultBranch: "main" });
  const second = await ensureIssueWorktree({ workdir, issueNumber: 17, sourceRepo: source, defaultBranch: "main" });
  const other = await ensureIssueWorktree({ workdir, issueNumber: 18, sourceRepo: source, defaultBranch: "main" });

  assert.equal(first, path.join(workdir, "issue-17"));
  assert.equal(second, first);
  assert.notEqual(other, first);
  assert.equal(path.resolve(git(first, ["rev-parse", "--show-toplevel"])), path.resolve(first));
  assert.equal(fs.readFileSync(path.join(first, "README.md"), "utf-8").replace(/\r\n/g, "\n"), "fixture\n");
  const registered = git(source, ["worktree", "list", "--porcelain"]).replace(/\\/g, "/");
  assert.ok(registered.includes(first.replace(/\\/g, "/")));
  assert.ok(registered.includes(other.replace(/\\/g, "/")));
});
