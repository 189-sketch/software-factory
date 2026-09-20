/**
 * Spec `2026-09-20-decision-architecture` / Phase B / T10.1.
 *
 * HTTP-level tests for the `GET /api/decisions` route added to
 * `runtime/panel-api.mjs`. Spins `handlePanelApi` on an ephemeral port
 * with a minimal node:http wrapper (same call shape as
 * `bin/factory-panel.js` and `control-panel/vite/factoryApi.ts`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handlePanelApi } from "../runtime/panel-api.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shippedYaml = path.join(repoRoot, "runtime", "decisions.yaml");

async function startPanelServer(targetRoot, options) {
    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
        try {
            const result = await handlePanelApi(
                targetRoot,
                { method: request.method, pathname: url.pathname },
                options,
            );
            response.statusCode = result.status;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify(result.body));
        } catch (error) {
            response.statusCode = 500;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify({ error: String(error) }));
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
        port,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

async function requestJson(port, method, pathname) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method });
    const body = await response.json();
    return { status: response.status, body };
}

test("GET /api/decisions returns 200 + the parsed decisions.yaml as JSON", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "panel-api-decisions-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const server = await startPanelServer(root, { decisionsPath: shippedYaml });
    t.after(() => server.close());

    const { status, body } = await requestJson(server.port, "GET", "/api/decisions");
    assert.equal(status, 200);
    assert.equal(body.version, 1);
    assert.ok(Array.isArray(body.decisions));
    assert.equal(body.decisions.length, 5);
    assert.deepEqual(
        body.decisions.map((d) => d.action),
        [
            "freshness.skip",
            "triage.apply_label",
            "review-pr.merge_pr",
            "supervisor.retry",
            "operator.escalate",
        ],
    );
    assert.deepEqual(body.composite, { spec: 0.3, impl: 0.25, review: 0.2, verify: 0.25 });
    assert.equal(body.fallback.cjk.trigger, "any_of");
    assert.equal(body.fallback.cjk.fallback_backend, "claude-code");
});

test("GET /api/decisions uses the shipped runtime/decisions.yaml by default", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "panel-api-decisions-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const server = await startPanelServer(root, {});
    t.after(() => server.close());

    const { status, body } = await requestJson(server.port, "GET", "/api/decisions");
    assert.equal(status, 200);
    assert.equal(body.version, 1);
    assert.equal(body.decisions.length, 5);
});

test("non-GET methods on /api/decisions return 405 (read-only endpoint)", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "panel-api-decisions-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const server = await startPanelServer(root, { decisionsPath: shippedYaml });
    t.after(() => server.close());

    const post = await requestJson(server.port, "POST", "/api/decisions");
    assert.equal(post.status, 405);
    assert.equal(post.body.error, "method not allowed");
    assert.equal(post.body.method, "POST");

    const del = await requestJson(server.port, "DELETE", "/api/decisions");
    assert.equal(del.status, 405);

    // Server survived the rejected writes and still serves the config.
    const get = await requestJson(server.port, "GET", "/api/decisions");
    assert.equal(get.status, 200);
});

test("malformed decisions.yaml yields the standard error envelope, server keeps running", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "panel-api-decisions-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const badYaml = path.join(root, "decisions.yaml");
    await fs.writeFile(badYaml, "version: 1\nthis is not yaml\n", "utf-8");

    const server = await startPanelServer(root, { decisionsPath: badYaml });
    t.after(() => server.close());

    const { status, body } = await requestJson(server.port, "GET", "/api/decisions");
    assert.equal(status, 500);
    assert.equal(body.error, "decisions.yaml unavailable");
    assert.match(String(body.detail), /Invalid decisions\.yaml:/);

    // The route still responds after the failure (no crash).
    const again = await requestJson(server.port, "GET", "/api/decisions");
    assert.equal(again.status, 500);
});

test("missing decisions.yaml yields the standard error envelope", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "panel-api-decisions-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const server = await startPanelServer(root, {
        decisionsPath: path.join(root, "nope.yaml"),
    });
    t.after(() => server.close());

    const { status, body } = await requestJson(server.port, "GET", "/api/decisions");
    assert.equal(status, 500);
    assert.equal(body.error, "decisions.yaml unavailable");
    assert.match(String(body.detail), /Invalid decisions\.yaml: cannot read/);
});

test("existing routes keep their behaviour (unknown route still 404 envelope)", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "panel-api-decisions-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const server = await startPanelServer(root, { decisionsPath: shippedYaml });
    t.after(() => server.close());

    const { status, body } = await requestJson(server.port, "GET", "/api/nope");
    assert.equal(status, 404);
    assert.equal(body.error, "not found");
    assert.equal(body.route, "/api/nope");
});
