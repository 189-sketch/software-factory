import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";

import { handlePanelApi } from "../../runtime/panel-api.mjs";

export function factoryApi(): Plugin {
  return {
    name: "factory-api",
    configureServer(server: ViteDevServer) {
      const root = path.dirname(server.config.root);
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = req.url ?? "/";
        if (!requestUrl.startsWith("/api/")) return next();
        try {
          const result = await handlePanelApi(root, {
            method: req.method,
            pathname: requestUrl.split("?")[0],
          }, { skillsRoot: root });
          res.statusCode = result.status;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(result.body));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: String(error) }));
        }
      });
    },
  };
}
