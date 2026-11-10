#!/usr/bin/env node
// Serves the built demo (ui/dist) for the NixOS kiosk and `npm start`.
//
// It is a plain static file server: the simulated machines run in the browser
// (backend/browser.ts), so ui/dist can equally be put on any web host.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "0.0.0.0";
const here = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(
  process.env.DEMO_STATIC_DIR ?? path.join(here, "..", "ui", "dist"),
);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
};

const http = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  let file = path.join(STATIC_DIR, decodeURIComponent(url.pathname));
  if (!file.startsWith(STATIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory())
    file = path.join(STATIC_DIR, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("UI not built. Run `npm run build`, or use `npm run dev`.");
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const immutable = url.pathname.startsWith("/assets/");
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
});

http.listen(PORT, HOST, () => {
  console.log(`control-demo: http://localhost:${PORT} (static: ${STATIC_DIR})`);
});
