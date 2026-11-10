// The simulated qitech_control backend, running inside the visitor's browser.
//
// Nothing goes over the network: the UI's Socket.IO client is replaced by
// backend/socketio-client.ts (a Vite alias), which connects to this module
// in memory, and its REST calls (/api/v1/…, /api/v2/…) are answered by a
// `fetch` hook installed here. Every browser tab runs its own line.

import { key, Plant } from "./plant.ts";
import type { Scenario } from "./plant.ts";
import { event, MACHINE_NAMESPACE_RE, MutationError } from "./protocol.ts";
import type {
  Event,
  MachineIdentificationUnique,
  Mutation,
} from "./protocol.ts";
import type { MachineSim } from "./sim/machine.ts";
import { applyTimelineStart, runTimeline } from "./timeline.ts";
import type { DemoMarker } from "./timeline.ts";

export type BackendConfig = {
  scenario: Scenario;
  /**
   * Back to the initial demo state after this many seconds without input
   * (0 = never), so the next visitor at a kiosk finds the line running.
   */
  idleResetS: number;
  /** How long an emulated backend restart takes. */
  restartDowntimeMs: number;
  /** Pre-filled graph history. */
  historyS: number;
  /** History sample spacing. */
  historyIntervalMs: number;
};

export const DEFAULT_CONFIG: BackendConfig = {
  scenario: "running",
  idleResetS: 0,
  restartDowntimeMs: 2500,
  historyS: 3600,
  historyIntervalMs: 2000,
};

/** One connected namespace socket, as seen from the backend. */
export type Connection = {
  /** Deliver an `event` message to the client. */
  emit(e: Event<unknown>): void;
  /** The backend dropped the connection ("transport close"). */
  close(): void;
};

export type ConnectionHandle = { disconnect(): void };

const TICK_HZ = 30;
const STATE_MIN_INTERVAL_MS = 100;
/** Simulation step while catching up after the tab was in the background. */
const CATCH_UP_DT = 0.1;

const V2_SLUGS: Record<string, string> = {
  winder_v1: "winder2",
  extruder_v2: "extruder3",
  laser_v1: "laser1",
  aquapath_v1: "aquapath1",
};

export class Backend {
  readonly config: BackendConfig;
  readonly plant: Plant;
  /** Graph markers of the pre-filled shift (backend/timeline.ts), absolute timestamps. */
  markers: DemoMarker[] = [];
  /** True while an emulated restart is in progress: connections are refused. */
  down = false;

  private history = new Map<
    string,
    { ts: number; data: Record<string, unknown> }[]
  >();
  private mainConns = new Set<Connection>();
  private machineConns = new Map<string, Set<Connection>>();
  private lastStateEmit = new Map<string, number>();
  private lastInput = Date.now();
  private touchedSinceReset = false;
  private simTime = Date.now();
  private lastRecord = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;
  private onReset: () => void;

  constructor(config: BackendConfig, onReset: () => void) {
    this.config = config;
    this.onReset = onReset;
    this.plant = new Plant(config.scenario);
    this.prefillHistory();
  }

  start() {
    this.simTime = Date.now();
    this.timer ??= setInterval(() => this.tick(), 1000 / TICK_HZ);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // ---------------------------------------------------------------- history
  //
  // The UI only keeps graph data it received while connected, so the backend
  // records LiveValuesEvents itself and replays them to each new connection.
  // At startup it fast-forwards the simulation through the past hour.

  private record(ts: number) {
    const cutoff = ts - this.config.historyS * 1000;
    for (const sim of this.plant.active()) {
      const k = key(sim.uid);
      let h = this.history.get(k);
      if (!h) this.history.set(k, (h = []));
      h.push({ ts, data: sim.live() });
      let drop = 0;
      while (drop < h.length && h[drop].ts < cutoff) drop++;
      if (drop) h.splice(0, drop);
    }
  }

  private prefillHistory() {
    const { historyS, historyIntervalMs } = this.config;
    this.history.clear();
    this.markers = [];
    const now = Date.now();
    const dt = 0.1;
    const stepsPerSample = Math.round(historyIntervalMs / 1000 / dt);
    const samples = Math.floor((historyS * 1000) / historyIntervalMs);
    const timeline = this.config.scenario === "running";
    if (timeline) applyTimelineStart(this.plant);
    for (let i = samples; i > 0; i--) {
      if (timeline) {
        const from = (i * historyIntervalMs) / 1000;
        const to = ((i - 1) * historyIntervalMs) / 1000;
        this.markers.push(...runTimeline(this.plant, from, to, now));
      }
      for (let j = 0; j < stepsPerSample; j++) this.plant.step(dt);
      this.record(now - (i - 1) * historyIntervalMs);
    }
    for (const sim of this.plant.active()) {
      sim.notices.length = 0;
      sim.dirty = true;
    }
    this.lastRecord = now;
  }

  // ------------------------------------------------------------ idle reset

  /** Operator input: a touch/click/key or any API write. */
  touch() {
    this.lastInput = Date.now();
    this.touchedSinceReset = true;
  }

  // ---------------------------------------------------------- connections

  /**
   * Opens a Socket.IO namespace. Returns null while the backend is "down"
   * (the client retries, like socket.io's reconnection).
   */
  connect(nsp: string, conn: Connection): ConnectionHandle | null {
    if (this.down) return null;
    if (nsp === "/main") {
      this.mainConns.add(conn);
      for (const e of this.mainEvents()) conn.emit(e);
      return { disconnect: () => this.mainConns.delete(conn) };
    }
    const uid = namespaceUid(nsp);
    if (!uid) return null;
    // The UI matches machine sockets to the machine list by serial only, so
    // it also opens namespaces of machines that are not running. Such sockets
    // are accepted and kept quiet, like on the real backend.
    const k = key(uid);
    let set = this.machineConns.get(k);
    if (!set) this.machineConns.set(k, (set = new Set()));
    set.add(conn);
    const handle = { disconnect: () => set.delete(conn) };
    const sim = this.plant.byUid(uid);
    if (!sim) return handle;
    conn.emit(this.defaultState(sim));
    conn.emit(event("StateEvent", { is_default_state: false, ...sim.state() }));
    for (const h of this.history.get(k) ?? []) {
      conn.emit({ name: "LiveValuesEvent", data: h.data, ts: h.ts });
    }
    return handle;
  }

  private mainEvents(names?: string[]): Event<unknown>[] {
    const plant = this.plant;
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

  private broadcastMain(names?: string[]) {
    const events = this.mainEvents(names);
    for (const c of this.mainConns) for (const e of events) c.emit(e);
  }

  /** The defaults the UI uses for its "reset to default" buttons. */
  private defaultState(sim: MachineSim) {
    const fresh = this.plant.freshCopy(sim);
    return event("StateEvent", { is_default_state: true, ...fresh.state() });
  }

  private closeAllConnections() {
    const all = [
      ...this.mainConns,
      ...[...this.machineConns.values()].flatMap((s) => [...s]),
    ];
    this.mainConns.clear();
    this.machineConns.clear();
    for (const c of all) c.close();
  }

  /** Emulates `systemctl restart qitech-control-server`. */
  restart(preop: boolean) {
    this.down = true;
    // let the caller's request resolve first, then drop the transports
    setTimeout(() => {
      this.closeAllConnections();
      this.plant.restart(preop);
      setTimeout(() => {
        this.down = false;
      }, this.config.restartDowntimeMs);
    }, 50);
  }

  setEthercatEnabled(enabled: boolean) {
    this.plant.ethercatEnabled = enabled;
  }

  // --------------------------------------------------------------- REST API

  /**
   * The legacy REST API the UI calls with `fetch`. Returns null for paths
   * that are not part of the API.
   */
  async handleRequest(
    method: string,
    pathname: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown } | null> {
    const v2 = /^\/api\/v2\/machine\/([a-z0-9_]+)\/(\d+)$/.exec(pathname);
    if (v2 && method === "GET") {
      const sim = this.plant
        .active()
        .find((s) => s.slug === V2_SLUGS[v2[1]] && s.serial === Number(v2[2]));
      if (!sim) return { status: 404, body: { error: "no such machine" } };
      return {
        status: 200,
        body: {
          machine: sim.uid,
          state: { is_default_state: false, ...sim.state() },
          live_values: sim.live(),
        },
      };
    }

    const route = this.routes[pathname];
    if (route && method === "POST") {
      if (this.down)
        return { status: 503, body: { error: "backend is restarting" } };
      try {
        route(body as any);
        return { status: 200, body: { success: true, error: null } };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!(e instanceof MutationError))
          console.warn(`${pathname}: ${message}`);
        return { status: 500, body: { error: message } };
      }
    }
    if (pathname.startsWith("/api/"))
      return { status: 404, body: { error: "not found" } };
    return null;
  }

  private routes: Record<string, (body: any) => void> = {
    "/api/v1/machine/mutate": (body) => {
      const uid =
        body?.machine_identification_unique as MachineIdentificationUnique;
      const sim = uid && this.plant.byUid(uid);
      if (!sim) throw new MutationError("no such machine");
      sim.mutate(body.data as Mutation, this.plant);
      this.touch();
    },
    "/api/v1/write_machine_device_identification": (body) => {
      this.plant.writeDeviceIdentification(
        body.hardware_identification_ethercat.subdevice_index,
        body.device_machine_identification,
      );
      this.touch();
      this.broadcastMain(["EthercatDevicesEvent"]);
    },
    "/api/v1/write_modbus_device_assignment": (body) => {
      this.plant.writeModbusAssignment(
        body.port,
        body.device_machine_identification ?? null,
      );
      this.touch();
      this.broadcastMain(["ModbusDevicesEvent"]);
    },
    "/api/v1/modbus/scan": () => {
      this.broadcastMain(["ModbusDevicesEvent"]);
    },
  };

  // -------------------------------------------------------------- main loop

  private tick() {
    const now = Date.now();
    if (this.down) {
      this.simTime = now;
      return;
    }

    const { idleResetS, historyS, historyIntervalMs } = this.config;
    if (
      idleResetS > 0 &&
      this.touchedSinceReset &&
      now - this.lastInput > idleResetS * 1000
    ) {
      this.stop();
      this.onReset();
      return;
    }

    // Browsers throttle timers in background tabs; catch up in small steps
    // so the line keeps running in real time and the graphs have no gaps.
    const elapsed = Math.min((now - this.simTime) / 1000, historyS);
    this.simTime = now;
    const catchingUp = elapsed > 0.25;
    let t = now - elapsed * 1000;
    let left = elapsed;
    while (left > 1e-9) {
      const dt = Math.min(left, catchingUp ? CATCH_UP_DT : 0.25);
      this.plant.step(dt);
      left -= dt;
      t += dt * 1000;
      if (t - this.lastRecord >= historyIntervalMs) {
        this.lastRecord = t;
        this.record(Math.round(t));
        if (catchingUp && left > 1e-9) this.emitRecorded(Math.round(t));
      }
    }

    for (const sim of this.plant.active()) {
      const k = key(sim.uid);
      const conns = this.machineConns.get(k);
      const notices = sim.notices.splice(0);
      if (!conns || conns.size === 0) continue;
      const live = event("LiveValuesEvent", sim.live());
      for (const c of conns) c.emit(live);
      if (
        sim.dirty &&
        now - (this.lastStateEmit.get(k) ?? 0) >= STATE_MIN_INTERVAL_MS
      ) {
        sim.dirty = false;
        this.lastStateEmit.set(k, now);
        const state = event("StateEvent", {
          is_default_state: false,
          ...sim.state(),
        });
        for (const c of conns) c.emit(state);
      }
      for (const n of notices) {
        const e = event("NoticeEvent", n);
        for (const c of conns) c.emit(e);
      }
    }
  }

  /** Sends a history sample taken while catching up to the open graphs. */
  private emitRecorded(ts: number) {
    for (const [k, conns] of this.machineConns) {
      const last = this.history.get(k)?.at(-1);
      if (!last || last.ts !== ts) continue;
      for (const c of conns)
        c.emit({ name: "LiveValuesEvent", data: last.data, ts });
    }
  }
}

function namespaceUid(name: string): MachineIdentificationUnique | null {
  const m = MACHINE_NAMESPACE_RE.exec(name);
  if (!m) return null;
  return {
    machine_identification: { vendor: Number(m[1]), machine: Number(m[2]) },
    serial: Number(m[3]),
  };
}

// ------------------------------------------------------------------ singleton

let instance: Backend | undefined;

/**
 * Settings come from the page URL, so one static build serves both the
 * website and the kiosk: `?scenario=cold`, `?idleReset=60`.
 */
export function configFromUrl(search: string): BackendConfig {
  const q = new URLSearchParams(search);
  const num = (name: string, fallback: number) => {
    const v = Number(q.get(name));
    return q.has(name) && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    ...DEFAULT_CONFIG,
    scenario: q.get("scenario") === "cold" ? "cold" : "running",
    idleResetS: num("idleReset", DEFAULT_CONFIG.idleResetS),
  };
}

/** Back to the initial demo state: settings and presets cleared, page reloaded. */
export function resetDemo() {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // storage unavailable
  }
  window.location.reload();
}

export function getBackend(): Backend {
  if (!instance) {
    instance = new Backend(configFromUrl(window.location.search), resetDemo);
    instance.start();
    installFetchHook(instance);
  }
  return instance;
}

/** Answers the UI's REST calls (same origin, /api/…) from the local backend. */
function installFetchHook(backend: Backend) {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url, window.location.href);
    if (
      url.origin !== window.location.origin ||
      !url.pathname.startsWith("/api/")
    ) {
      return realFetch(input, init);
    }
    const text = request.method === "GET" ? "" : await request.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return json(400, { error: "invalid JSON" });
    }
    const res = await backend.handleRequest(request.method, url.pathname, body);
    return res ? json(res.status, res.body) : json(404, { error: "not found" });
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
