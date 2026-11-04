// ExtruderV2 (UI slug extruder3, machine 0x16). The older ExtruderV1
// (extruder2) is intentionally not part of the demo.
// Contract: ui/src/machines/extruder/extruder3/extruder3Namespace.ts and
// control/qitech_control/src/api/legacy/adapter/extruder_v1/.

import { MutationError } from "../protocol.ts";
import { MachineSim } from "./machine.ts";
import type { TerminalSpec, World } from "./machine.ts";
import {
  bool,
  clamp,
  Drift,
  lag,
  noise,
  num,
  oneOf,
  ramp,
  round,
} from "./util.ts";

export const ZONES = ["nozzle", "front", "middle", "back"] as const;
type Zone = (typeof ZONES)[number];
const MODES = ["Standby", "Heat", "Extrude"] as const;
type Mode = (typeof MODES)[number];
const ALGORITHMS = ["ObserverPi", "Pid"] as const;
type Algorithm = (typeof ALGORITHMS)[number];

type Gains = { kp: number; ki: number; kd: number };

// Defaults from control/qitech_control/src/machines/extruder1/heating_params.rs
// and qitech_control_core/src/controllers/heating/observer_pi.rs.
const TEMPERATURE_GAINS: Record<Algorithm, Gains> = {
  ObserverPi: { kp: 0.05, ki: 0.0002, kd: 0 },
  Pid: { kp: 0.16, ki: 0, kd: 0.008 },
};
const PRESSURE_GAINS: Gains = { kp: 0.01, ki: 0, kd: 0.02 };

const AMBIENT_C = 22;

// Thermal plant per zone: heater power [W], heat capacity [J/K], loss [W/K].
// Scaled so a zone heats from ambient to ~200 °C in about two minutes.
const PLANT: Record<Zone, { power: number; capacity: number; loss: number }> = {
  nozzle: { power: 400, capacity: 260, loss: 1.2 },
  front: { power: 900, capacity: 520, loss: 2.4 },
  middle: { power: 900, capacity: 540, loss: 2.4 },
  back: { power: 900, capacity: 500, loss: 2.6 },
};

const MAX_RPM = 120;
const RPM_RAMP = 15; // rpm/s, inverter acceleration

class HeatingZone {
  temperature = AMBIENT_C;
  target = 0;
  power = 0;
  gains: Gains;
  integral = 0;
  drift = new Drift(0.15, 20);
  constructor(gains: Gains, target: number) {
    this.gains = { ...gains };
    this.target = target;
  }
}

export class ExtruderSim extends MachineSim {
  readonly slug = "extruder3";
  readonly machineId = 0x0016;

  mode: Mode = "Standby";
  forward = true;
  usesRpm = true;
  targetRpm = 0;
  targetBar = 0;
  pressureLimit = 100;
  pressureLimitEnabled = true;
  nozzleTargetEnabled = true;
  minExtrusionTemperature = 150;
  algorithm: Algorithm = "ObserverPi";
  pressureGains: Gains = { ...PRESSURE_GAINS };
  zones: Record<Zone, HeatingZone>;

  // inverter / screw
  rpm = 0;
  pressure = 0;
  inverterFault = false;
  pressureIntegral = 0;
  energyKwh = 0;

  // pressure PID auto-tune
  autotune: { state: string; progress: number; result: Gains | null } = {
    state: "not_started",
    progress: 0,
    result: null,
  };
  autotuneElapsed = 0;

  constructor(serial: number) {
    super(serial);
    const g = TEMPERATURE_GAINS[this.algorithm];
    this.zones = {
      nozzle: new HeatingZone(g, 0),
      front: new HeatingZone(g, 0),
      middle: new HeatingZone(g, 0),
      back: new HeatingZone(g, 0),
    };
  }

  /** A warm machine extruding PLA, as a customer would find it in production. */
  preset() {
    const targets: Record<Zone, number> = {
      nozzle: 210,
      front: 205,
      middle: 200,
      back: 190,
    };
    for (const z of ZONES) {
      this.zones[z].target = targets[z];
      this.zones[z].temperature = targets[z] + noise(0.3);
    }
    this.mode = "Extrude";
    this.targetRpm = 32;
    this.rpm = 32;
    this.targetBar = 45;
    this.energyKwh = 18.42;
    this.pressure = this.steadyPressure(this.rpm);
  }

  terminals(): TerminalSpec[] {
    // vendor 2 (Beckhoff) product ids/revisions from ui/src/machines/properties.ts
    return [
      { role: 0, name: "EK1100", product_id: 0x044c2c52, revision: 0x120000 },
      { role: 1, name: "EL6021", product_id: 394604626, revision: 1376256 },
      { role: 2, name: "EL2004", product_id: 131346514, revision: 1179648 },
      { role: 3, name: "EL3021", product_id: 197996626, revision: 1310720 },
      { role: 4, name: "EL3204", product_id: 0x0c843052, revision: 1441792 },
    ];
  }

  private heatingActive() {
    return this.mode === "Heat" || this.mode === "Extrude";
  }

  private zoneTarget(z: Zone): number {
    if (!this.heatingActive()) return 0;
    if (z === "nozzle" && !this.nozzleTargetEnabled) return 0;
    return this.zones[z].target;
  }

  private meltTemperature() {
    return (
      (this.zones.front.temperature +
        this.zones.middle.temperature +
        this.zones.back.temperature) /
      3
    );
  }

  private canExtrude() {
    return ZONES.every((z) =>
      z === "nozzle" && !this.nozzleTargetEnabled
        ? true
        : this.zones[z].temperature >= this.minExtrusionTemperature,
    );
  }

  /** Melt pressure for a given screw speed: viscosity drops with temperature. */
  private steadyPressure(rpm: number) {
    const viscosity = 1.45 * Math.exp(-(this.meltTemperature() - 200) / 45);
    return Math.max(0, rpm * viscosity);
  }

  step(dt: number, _world: World) {
    // --- heating zones ---
    for (const z of ZONES) {
      const zone = this.zones[z];
      const plant = PLANT[z];
      const target = this.zoneTarget(z);
      let duty = 0;
      if (target > 0) {
        const err = target - zone.temperature;
        // feed-forward for the steady-state loss plus a PI correction
        const ff = (plant.loss * (target - AMBIENT_C)) / plant.power;
        zone.integral = clamp(zone.integral + err * dt * 0.002, -0.3, 0.3);
        duty = clamp(ff + err * 0.08 + zone.integral, 0, 1);
      } else {
        zone.integral = 0;
      }
      zone.power = duty * plant.power;
      // shear heat from the screw warms the barrel a little
      const shear = z === "nozzle" ? 0 : this.rpm * 0.6;
      const dT =
        (zone.power + shear - plant.loss * (zone.temperature - AMBIENT_C)) /
        plant.capacity;
      zone.temperature += dT * dt;
      zone.drift.step(dt);
    }

    // --- screw / inverter ---
    let rpmTarget = 0;
    const extruding =
      this.mode === "Extrude" && this.canExtrude() && !this.inverterFault;
    if (extruding) {
      if (this.usesRpm) {
        rpmTarget = this.targetRpm;
        this.pressureIntegral = 0;
      } else {
        const err = this.targetBar - this.pressure;
        this.pressureIntegral = clamp(
          this.pressureIntegral + err * dt * 0.25,
          0,
          MAX_RPM,
        );
        rpmTarget = clamp(err * 0.6 + this.pressureIntegral, 0, MAX_RPM);
      }
    } else {
      this.pressureIntegral = 0;
    }
    this.rpm = ramp(this.rpm, rpmTarget, RPM_RAMP, dt);

    const p = this.forward ? this.steadyPressure(this.rpm) : 0;
    this.pressure = Math.max(0, lag(this.pressure, p, 1.2, dt));

    if (
      this.pressureLimitEnabled &&
      this.pressure > this.pressureLimit &&
      this.mode === "Extrude"
    ) {
      // over-pressure protection drops the machine back to heating
      this.mode = "Heat";
      this.dirty = true;
    }

    // --- auto-tune ---
    if (this.autotune.state === "running") {
      this.autotuneElapsed += dt;
      this.autotune.progress = clamp((this.autotuneElapsed / 25) * 100, 0, 100);
      if (this.autotune.progress >= 100) {
        this.autotune = {
          state: "completed",
          progress: 100,
          result: {
            kp: round(0.012 + noise(0.001), 4),
            ki: round(0.0021 + noise(0.0002), 5),
            kd: round(0.017 + noise(0.001), 4),
          },
        };
      }
      this.dirty = true; // progress is part of the state event
    }

    // --- energy ---
    this.energyKwh += (this.combinedPower() * dt) / 3_600_000;
  }

  private motor() {
    const running = this.rpm > 0.2;
    const frequency = this.rpm * 0.55;
    const current = running
      ? 1.1 + this.rpm * 0.028 + this.pressure * 0.012
      : 0;
    const voltage = running ? Math.min(400, frequency * 7.8) : 0;
    const power = running ? voltage * current * 0.42 : 0;
    return { running, frequency, current, voltage, power };
  }

  private combinedPower() {
    return (
      ZONES.reduce((s, z) => s + this.zones[z].power, 0) + this.motor().power
    );
  }

  live() {
    const m = this.motor();
    const zoneTemp = (z: Zone) =>
      round(this.zones[z].temperature + this.zones[z].drift.value, 2);
    return {
      motor_status: {
        screw_rpm: round(this.rpm > 0.05 ? this.rpm + noise(0.05) : 0, 2),
        frequency: round(m.frequency, 2),
        current: round(m.current > 0 ? m.current + noise(0.02) : 0, 2),
        voltage: round(m.voltage, 1),
        power: round(m.power, 1),
      },
      pressure: round(
        Math.max(0, this.pressure + (this.pressure > 0.5 ? noise(0.15) : 0)),
        2,
      ),
      nozzle_temperature: zoneTemp("nozzle"),
      front_temperature: zoneTemp("front"),
      back_temperature: zoneTemp("back"),
      middle_temperature: zoneTemp("middle"),
      nozzle_power: round(this.zones.nozzle.power, 1),
      front_power: round(this.zones.front.power, 1),
      back_power: round(this.zones.back.power, 1),
      middle_power: round(this.zones.middle.power, 1),
      combined_power: round(this.combinedPower(), 1),
      total_energy_kwh: round(this.energyKwh, 4),
    };
  }

  /** Screw output relative to nominal (32 rpm); used by the laser simulation. */
  outputFactor() {
    return this.forward && this.mode === "Extrude" ? this.rpm / 32 : 0;
  }

  state() {
    const m = this.motor();
    const heating = (z: Zone) => ({
      target_temperature: this.zones[z].target,
      wiring_error: false,
    });
    const pid = (z: Zone) => ({ ...this.zones[z].gains, zone: z });
    return {
      rotation_state: { forward: this.forward },
      mode_state: { mode: this.mode },
      regulation_state: { uses_rpm: this.usesRpm },
      pressure_state: { target_bar: this.targetBar, wiring_error: false },
      screw_state: { target_rpm: this.targetRpm },
      heating_states: {
        nozzle: heating("nozzle"),
        front: heating("front"),
        back: heating("back"),
        middle: heating("middle"),
      },
      extruder_settings_state: {
        pressure_limit: this.pressureLimit,
        pressure_limit_enabled: this.pressureLimitEnabled,
        nozzle_temperature_target_enabled: this.nozzleTargetEnabled,
        min_extrusion_temperature: this.minExtrusionTemperature,
        heating_algorithm: this.algorithm,
      },
      inverter_status_state: {
        running: m.running,
        forward_running: m.running && this.forward,
        reverse_running: m.running && !this.forward,
        up_to_frequency:
          m.running &&
          Math.abs(this.rpm - (this.usesRpm ? this.targetRpm : this.rpm)) < 0.5,
        overload_warning: m.current > 6,
        no_function: false,
        output_frequency_detection: m.running,
        abc_fault: this.inverterFault,
        fault_occurence: this.inverterFault,
      },
      pid_settings: {
        temperature: {
          front: pid("front"),
          middle: pid("middle"),
          back: pid("back"),
          nozzle: pid("nozzle"),
        },
        pressure: { ...this.pressureGains },
      },
      pid_autotune_state: {
        state: this.autotune.state,
        progress: round(this.autotune.progress, 1),
        result: this.autotune.result,
      },
    };
  }

  protected apply(name: string, v: unknown) {
    switch (name) {
      case "SetInverterRotationDirection":
        this.forward = bool(v, name);
        return;
      case "SetInverterRegulation":
        this.usesRpm = bool(v, name);
        return;
      case "SetInverterTargetRpm":
        this.targetRpm = clamp(num(v, name), 0, MAX_RPM);
        return;
      case "SetInverterTargetPressure":
        this.targetBar = Math.max(0, num(v, name));
        return;
      case "SetExtruderMode":
        this.mode = oneOf(v, MODES, name);
        return;
      case "SetNozzleHeatingTemperature":
        this.zones.nozzle.target = num(v, name);
        return;
      case "SetFrontHeatingTargetTemperature":
        this.zones.front.target = num(v, name);
        return;
      case "SetMiddleHeatingTemperature":
        this.zones.middle.target = num(v, name);
        return;
      case "SetBackHeatingTargetTemperature":
        this.zones.back.target = num(v, name);
        return;
      case "SetExtruderPressureLimit":
        this.pressureLimit = num(v, name);
        return;
      case "SetExtruderPressureLimitIsEnabled":
        this.pressureLimitEnabled = bool(v, name);
        return;
      case "SetNozzleTemperatureTargetEnabled":
        this.nozzleTargetEnabled = bool(v, name);
        return;
      case "SetMinExtrusionTemperature":
        this.minExtrusionTemperature = num(v, name);
        return;
      case "ResetInverter":
        this.inverterFault = false;
        return;
      case "SetPressurePidSettings": {
        const g = v as Gains;
        this.pressureGains = {
          kp: num(g?.kp, "kp"),
          ki: num(g?.ki, "ki"),
          kd: num(g?.kd, "kd"),
        };
        return;
      }
      case "SetTemperaturePidSettings": {
        const g = v as Gains & { zone: string };
        const zone = oneOf(g?.zone, ZONES, "zone");
        this.zones[zone].gains = {
          kp: num(g.kp, "kp"),
          ki: num(g.ki, "ki"),
          kd: num(g.kd, "kd"),
        };
        return;
      }
      case "SetHeatingAlgorithm": {
        this.algorithm = oneOf(v, ALGORITHMS, name);
        // the server resets the zone gains to the algorithm's defaults
        for (const z of ZONES)
          this.zones[z].gains = { ...TEMPERATURE_GAINS[this.algorithm] };
        return;
      }
      case "StartPressurePidAutoTune":
        this.autotune = { state: "running", progress: 0, result: null };
        this.autotuneElapsed = 0;
        return;
      case "StopPressurePidAutoTune":
        if (this.autotune.state === "running") {
          this.autotune = {
            state: "failed",
            progress: this.autotune.progress,
            result: null,
          };
        }
        return;
      default:
        throw new MutationError(`unknown extruder mutation ${name}`);
    }
  }
}
