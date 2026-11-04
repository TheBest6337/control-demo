#!/usr/bin/env node
// Mock of the qitech_control API server (legacy v1 REST + Socket.IO on :3001)
// that also serves the built UI from ui/dist on the same origin.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import type { Socket } from "socket.io";
import msgpackParser from "socket.io-msgpack-parser";
import { key, Plant } from "./plant.ts";
import type { Scenario } from "./plant.ts";
import { event, MACHINE_NAMESPACE_RE, MutationError } from "./protocol.ts";
import type { MachineIdentificationUnique, Mutation } from "./protocol.ts";
import type { MachineSim } from "./sim/machine.ts";
import { applyTimelineStart, runTimeline } from "./timeline.ts";
import type { DemoMarker } from "./timeline.ts";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "0.0.0.0";
const SCENARIO: Scenario =
  process.env.DEMO_SCENARIO === "cold" ? "cold" : "running";
const TICK_HZ = 30;
const STATE_MIN_INTERVAL_MS = 100;
const RESTART_DOWNTIME_MS = Number(
  process.env.DEMO_RESTART_DOWNTIME_MS ?? 2500,
);
/**
 * Back to the initial demo state after this many seconds without anyone
 * touching the UI (0 = never), so the next visitor finds the line running.
 */
const IDLE_RESET_S = Number(process.env.DEMO_IDLE_RESET_S ?? 60);

const here = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(
  process.env.DEMO_STATIC_DIR ?? path.join(here, "..", "ui", "dist"),
);

const plant = new Plant(SCENARIO);

// ------------------------------------------------------------------ history
//
// The UI only keeps graph data it received while connected. So that every
// visitor sees a full hour (the UI's long-term retention), the server records
// LiveValuesEvents itself and replays them to each new connection; at startup
// and after each reset it fast-forwards the simulation through the past hour.

const HISTORY_S = Number(process.env.DEMO_HISTORY_S ?? 3600);
const HISTORY_INTERVAL_MS = Number(
  process.env.DEMO_HISTORY_INTERVAL_MS ?? 2000,
);
const history = new Map<
  string,
  { ts: number; data: Record<string, unknown> }[]
>();

function record(ts: number) {
  for (const sim of plant.active()) {
    const k = key(sim.uid);
    if (!history.has(k)) history.set(k, []);
    const h = history.get(k)!;
    h.push({ ts, data: sim.live() });
    const cutoff = ts - HISTORY_S * 1000;
    while (h.length && h[0].ts < cutoff) h.shift();
  }
}

/** Simulate the past HISTORY_S seconds so the line has been running for an hour. */
/** Graph markers of the pre-filled shift (server/timeline.ts), absolute timestamps. */
let demoMarkers: DemoMarker[] = [];

function prefillHistory() {
  history.clear();
  demoMarkers = [];
  const now = Date.now();
  const dt = 0.1;
  const stepsPerSample = Math.round(HISTORY_INTERVAL_MS / 1000 / dt);
  const samples = Math.floor((HISTORY_S * 1000) / HISTORY_INTERVAL_MS);
  const timeline = SCENARIO === "running";
  if (timeline) applyTimelineStart(plant);
  for (let i = samples; i > 0; i--) {
    if (timeline) {
      const from = (i * HISTORY_INTERVAL_MS) / 1000;
      const to = ((i - 1) * HISTORY_INTERVAL_MS) / 1000;
      demoMarkers.push(...runTimeline(plant, from, to, now));
    }
    for (let j = 0; j < stepsPerSample; j++) plant.step(dt);
    record(now - (i - 1) * HISTORY_INTERVAL_MS);
  }
  for (const sim of plant.active()) {
    sim.notices.length = 0;
    sim.dirty = true;
  }
}

const started = performance.now();
prefillHistory();
console.log(
  `prefilled ${HISTORY_S} s of history in ${Math.round(performance.now() - started)} ms`,
);
let down = false;
/** Last operator input: a touch/click/key in any browser or any API write. */
let lastInput = Date.now();
/** Whether anything happened since the last reset (no reset loop while idle). */
let touchedSinceReset = false;
/** Increments on every demo reset; browsers reload when it changes. */
let resetGeneration = 0;

function touch() {
  lastInput = Date.now();
  touchedSinceReset = true;
}

function resetDemo(reason: string) {
  console.log(`resetting demo (${reason})`);
  plant.reset();
  prefillHistory();
  resetGeneration++;
  touchedSinceReset = false;
  lastInput = Date.now();
  restartBackend(false);
}

// ---------------------------------------------------------------- HTTP / REST

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

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function serveStatic(req: IncomingMessage, res: ServerResponse) {
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
    res.end(
      "UI not built. Run `npm run build`, or use `npm run dev` and open the Vite URL.",
    );
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
  createReadStream(file).pipe(res);
}

type Handler = (body: any, url: URL) => unknown;

const routes: Record<string, Handler> = {
  "/api/v1/machine/mutate": (body) => {
    const uid =
      body?.machine_identification_unique as MachineIdentificationUnique;
    const sim = uid && plant.byUid(uid);
    if (!sim) throw new MutationError("no such machine");
    sim.mutate(body.data as Mutation, plant);
    touch();
  },
  "/api/v1/write_machine_device_identification": (body) => {
    plant.writeDeviceIdentification(
      body.hardware_identification_ethercat.subdevice_index,
      body.device_machine_identification,
    );
    touch();
    broadcastMain(["EthercatDevicesEvent"]);
  },
  "/api/v1/write_modbus_device_assignment": (body) => {
    plant.writeModbusAssignment(
      body.port,
      body.device_machine_identification ?? null,
    );
    touch();
    broadcastMain(["ModbusDevicesEvent"]);
  },
  "/api/v1/modbus/scan": () => {
    broadcastMain(["ModbusDevicesEvent"]);
  },
  // used by troubleshoot.restartBackend / restartBackendIntoPreop in ui/src/browser-shim.ts
  "/demo/restart": (_body, url) => {
    restartBackend(url.searchParams.get("preop") === "1");
  },
  // troubleshoot.rebootHmi: back to the factory demo state
  "/demo/reset": () => {
    resetDemo("Reboot HMI Panel");
  },
  // ui/src/browser-shim.ts reports touches, clicks and key presses
  "/demo/activity": () => {
    touch();
  },
  "/demo/ethercat": (body) => {
    plant.ethercatEnabled = !!body?.enabled;
  },
};

// GET /api/v2/machine/<slug>/<serial> — used by the graph Excel export
const V2_SLUGS: Record<string, string> = {
  winder_v1: "winder2",
  extruder_v2: "extruder3",
  laser_v1: "laser1",
  aquapath_v1: "aquapath1",
};

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }

  const v2 = /^\/api\/v2\/machine\/([a-z0-9_]+)\/(\d+)$/.exec(url.pathname);
  if (v2 && req.method === "GET") {
    const sim = plant
      .active()
      .find((s) => s.slug === V2_SLUGS[v2[1]] && s.serial === Number(v2[2]));
    if (!sim) return sendJson(res, 404, { error: "no such machine" });
    return sendJson(res, 200, {
      machine: sim.uid,
      state: { is_default_state: false, ...sim.state() },
      live_values: sim.live(),
    });
  }

  if (url.pathname === "/demo/markers" && req.method === "GET") {
    return sendJson(res, 200, { markers: demoMarkers });
  }
  if (url.pathname === "/demo/status" && req.method === "GET") {
    return sendJson(res, 200, {
      generation: resetGeneration,
      idle_reset_s: IDLE_RESET_S,
    });
  }

  const route = routes[url.pathname];
  if (route && req.method === "POST") {
    if (down) return sendJson(res, 503, { error: "backend is restarting" });
    try {
      route(await readJson(req), url);
      return sendJson(res, 200, { success: true, error: null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!(e instanceof MutationError))
        console.warn(`${url.pathname}: ${message}`);
      return sendJson(res, 500, { error: message });
    }
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/demo/")) {
    return sendJson(res, 404, { error: "not found" });
  }
  serveStatic(req, res);
}

const http = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e) });
  });
});

// ------------------------------------------------------------------ Socket.IO

const io = new Server(http, {
  parser: msgpackParser,
  cors: { origin: "*" },
  // refuse new connections while "restarting", like a backend that is down
  allowRequest: (_req, cb) => cb(null, !down),
});

// The UI sometimes opens the same machine namespace twice on one connection
// (two socket objects for one path). socket.io treats the second CONNECT as a
// protocol error and closes the whole connection, /main included; the real
// backend (socketioxide) accepts it. Replace the old socket instead.
io.of("/main").once("connection", (socket) => {
  const proto = Object.getPrototypeOf(socket.client);
  if (proto.__demoReconnectPatch) return;
  const ondecoded = proto.ondecoded;
  proto.ondecoded = function (packet: { type: number; nsp: string }) {
    if (packet.type === 0 /* CONNECT */) {
      const existing = this.nsps.get(this._parseNamespace(packet).namespace);
      if (existing) existing._onclose("client namespace disconnect");
    }
    return ondecoded.call(this, packet);
  };
  proto.__demoReconnectPatch = true;
});

const mainSockets = new Set<Socket>();
const machineSockets = new Map<string, Set<Socket>>();

function mainEvents(names?: string[]) {
  const all = {
    EthercatStateEvent: () =>
      event("EthercatStateEvent", { State: plant.ethercatState }),
    EthercatInterfaceDiscoveryEvent: () =>
      event(
        "EthercatInterfaceDiscoveryEvent",
        plant.ethercatEnabled ? { Done: "enp2s0" } : { Discovering: true },
      ),
    EthercatDevicesEvent: () =>
      event(
        "EthercatDevicesEvent",
        plant.ethercatState === "no interface"
          ? { Done: { devices: [] } }
          : { Done: { devices: plant.devices } },
      ),
    ModbusDevicesEvent: () =>
      event("ModbusDevicesEvent", { devices: plant.modbus }),
    MachinesEvent: () => event("MachinesEvent", { machines: plant.machines }),
  };
  return (names ?? Object.keys(all)).map((n) => all[n as keyof typeof all]());
}

function broadcastMain(names?: string[]) {
  const events = mainEvents(names);
  for (const s of mainSockets) for (const e of events) s.emit("event", e);
}

io.of("/main").on("connection", (socket) => {
  mainSockets.add(socket);
  for (const e of mainEvents()) socket.emit("event", e);
  socket.on("disconnect", () => mainSockets.delete(socket));
});

/** The defaults the UI uses for its "reset to default" buttons. */
function defaultState(sim: MachineSim) {
  const fresh = plant.freshCopy(sim);
  return event("StateEvent", { is_default_state: true, ...fresh.state() });
}

function namespaceUid(name: string): MachineIdentificationUnique | null {
  const m = MACHINE_NAMESPACE_RE.exec(name);
  if (!m) return null;
  return {
    machine_identification: { vendor: Number(m[1]), machine: Number(m[2]) },
    serial: Number(m[3]),
  };
}

const machineNamespaces = io.of(MACHINE_NAMESPACE_RE);

// The UI matches machine sockets to the machine list by serial only, so with
// several serial-1 machines it also opens namespaces for machines that are not
// running (e.g. after a restart into preop). Rejecting them, or calling
// socket.disconnect(true), disturbs the engine.io connection all namespaces
// share and takes /main down with it. Such sockets are accepted and kept quiet
// instead; every restart closes all connections, so they re-subscribe once the
// machine is back.
machineNamespaces.on("connection", (socket) => {
  const uid = namespaceUid(socket.nsp.name);
  if (!uid) {
    socket.disconnect();
    return;
  }
  const k = key(uid);
  if (!machineSockets.has(k)) machineSockets.set(k, new Set());
  machineSockets.get(k)!.add(socket);
  socket.on("disconnect", () => machineSockets.get(k)?.delete(socket));
  const sim = plant.byUid(uid);
  if (!sim) return;
  socket.emit("event", defaultState(sim));
  socket.emit(
    "event",
    event("StateEvent", { is_default_state: false, ...sim.state() }),
  );
  for (const h of history.get(k) ?? []) {
    socket.emit("event", { name: "LiveValuesEvent", data: h.data, ts: h.ts });
  }
});

/** Drops every engine.io connection; clients see "transport close" and reconnect. */
function closeAllConnections() {
  const clients = (
    io.engine as unknown as { clients: Record<string, { close(): void }> }
  ).clients;
  for (const client of Object.values(clients)) client.close();
}

/** Emulates `systemctl restart qitech-control-server`. */
function restartBackend(preop: boolean) {
  down = true;
  // reply to the HTTP request first, then drop the transports
  setTimeout(() => {
    closeAllConnections();
    plant.restart(preop);
    console.log(
      `backend restarted (${plant.ethercatState}), machines: ${plant.machines.length}`,
    );
    setTimeout(() => {
      down = false;
    }, RESTART_DOWNTIME_MS);
  }, 50);
}

// ------------------------------------------------------------------ main loop

const lastStateEmit = new Map<string, number>();
let lastTick = performance.now();
let lastRecord = Date.now();

setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.25, (now - lastTick) / 1000);
  lastTick = now;
  if (down) return;

  if (
    IDLE_RESET_S > 0 &&
    touchedSinceReset &&
    Date.now() - lastInput > IDLE_RESET_S * 1000
  ) {
    resetDemo(`no input for ${IDLE_RESET_S} s`);
    return;
  }

  plant.step(dt);
  if (Date.now() - lastRecord >= HISTORY_INTERVAL_MS) {
    lastRecord = Date.now();
    record(lastRecord);
  }

  for (const sim of plant.active()) {
    const k = key(sim.uid);
    const sockets = machineSockets.get(k);
    const notices = sim.notices.splice(0);
    if (!sockets || sockets.size === 0) continue;
    const live = event("LiveValuesEvent", sim.live());
    for (const s of sockets) s.emit("event", live);
    const wall = Date.now();
    if (
      sim.dirty &&
      wall - (lastStateEmit.get(k) ?? 0) >= STATE_MIN_INTERVAL_MS
    ) {
      sim.dirty = false;
      lastStateEmit.set(k, wall);
      const state = event("StateEvent", {
        is_default_state: false,
        ...sim.state(),
      });
      for (const s of sockets) s.emit("event", state);
    }
    for (const n of notices) {
      const e = event("NoticeEvent", n);
      for (const s of sockets) s.emit("event", e);
    }
  }
}, 1000 / TICK_HZ);

http.listen(PORT, HOST, () => {
  console.log(
    `control-demo: http://localhost:${PORT} (scenario: ${SCENARIO}, static: ${STATIC_DIR})`,
  );
});
