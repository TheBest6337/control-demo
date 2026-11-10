import { describe, expect, it } from "vitest";
import { SEEDS } from "@/demo/presets";
import { Plant } from "../backend/plant.ts";

function run(plant: Plant, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 30) plant.step(1 / 30);
}

const seed = (machine: number, material: string): any =>
  SEEDS.find(
    (s) => s.machineIdentification.machine === machine && s.name.startsWith(material),
  )!.data;

describe("demo presets", () => {
  for (const material of ["PLA", "PETG", "ABS"]) {
    it(`${material}: extruder, winder and laser presets together hold the diameter`, () => {
      const plant = new Plant("running");
      const extruder = plant.find<any>("extruder3")!;
      const winder = plant.find<any>("winder2")!;
      const laser = plant.find<any>("laser1")!;
      const e = seed(0x16, material);
      const w = seed(0x02, material);
      const l = seed(0x06, material);
      extruder.mutate({ SetNozzleHeatingTemperature: e.targetNozzleHeatingTemperature }, plant);
      extruder.mutate({ SetFrontHeatingTargetTemperature: e.targetFrontHeatingTemperature }, plant);
      extruder.mutate({ SetMiddleHeatingTemperature: e.targetMiddleHeatingTemperature }, plant);
      extruder.mutate({ SetBackHeatingTargetTemperature: e.targetBackHeatingTemperature }, plant);
      extruder.mutate({ SetInverterTargetRpm: e.targetInverterRpm }, plant);
      winder.mutate({ SetPullerTargetSpeed: w.puller_state.target_speed }, plant);
      winder.mutate({ SetPullerRegulationMode: w.puller_state.regulation }, plant);
      laser.mutate({ SetTargetDiameter: l.targetDiameter }, plant);
      laser.mutate({ SetLowerTolerance: l.lowerTolerance }, plant);
      laser.mutate({ SetHigherTolerance: l.higherTolerance }, plant);
      run(plant, 300);
      expect(extruder.live().motor_status.screw_rpm).toBeGreaterThan(e.targetInverterRpm - 1);
      expect(extruder.live().pressure).toBeLessThan(e.pressureLimit * 0.8);
      expect(Math.abs(laser.diameter - l.targetDiameter)).toBeLessThan(l.lowerTolerance);
      expect(laser.state().laser_state.in_tolerance).toBe(true);
    });
  }
});
