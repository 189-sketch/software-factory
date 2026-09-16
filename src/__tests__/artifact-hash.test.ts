/**
 * Spec plan §3.5: the JSON `body` returned by the spec agent must match
 * the PRODUCT.md / TECH.md files on disk before the orchestrator
 * commits the worktree. A divergence is treated as invalid-agent-output
 * (one directed repair pass, then escalate to triage).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SpecHashMismatchError,
  assertSpecFilesMatchBodies,
  hashFile,
  hashText,
} from "../core/artifact-hash.js";

function freshWorkdir() {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-spec-hash-"));
  return { workdir: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("hashText is deterministic and sha-256-shaped", () => {
  const a = hashText("hello world");
  const b = hashText("hello world");
  const c = hashText("hello world!");
  assert.equal(a, b, "same input must hash to the same digest");
  assert.notEqual(a, c, "different inputs must hash differently");
  assert.match(a, /^[a-f0-9]{64}$/);
});

test("hashFile matches hashText for the same content", async () => {
  const { workdir, cleanup } = freshWorkdir();
  try {
    const file = path.join(workdir, "a.txt");
    writeFileSync(file, "payload", "utf8");
    assert.equal(await hashFile(file), hashText("payload"));
  } finally {
    cleanup();
  }
});

test("hashFile returns the empty digest for a missing file (ENOENT)", async () => {
  const { workdir, cleanup } = freshWorkdir();
  try {
    assert.equal(await hashFile(path.join(workdir, "missing.txt")), hashText(""));
  } finally {
    cleanup();
  }
});

test("assertSpecFilesMatchBodies passes when the JSON body and the on-disk file agree", async () => {
  const { workdir, cleanup } = freshWorkdir();
  try {
    const slug = "issue-7-demo";
    const product = "PRODUCT body";
    const tech = "TECH body";
    const dir = path.join(workdir, "specs", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "PRODUCT.md"), product, "utf8");
    writeFileSync(path.join(dir, "TECH.md"), tech, "utf8");
    await assertSpecFilesMatchBodies(
      { product: { body: product, slug }, tech: { body: tech, slug } },
      workdir,
    );
  } finally {
    cleanup();
  }
});

test("assertSpecFilesMatchBodies throws SpecHashMismatchError when PRODUCT.md diverges", async () => {
  const { workdir, cleanup } = freshWorkdir();
  try {
    const slug = "issue-7-mismatch";
    const dir = path.join(workdir, "specs", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "PRODUCT.md"), "what the file says", "utf8");
    writeFileSync(path.join(dir, "TECH.md"), "tech content", "utf8");
    await assert.rejects(
      assertSpecFilesMatchBodies(
        { product: { body: "what the agent says", slug }, tech: { body: "tech content", slug } },
        workdir,
      ),
      (err: Error) => {
        assert.ok(err instanceof SpecHashMismatchError, `expected SpecHashMismatchError, got ${err.constructor.name}`);
        assert.equal((err as SpecHashMismatchError).document, "product");
        assert.equal((err as SpecHashMismatchError).code, "SPEC_HASH_MISMATCH");
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("assertSpecFilesMatchBodies throws when the slug in the result does not match the on-disk path", () => {
  const { workdir, cleanup } = freshWorkdir();
  try {
    return assert.rejects(
      assertSpecFilesMatchBodies(
        { product: { body: "x", slug: "issue-7-a" }, tech: { body: "y", slug: "issue-7-b" } },
        workdir,
      ),
      /Spec slug must match between product and tech halves/,
    );
  } finally {
    cleanup();
  }
});