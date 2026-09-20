import { createPanelReadModel } from "./panel-read-model.mjs";
import { loadDecisionsJson } from "./decisions-loader.mjs";

export async function handlePanelApi(root, request, options = {}) {
  const method = String(request.method || "GET").toUpperCase();
  const pathname = String(request.pathname || "/");
  if (method !== "GET") return { status: 405, body: { error: "method not allowed", method } };

  // T10.1: read-only view of runtime/decisions.yaml for the control panel's
  // "Routing Configuration" page. Served before the read model is built —
  // the decisions file ships next to this module, independent of `root`.
  // A malformed/missing file becomes the standard error envelope; the
  // server never crashes. Strictly GET-only (405 above guards the rest).
  if (pathname === "/api/decisions") {
    try {
      const decisions = await loadDecisionsJson(options.decisionsPath);
      return { status: 200, body: decisions };
    } catch (error) {
      return { status: 500, body: { error: "decisions.yaml unavailable", detail: String(error?.message ?? error) } };
    }
  }

  const model = await createPanelReadModel(root, options);
  if (pathname === "/api/projects") return { status: 200, body: await model.projects() };
  if (pathname === "/api/events") return { status: 200, body: { events: await model.events() } };
  if (pathname === "/api/agents") return { status: 200, body: { agents: await model.agents() } };
  if (pathname === "/api/settings") return { status: 200, body: await model.settings() };

  const match = pathname.match(/^\/api\/projects\/([^/]+)(\/issues)?$/);
  if (match) {
    const projectId = decodeURIComponent(match[1]);
    try {
      const project = model.project(projectId);
      const projects = await model.projects();
      const issues = await model.issues(projectId);
      if (match[2]) return { status: 200, body: { issues } };
      return { status: 200, body: { project, metrics: projects.metrics[projectId] || null, issues } };
    } catch (error) {
      if (String(error).includes("Project not found")) {
        return { status: 404, body: { error: "project not found", projectId } };
      }
      throw error;
    }
  }
  return { status: 404, body: { error: "not found", route: pathname } };
}
