// LaserV1 (UI slug laser1, machine 0x06), a Modbus RTU diameter gauge.
// Contract: ui/src/machines/laser/laser1/laser1Namespace.ts and
// control/qitech_control/src/api/legacy/adapter/laser_v1.rs.

import { MutationError } from "../protocol.ts";
import { MachineSim } from "./machine.ts";
import type { TerminalSpec, World } from "./machine.ts";
import { bool, Drift, lag, noise, num, round } from "./util.ts";
import type { ExtruderSim } from "./extruder.ts";
import type { Winder2Sim } from "./winder2.ts";

/** Diameter the line produces at nominal screw output and 10 m/min. */
const NOMINAL_DIAMETER = 1.75;
const NOMINAL_PULL_SPEED = 10;

export class LaserSim extends MachineSim {
  readonly slug = "laser1";
  readonly machineId = 0x0006;

  targetDiameter = 1.75;
  lowerTolerance = 0.05;
  higherTolerance = 0.05;
  globalWarning = true;

  diameter = 0;
  x = 0;
  y = 0;
  inTolerance = false;
  private toleranceCounter = 0;
  // slow process variation (melt temperature, material batch); gives the
  // winder's diameter regulation something to correct
  private process = new Drift(0.012, 25);
  private ovality = new Drift(0.006, 8);

  terminals(): TerminalSpec[] {
    return [];
  }

  preset() {
    this.diameter = NOMINAL_DIAMETER;
    this.x = this.y = NOMINAL_DIAMETER;
    this.inTolerance = true;
  }

  /** Line-dependent diameter, or 0 when there is no filament in the gauge. */
  private lineDiameter(world: World): number {
    const extruder = world.find<ExtruderSim>("extruder3");
    const winder = world.find<Winder2Sim>("winder2");
    const output = extruder ? extruder.outputFactor() : 1;
    const pull = winder ? winder.pullerSpeed : NOMINAL_PULL_SPEED;
    if (output < 0.02 || pull < 0.05) return 0;
    // volume conservation: d ∝ sqrt(output / pull speed)
    return (
      NOMINAL_DIAMETER *
      Math.sqrt(output / (pull / NOMINAL_PULL_SPEED)) *
      (1 + this.process.value)
    );
  }

  step(dt: number, world: World) {
    this.process.step(dt);
    this.ovality.step(dt);
    const d = this.lineDiameter(world);
    if (d === 0) {
      this.diameter = this.x = this.y = 0;
    } else {
      const base = this.diameter === 0 ? d : lag(this.diameter, d, 0.8, dt);
      this.diameter = base;
      this.x = base * (1 + this.ovality.value);
      this.y = base * (1 - this.ovality.value);
    }

    const within =
      this.diameter >= this.targetDiameter - this.lowerTolerance &&
      this.diameter <= this.targetDiameter + this.higherTolerance;
    // debounce so measurement noise does not toggle the state every tick
    this.toleranceCounter =
      within === this.inTolerance ? 0 : this.toleranceCounter + dt;
    if (this.toleranceCounter > 0.3) {
      this.inTolerance = within;
      this.toleranceCounter = 0;
      this.dirty = true;
    }
  }

  live() {
    if (this.diameter === 0) {
      return { diameter: 0, x_diameter: 0, y_diameter: 0, roundness: null };
    }
    const x = this.x + noise(0.002);
    const y = this.y + noise(0.002);
    return {
      diameter: round((x + y) / 2, 4),
      x_diameter: round(x, 4),
      y_diameter: round(y, 4),
      roundness: round(Math.min(x, y) / Math.max(x, y), 5),
    };
  }

  state() {
    return {
      laser_state: {
        higher_tolerance: this.higherTolerance,
        lower_tolerance: this.lowerTolerance,
        target_diameter: this.targetDiameter,
        in_tolerance: this.inTolerance,
        global_warning: this.globalWarning,
      },
    };
  }

  protected apply(name: string, v: unknown) {
    switch (name) {
      case "SetTargetDiameter":
        this.targetDiameter = num(v, name);
        return;
      case "SetLowerTolerance":
        this.lowerTolerance = num(v, name);
        return;
      case "SetHigherTolerance":
        this.higherTolerance = num(v, name);
        return;
      case "SetGlobalWarning":
        this.globalWarning = bool(v, name);
        return;
      default:
        throw new MutationError(`unknown laser mutation ${name}`);
    }
  }
}
