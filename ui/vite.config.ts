// Browser-only build of the vendored QiTech Control renderer.
// The upstream config (control/electron/vite.config.ts) additionally runs
// vite-plugin-electron for main.ts/preload.ts; neither exists here.
//
// The machines are simulated in the page itself (backend/), so the build is
// a static site: `socket.io-client` is swapped for an in-memory client that
// talks to that simulation, and nothing is sent over the network.
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, "../backend");

export default defineConfig({
  root: here,
  // relative asset URLs: the build works from any path on any static host
  base: "./",
  publicDir: path.resolve(here, "public"),
  resolve: {
    preserveSymlinks: true,
    alias: {
      "@backend": backend,
      "@": path.resolve(here, "./src"),
      "socket.io-client": path.join(backend, "socketio-client.ts"),
      "socket.io-msgpack-parser": path.join(backend, "msgpack-parser.ts"),
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
  },
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler"]],
      },
    }),
  ],
});
