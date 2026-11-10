import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@backend": path.resolve(here, "backend"),
      "@": path.resolve(here, "ui/src"),
      "socket.io-client": path.resolve(here, "backend/socketio-client.ts"),
      "socket.io-msgpack-parser": path.resolve(here, "backend/msgpack-parser.ts"),
    },
  },
  test: {
    dir: "./test",
    // the UI namespace modules touch `window` when imported
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    reporters: ["default"],
  },
});
