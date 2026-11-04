// Runs the mock backend (with --watch) and the Vite dev server together.
import { spawn } from "node:child_process";

const procs = [
  spawn("npm", ["run", "-s", "dev:server"], { stdio: "inherit" }),
  spawn("npm", ["run", "-s", "dev:ui"], { stdio: "inherit" }),
];
const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs)
  p.on("exit", (code) => {
    stop();
    process.exitCode = code ?? 0;
  });
