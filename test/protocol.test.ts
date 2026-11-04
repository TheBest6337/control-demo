// Guards the mock backend against drift from the vendored UI: every payload is
// parsed with the UI's own zod schemas, and every mutation the UI's hooks can
// send must be understood by the matching simulation.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// must come first: the UI's modules import each other in cycles that only
// resolve in the order the app itself loads them (App → router → routes)
import "@/routes/router";
import {
  ethercatDevicesSchema,
  machinesEventSchema,
  modbusDevicesEventDataSchema,
} from "@/client/mainNamespace";
import * as aquapath1 from "@/machines/aquapath/aquapath1/aquapath1Namespace";
import * as extruder3 from "@/machines/extruder/extruder3/extruder3Namespace";
import * as laser1 from "@/machines/laser/laser1/laser1Namespace";
import * as winder2 from "@/machines/winder/winder2/winder2Namespace";
import { Plant } from "../server/plant.ts";
import { event, MutationError } from "../server/protocol.ts";
import type { MachineSim } from "../server/sim/machine.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = (p: string) => path.join(here, "..", "ui", "src", p);

const SCHEMAS: Record<string, { state: any; live: any; hook: string }> = {
  winder2: { ...pick(winder2), hook: "machines/winder/winder2/useWinder.ts" },
  extruder3: {
    ...pick(extruder3),
    hook: "machines/extruder/extruder3/useExtruder.ts",
  },
  laser1: { ...pick(laser1), hook: "machines/laser/laser1/useLaser1.ts" },
  aquapath1: {
    ...pick(aquapath1),
    hook: "machines/aquapath/aquapath1/useAquapath.ts",
  },
};

function pick(m: any) {
  return { state: m.stateEventSchema, live: m.liveValuesEventSchema };
}

function run(plant: Plant, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 30) plant.step(1 / 30);
}

/** Mutation variant names used in a hook file. */
function mutationNames(file: string): string[] {
  const src = readFileSync(ui(file), "utf8");
  const names = new Set<string>();
  const patterns = [
    /data:\s*\{\s*([A-Z][A-Za-z]+)\s*:/g,
    /data:\s*"([A-Z][A-Za-z]+)"/g,
    /^\s+([A-Z][A-Za-z]+):\s*z\./gm,
    /z\.literal\("([A-Z][A-Za-z]+)"\)/g,
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) names.add(m[1]);
  return [...names];
}

/** A plausible value for a mutation, so type checks pass. */
function sampleValue(name: string, sim: MachineSim): unknown {
  const s = sim.state() as any;
  const table: Record<string, unknown> = {
    SetMode: "Pull",
    SetExtruderMode: "Heat",
    SetAquaPathMode: "Auto",
    SetPullerRegulationMode: "Diameter",
    SetPullerGearRatio: "OneToFive",
    SetSpoolRegulationMode: "MinMax",
    SetSpoolAutomaticAction: "Hold",
    SetHeatingAlgorithm: "Pid",
    SetPressurePidSettings: { kp: 1, ki: 0.1, kd: 0 },
    SetTemperaturePidSettings: { kp: 1, ki: 0.1, kd: 0, zone: "front" },
    StartPressurePidAutoTune: { tune_delta: 0.5, frequency_step_hz: 5 },
    StopPressurePidAutoTune: {},
    SetPullerAdaptiveReferenceMachine: null,
    ResetInverter: true,
  };
  if (name in table) return table[name];
  if (/^(Goto|Zero)|^ResetSpoolProgress$/.test(name)) return undefined;
  if (
    /Enable|Forward|Flow$|Direction|Regulation$|IsEnabled|Enabled$|Warning$/.test(
      name,
    )
  )
    return true;
  void s;
  return 3;
}

for (const scenario of ["running", "cold"] as const) {
  describe(`scenario ${scenario}`, () => {
    const plant = new Plant(scenario);
    run(plant, 20);

    it("lists the demo line without errors", () => {
      const slugs = plant
        .active()
        .map((s) => s.slug)
        .sort();
      expect(slugs).toEqual(["aquapath1", "extruder3", "laser1", "winder2"]);
      expect(() =>
        machinesEventSchema.parse(
          event("MachinesEvent", { machines: plant.machines }),
        ),
      ).not.toThrow();
    });

    it("main namespace payloads match the UI schemas", () => {
      expect(() =>
        ethercatDevicesSchema.parse({ devices: plant.devices }),
      ).not.toThrow();
      expect(() =>
        modbusDevicesEventDataSchema.parse({ devices: plant.modbus }),
      ).not.toThrow();
    });

    for (const sim of plant.active()) {
      const schema = SCHEMAS[sim.slug];
      it(`${sim.slug}: StateEvent and LiveValuesEvent parse`, () => {
        for (const isDefault of [true, false]) {
          const data = {
            is_default_state: isDefault,
            ...(isDefault ? plant.freshCopy(sim) : sim).state(),
          };
          const r = schema.state.safeParse(event("StateEvent", data));
          expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
        }
        const r = schema.live.safeParse(event("LiveValuesEvent", sim.live()));
        expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
      });
    }
  });
}

describe("mutations", () => {
  for (const [slug, schema] of Object.entries(SCHEMAS)) {
    const names = mutationNames(schema.hook);
    it(`${slug}: understands all ${names.length} mutations the UI sends`, () => {
      expect(names.length).toBeGreaterThan(3);
      for (const name of names) {
        const plant = new Plant("cold");
        const sim = plant.active().find((s) => s.slug === slug)!;
        const value = sampleValue(name, sim);
        try {
          sim.mutate(value === undefined ? name : { [name]: value }, plant);
        } catch (e) {
          if (e instanceof MutationError && /^unknown/.test(e.message)) throw e;
          // other rejections (wrong state for the command) are fine here
        }
        const r = schema.state.safeParse(
          event("StateEvent", { is_default_state: false, ...sim.state() }),
        );
        expect(r.success, `${name}: ${JSON.stringify(r.error?.issues)}`).toBe(
          true,
        );
      }
    });
  }
});

describe("behaviour", () => {
  it("extruder heats up from cold and extrudes", () => {
    const plant = new Plant("cold");
    const ex = plant.find<any>("extruder3")!;
    for (const [m, v] of [
      ["SetNozzleHeatingTemperature", 200],
      ["SetFrontHeatingTargetTemperature", 200],
      ["SetMiddleHeatingTemperature", 195],
      ["SetBackHeatingTargetTemperature", 190],
      ["SetExtruderMode", "Extrude"],
      ["SetInverterTargetRpm", 30],
    ] as const) {
      ex.mutate({ [m]: v }, plant);
    }
    run(plant, 15);
    expect(ex.live().motor_status.screw_rpm).toBe(0); // still too cold
    run(plant, 300);
    expect(ex.live().front_temperature).toBeGreaterThan(190);
    expect(ex.live().motor_status.screw_rpm).toBeGreaterThan(25);
    expect(ex.live().pressure).toBeGreaterThan(10);
  });

  it("winder homes, zeroes and winds", () => {
    const plant = new Plant("cold");
    const w = plant.find<any>("winder2")!;
    expect(() => w.mutate({ SetMode: "Wind" }, plant)).toThrow();
    w.mutate("GotoTraverseHome", plant);
    w.mutate("ZeroTensionArmAngle", plant);
    run(plant, 5);
    expect(w.state().traverse_state.is_homed).toBe(true);
    expect(w.state().mode_state.can_wind).toBe(true);
    w.mutate({ SetPullerTargetSpeed: 12 }, plant);
    w.mutate({ SetMode: "Wind" }, plant);
    run(plant, 30);
    expect(w.live().puller_speed).toBeCloseTo(12, 0);
    expect(w.live().spool_progress).toBeGreaterThan(4);
    expect(w.live().spool_rpm).toBeGreaterThan(10);
  });

  it("winder diameter regulation pulls the laser back into tolerance", () => {
    const plant = new Plant("running");
    const laser = plant.find<any>("laser1")!;
    const winder = plant.find<any>("winder2")!;
    // slow the puller: filament gets thick
    winder.mutate({ SetPullerRegulationMode: "Speed" }, plant);
    winder.mutate({ SetPullerTargetSpeed: 8.5 }, plant);
    run(plant, 20);
    expect(laser.diameter).toBeGreaterThan(1.8);
    expect(laser.state().laser_state.in_tolerance).toBe(false);
    winder.mutate({ SetPullerAdaptiveMaxSpeedChangePercent: 0.3 }, plant);
    winder.mutate({ SetPullerRegulationMode: "Diameter" }, plant);
    run(plant, 240);
    expect(Math.abs(laser.diameter - 1.75)).toBeLessThan(0.05);
  });

  it("aquapath heats to target in Auto", () => {
    const plant = new Plant("cold");
    const a = plant.find<any>("aquapath1")!;
    a.mutate({ SetAquaPathMode: "Auto" }, plant);
    a.mutate({ SetLeftFlow: true }, plant);
    a.mutate({ SetLeftTemperature: 35 }, plant);
    expect(a.notices.length).toBeGreaterThan(0);
    run(plant, 120);
    expect(a.live().left_flow).toBeGreaterThan(5);
    expect(a.live().left_temperature).toBeGreaterThan(33);
  });

  it("restart builds machines from EEPROM assignments", () => {
    const plant = new Plant("running");
    expect(
      plant.devices.every(
        (d) => d.device_identification.device_machine_identification !== null,
      ),
    ).toBe(true);
    // move the winder's traverse stepper (role 3) to a new winder, serial 7
    const traverse = plant.devices.findIndex((d) => {
      const id = d.device_identification.device_machine_identification;
      return (
        id?.machine_identification_unique.machine_identification.machine ===
          2 && id.role === 3
      );
    });
    plant.writeDeviceIdentification(traverse, {
      machine_identification_unique: {
        machine_identification: { vendor: 1, machine: 2 },
        serial: 7,
      },
      role: 3,
    });
    plant.restart(false);
    const errorOf = (serial: number) =>
      plant.machines.find(
        (m) =>
          m.machine_identification_unique.machine_identification.machine ===
            2 && m.machine_identification_unique.serial === serial,
      )!.error;
    expect(errorOf(7)).toMatch(/Missing devices/);
    expect(errorOf(1)).toMatch(/role 3/);
    expect(plant.active().map((s) => s.slug)).not.toContain("winder2");
    plant.reset();
    expect(plant.active()).toHaveLength(4);
    plant.restart(true);
    expect(plant.ethercatState).toBe("preop");
    expect(plant.active().map((s) => s.slug)).toEqual(["laser1"]);
  });
});
