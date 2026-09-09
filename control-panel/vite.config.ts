import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { factoryApi } from "./vite/factoryApi";
import path from "node:path";

export default defineConfig(({ mode }) => {
    // In dev mode, build into ./dist (next to vite.config). In production /
    // publish mode (when the parent package is building the npm tarball),
    // emit into ../dist/panel so it lands inside the software-factory-cli
    // package layout. Detect by env var rather than mode to avoid the
    // dev script breaking when mode is unset.
    const outDir = process.env.FACTORY_PANEL_OUTDIR ?? path.resolve(__dirname, "dist");

    return {
        plugins: [react(), factoryApi()],
        server: { host: "0.0.0.0", port: 5174 },
        build: {
            outDir,
            emptyOutDir: true,
            sourcemap: false,
        },
    };
});
