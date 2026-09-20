#!/usr/bin/env node
import http from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handlePanelApi } from "../runtime/panel-api.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));

if (args.version) {
  let version = "0.0.0";
  try { version = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version || version; } catch {}
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

if (args.help) {
  process.stdout.write("Usage: factory-panel [--port 5174] [--host 127.0.0.1] [--target PATH]\n");
  process.exit(0);
}

const port = Number(args.port) || 5174;
const host = args.host || "127.0.0.1";
const targetRoot = path.resolve(args.target || process.cwd());
const panelRoot = path.join(packageRoot, "dist", "panel");

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "-v" || value === "--version") out.version = true;
    else if (value === "-h" || value === "--help") out.help = true;
    else if (value.startsWith("--")) {
      const equals = value.indexOf("=");
      if (equals >= 0) out[value.slice(2, equals)] = value.slice(equals + 1);
      else if (argv[index + 1] && !argv[index + 1].startsWith("--")) out[value.slice(2)] = argv[++index];
      else out[value.slice(2)] = true;
    }
  }
  return out;
}

function mimeType(file) {
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".map": "application/json",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  })[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function serveStatic(response, pathname) {
  let file = path.resolve(panelRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
  const relative = path.relative(panelRoot, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }
  if (!existsSync(file)) file = path.join(panelRoot, "index.html");
  if (!existsSync(file)) {
    response.statusCode = 503;
    response.end("Control panel assets are not built");
    return;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", mimeType(file));
  createReadStream(file).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || host}`);
  if (!url.pathname.startsWith("/api/")) {
    serveStatic(response, url.pathname);
    return;
  }
  try {
    const result = await handlePanelApi(targetRoot, { method: request.method, pathname: url.pathname }, { skillsRoot: packageRoot });
    sendJson(response, result.status, result.body);
  } catch (error) {
    sendJson(response, 500, { error: String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`Control panel ready at http://${host}:${port}`);
  console.log(`Reading factory state from ${targetRoot}`);
});
