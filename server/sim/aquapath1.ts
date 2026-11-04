// AquapathV1 (UI slug aquapath1, machine 0x09): two temperature-controlled
// water reservoirs (left/right) with pump, heater and cooling fan each.
// Contract: ui/src/machines/aquapath/aquapath1/aquapath1Namespace.ts and
// control/qitech_control/src/api/legacy/adapter/aquapath_v1.rs. Behaviour
// follows control/qitech_control/src/machines/aquapath/ (cooling ramp, notices).

import { MutationError } from "../protocol.ts";
import { MachineSim } from "./machine.ts";
import type { TerminalSpec, World } from "./machine.ts";
import { bool, clamp, lag, noise, num, oneOf, ramp, round } from "./util.ts";
import type { ExtruderSim } from "./extruder.ts";

const MODES = ["Standby", "Auto"] as const;
type CoolingMode = "Low" | "Ramp" | "Max" | null;

const MIN_TEMPERATURE = 10;
const MAX_TEMPERATURE = 80;
const FULL_BAND = 5; // K above target → fan at max
const NEAR_BAND = 2; // K above target → start of the ramp segment
const MIN_FAN = 15; // %
const NOMINAL_FLOW = 7.5; // l/min
const HEATER_POWER = 1800; // W
const FAN_POWER = 140; // W at 100 %
const PUMP_POWER = 65; // W
const WATER_CAPACITY = 4186 * 12; // 12 l reservoir, J/K
const LOSS = 9; // W/K to ambient
const FAN_COOLING = 1400; // W/K·(fan fraction), through the radiator

class Reservoir {
  readonly label: string;
  temperature: number;
  target = 25;
  shouldFlow = false;
  flow = 0;
  maxRevolutions = 100;
  revolutions = 0;
  heatingTolerance = 0.4;
  coolingTolerance = 0.8;
  pid = { kp: 0.16, ki: 0.02, kd: 0 };
  settleDuration = 0;
  cooldownMinTemperature = 32;
  heating = false;
  heaterDuty = 0;
  coolingMode: CoolingMode = null;
  cooldownActive = false;
  startupWait = 0;
  energyKwh = 0;
  integral = 0;

  constructor(label: string, temperature: number) {
    this.label = label;
    this.temperature = temperature;
  }

  /** Heater power, shown as "Heating Wattage". */
  power() {
    return this.heaterDuty * HEATER_POWER;
  }

  /** Everything the reservoir draws, for the energy counter. */
  totalPower() {
    return (
      this.power() +
      (this.revolutions / 100) * FAN_POWER +
      (this.flow > 0.1 ? PUMP_POWER : 0)
    );
  }

  /** Seconds until the cooldown ends, estimated from the current cooling rate. */
  cooldownRemaining(): number {
    if (!this.cooldownActive) return 0;
    const excess = this.temperature - this.cooldownMinTemperature;
    return Math.max(0, Math.round(excess * 45));
  }
}

export class AquapathSim extends MachineSim {
  readonly slug = "aquapath1";
  readonly machineId = 0x0009;

  mode: (typeof MODES)[number] = "Standby";
  ambient = 22;
  left = new Reservoir("Left", 22.4);
  right = new Reservoir("Right", 22.1);

  terminals(): TerminalSpec[] {
    return [
      { role: 0, name: "EK1100", product_id: 0x044c2c52, revision: 0x120000 },
      { role: 1, name: "EL2008", product_id: 0x07d83052, revision: 0x120000 },
      { role: 2, name: "EL4002", product_id: 0x0fa23052, revision: 0x140000 },
      { role: 3, name: "EL3024", product_id: 0x0bd03052, revision: 0x130000 },
    ];
  }

  /** Both water baths running behind the extruder. */
  preset() {
    this.mode = "Auto";
    this.left.target = 30;
    this.right.target = 24;
    for (const r of [this.left, this.right]) {
      r.shouldFlow = true;
      r.flow = NOMINAL_FLOW;
      r.temperature = r.target + 0.2;
    }
    this.left.energyKwh = 3.81;
    this.right.energyKwh = 2.95;
  }

  private stepReservoir(r: Reservoir, processHeat: number, dt: number) {
    const auto = this.mode === "Auto";

    // pump: keeps running for cooldown while the water is too hot to stand still
    const wantsPump = auto && r.shouldFlow;
    const hot = r.temperature > r.cooldownMinTemperature;
    const wasCooldown = r.cooldownActive;
    r.cooldownActive = !wantsPump && hot && (r.flow > 0.1 || wasCooldown);
    const pumpOn = wantsPump || r.cooldownActive;
    r.flow = lag(r.flow, pumpOn ? NOMINAL_FLOW + noise(0.05) : 0, 1.5, dt);
    if (r.flow < 0.02) r.flow = 0;
    if (r.cooldownActive !== wasCooldown) this.dirty = true;

    // heating waits for the flow to settle after the pump starts
    if (wantsPump && r.flow < 0.5) r.startupWait = r.settleDuration;
    else if (r.startupWait > 0) r.startupWait = Math.max(0, r.startupWait - dt);

    // heater: PI inside the heating tolerance band, only with flow
    const error = r.target - r.temperature;
    const mayHeat = auto && wantsPump && r.flow > 1 && r.startupWait === 0;
    if (mayHeat && error > r.heatingTolerance) {
      r.integral = clamp(r.integral + error * r.pid.ki * dt, 0, 1);
      r.heaterDuty = clamp(r.pid.kp * error * 2 + r.integral, 0, 1);
    } else if (mayHeat && error > 0) {
      r.heaterDuty = clamp(r.integral * 0.5, 0, 1);
    } else {
      r.heaterDuty = 0;
      r.integral = Math.max(0, r.integral - dt * 0.01);
    }
    r.heating = r.heaterDuty > 0.01;

    // fan: cooling ramp from controller/cooling.rs
    const above = r.temperature - r.target;
    let fanTarget = 0;
    let mode: CoolingMode = null;
    if (auto && wantsPump && above > r.coolingTolerance) {
      if (above >= FULL_BAND) {
        fanTarget = r.maxRevolutions;
        mode = "Max";
      } else if (above >= NEAR_BAND) {
        fanTarget =
          (0.6 + (0.4 * (above - NEAR_BAND)) / (FULL_BAND - NEAR_BAND)) *
          r.maxRevolutions;
        mode = "Ramp";
      } else {
        const t = clamp(
          (above - r.coolingTolerance) / (NEAR_BAND - r.coolingTolerance),
          0,
          1,
        );
        const lower = Math.min(MIN_FAN, r.maxRevolutions);
        fanTarget = lower + (0.6 * r.maxRevolutions - lower) * t;
        mode = "Low";
      }
    }
    r.revolutions = ramp(r.revolutions, fanTarget, 40, dt);
    r.coolingMode = mode;

    // thermal model
    const flowing = r.flow / NOMINAL_FLOW;
    const q =
      r.heaterDuty * HEATER_POWER +
      processHeat * flowing -
      LOSS * (r.temperature - this.ambient) -
      FAN_COOLING *
        (r.revolutions / 100) *
        flowing *
        Math.max(0, r.temperature - this.ambient) *
        0.05;
    r.temperature = clamp(r.temperature + (q / WATER_CAPACITY) * dt * 8, 5, 95);
    r.energyKwh += (r.totalPower() * dt) / 3_600_000;
  }

  step(dt: number, world: World) {
    // the hot strand coming out of the extruder heats the first (left) bath
    const extruder = world.find<ExtruderSim>("extruder3");
    const strand = extruder ? 260 * extruder.outputFactor() : 0;
    this.stepReservoir(this.left, strand, dt);
    this.stepReservoir(this.right, strand * 0.25, dt);
  }

  live() {
    const side = (r: Reservoir) => ({
      flow: round(r.flow, 2),
      temperature: round(r.temperature + noise(0.03), 2),
      revolutions: round(r.revolutions, 1),
      power: round(r.power(), 1),
    });
    const l = side(this.left);
    const r = side(this.right);
    return {
      left_flow: l.flow,
      right_flow: r.flow,
      left_temperature: l.temperature,
      right_temperature: r.temperature,
      left_revolutions: l.revolutions,
      right_revolutions: r.revolutions,
      left_power: l.power,
      right_power: r.power,
      left_heating: this.left.heating,
      right_heating: this.right.heating,
      left_cooling_mode: this.left.coolingMode,
      right_cooling_mode: this.right.coolingMode,
      left_pump_cooldown_active: this.left.cooldownActive,
      right_pump_cooldown_active: this.right.cooldownActive,
      left_pump_cooldown_remaining: this.left.cooldownRemaining(),
      right_pump_cooldown_remaining: this.right.cooldownRemaining(),
      left_heating_startup_wait_active: this.left.startupWait > 0,
      right_heating_startup_wait_active: this.right.startupWait > 0,
      left_heating_startup_wait_remaining: round(this.left.startupWait, 1),
      right_heating_startup_wait_remaining: round(this.right.startupWait, 1),
      left_total_energy: round(this.left.energyKwh, 4),
      right_total_energy: round(this.right.energyKwh, 4),
    };
  }

  state() {
    const both = <T>(f: (r: Reservoir) => T) => ({
      left: f(this.left),
      right: f(this.right),
    });
    return {
      mode_state: { mode: this.mode },
      ambient_temperature_calibration: this.ambient,
      flow_states: both((r) => ({
        flow: round(r.flow, 2),
        should_flow: r.shouldFlow,
      })),
      temperature_states: both((r) => ({
        temperature: round(r.temperature, 2),
        target_temperature: r.target,
      })),
      fan_states: both((r) => ({
        revolutions: round(r.revolutions, 1),
        max_revolutions: r.maxRevolutions,
      })),
      cooling_mode_states: both((r) => ({ mode: r.coolingMode })),
      tolerance_states: both((r) => ({
        heating: r.heatingTolerance,
        cooling: r.coolingTolerance,
      })),
      pid_states: both((r) => ({ ...r.pid })),
      thermal_safety_states: both((r) => ({
        thermal_delay: r.settleDuration,
        cooldown_min_temperature: r.cooldownMinTemperature,
      })),
    };
  }

  private controlReset(r: Reservoir, message: string) {
    r.integral = 0;
    if (this.mode === "Auto") {
      this.notify(
        `${r.label}: Thermal Control Reset`,
        `${message} PID control state and heater PWM timing were reset.`,
      );
    }
  }

  private requireStandby(name: string) {
    if (this.mode !== "Standby") {
      throw new MutationError(
        `${name}: thermal safety settings can only be changed in Standby`,
      );
    }
  }

  protected apply(name: string, v: unknown) {
    const m = /^Set(Left|Right)(.+)$/.exec(name);
    if (m) {
      const r = m[1] === "Left" ? this.left : this.right;
      const field = m[2];
      switch (field) {
        case "Temperature":
          r.target = clamp(
            num(v, name),
            Math.max(this.ambient, MIN_TEMPERATURE),
            MAX_TEMPERATURE,
          );
          this.controlReset(r, "Target temperature changed.");
          return;
        case "Flow":
          r.shouldFlow = bool(v, name);
          this.controlReset(r, "Pump command changed.");
          return;
        case "Revolutions":
          r.maxRevolutions = clamp(num(v, name), 0, 100);
          return;
        case "HeatingTolerance":
          r.heatingTolerance = num(v, name);
          this.controlReset(r, "Heating tolerance changed.");
          return;
        case "CoolingTolerance":
          r.coolingTolerance = num(v, name);
          this.controlReset(r, "Cooling tolerance changed.");
          return;
        case "PidKp":
        case "PidKi":
        case "PidKd": {
          const key = field.slice(3).toLowerCase() as "kp" | "ki" | "kd";
          r.pid[key] = num(v, name);
          this.controlReset(r, "PID settings changed.");
          return;
        }
        case "ThermalFlowSettleDuration":
          this.requireStandby(name);
          r.settleDuration = clamp(num(v, name), 0, 30);
          return;
        case "PumpCooldownMinTemperature":
          this.requireStandby(name);
          r.cooldownMinTemperature = num(v, name);
          return;
      }
    }
    switch (name) {
      case "SetAquaPathMode":
        this.mode = oneOf(v, MODES, name);
        return;
      case "SetAmbientTemperatureCalibration":
        this.ambient = clamp(num(v, name), MIN_TEMPERATURE, MAX_TEMPERATURE);
        for (const r of [this.left, this.right])
          r.target = Math.max(r.target, this.ambient);
        return;
      default:
        throw new MutationError(`unknown aquapath mutation ${name}`);
    }
  }
}
