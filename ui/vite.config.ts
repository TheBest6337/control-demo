// Browser-only build of the vendored QiTech Control renderer.
// The upstream config (control/electron/vite.config.ts) additionally runs
// vite-plugin-electron for main.ts/preload.ts; neither exists here.
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = `http://localhost:${process.env.PORT ?? 3001}`;

export default defineConfig({
  root: here,
  publicDir: path.resolve(here, "public"),
  resolve: {
    preserveSymlinks: true,
    alias: {
      "@": path.resolve(here, "./src"),
    },
  },
  clearScreen: false,
  build: {
    outDir: path.resolve(here, "dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 8000,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": backend,
      "/demo": backend,
      "/socket.io": { target: backend, ws: true },
    },
  },
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler"]],
      },
    }),
  ],
});
