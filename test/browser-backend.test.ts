// The in-browser backend as the UI sees it: Socket.IO namespaces through the
// in-memory client (the `socket.io-client` alias) and REST calls through the
// `fetch` hook, with no network involved.

import { describe, expect, it } from "vitest";
import "@/routes/router";
import { machinesEventSchema } from "@/client/mainNamespace";
import { getClient } from "@/client/useClient";
import * as winder2 from "@/machines/winder/winder2/winder2Namespace";
import { io } from "socket.io-client";
import { z } from "zod";
import { getBackend } from "../backend/browser.ts";

const WINDER = "/machine/1/2/1";
const winderUid = {
  machine_identification: { vendor: 1, machine: 2 },
  serial: 1,
};

function collect(path: string) {
  const socket = io(window.location.origin + path, { autoConnect: false });
  const log: string[] = [];
  const events: any[] = [];
  socket.on("connect", () => log.push("connect"));
  socket.on("disconnect", (reason: string) => log.push(`disconnect:${reason}`));
  socket.on("event", (e: any) => {
    if (!log.includes("connect")) log.push("event-before-connect");
    events.push(e);
  });
  return { socket, log, events };
}

const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("in-browser backend", () => {
  it("/main delivers the machine list after connect", async () => {
    const { socket, log, events } = collect("/main");
    socket.connect();
    await until(() => events.some((e) => e.name === "MachinesEvent"));
    expect(log[0]).toBe("connect");
    const machines = events.find((e) => e.name === "MachinesEvent");
    expect(machinesEventSchema.safeParse(machines).success).toBe(true);
    expect(machines.data.machines).toHaveLength(4);
    socket.disconnect();
  });

  it("a machine namespace replays an hour of history, then streams live values", async () => {
    const { socket, log, events } = collect(WINDER);
    socket.connect();
    await until(() => events.length > 1800);
    expect(log).toEqual(["connect"]);
    const live = events.filter((e) => e.name === "LiveValuesEvent");
    const span = live.at(-1).ts - live[0].ts;
    expect(span).toBeGreaterThan(55 * 60 * 1000);
    for (const e of [live[0], live.at(-1)])
      expect(winder2.liveValuesEventSchema.safeParse(e).success).toBe(true);
    const n = live.length;
    await until(
      () => events.filter((e) => e.name === "LiveValuesEvent").length > n + 5,
    );
    socket.disconnect();
    expect(log).toEqual(["connect", "disconnect:io client disconnect"]);
  });

  it("mutations go through fetch to the simulation, without the network", async () => {
    const { socket, events } = collect(WINDER);
    socket.connect();
    await until(() => events.length > 0);
    const res = await getClient().machineMutate(
      {
        machine_identification_unique: winderUid,
        data: { SetPullerTargetSpeed: 11.5 },
      },
      z.any(),
    );
    expect(res).toEqual({ success: true, error: null });
    await until(() =>
      events.some(
        (e) =>
          e.name === "StateEvent" &&
          !e.data.is_default_state &&
          e.data.puller_state.target_speed === 11.5,
      ),
    );
    socket.disconnect();
  });

  it("restart drops every connection and the client reconnects", async () => {
    const backend = getBackend();
    const { socket, log } = collect("/main");
    socket.connect();
    await until(() => log.includes("connect"));
    backend.restart(false);
    await until(() => log.includes("disconnect:transport close"));
    expect(backend.down).toBe(true);
    await until(() => log.filter((l) => l === "connect").length === 2);
    expect(backend.down).toBe(false);
    socket.disconnect();
  });
});
