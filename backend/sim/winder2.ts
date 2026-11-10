// WinderV1_Regular (UI slug winder2, machine 0x02).
// Contract: ui/src/machines/winder/winder2/winder2Namespace.ts and
// control/qitech_control/src/api/legacy/adapter/winder_v1/.

import { MutationError, sameMachine } from "../protocol.ts";
import type { MachineIdentificationUnique } from "../protocol.ts";
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
import type { LaserSim } from "./laser1.ts";

const MODES = ["Standby", "Hold", "Pull", "Wind"] as const;
type Mode = (typeof MODES)[number];
const GEAR_RATIOS = ["OneToOne", "OneToFive", "OneToTen"] as const;
const PULLER_REGULATION = ["Speed", "Diameter"] as const;
const SPOOL_REGULATION = ["Adaptive", "MinMax"] as const;
const AUTOMATIC_ACTIONS = ["NoAction", "Pull", "Hold"] as const;

type TraverseMotion =
  | "idle"
  | "homing"
  | "going_in"
  | "going_out"
  | "traversing";

const SPOOL_CORE_RADIUS = 0.05; // m
const FILAMENT_DIAMETER = 1.75e-3; // m
const HOMING_SPEED = 25; // mm/s
const TRAVERSE_JOG_SPEED = 40; // mm/s
const PULLER_ACCELERATION = 12; // (m/min)/s

export class Winder2Sim extends MachineSim {
  readonly slug = "winder2";
  readonly machineId = 0x0002;

  mode: Mode = "Standby";

  // traverse
  limitInner = 22;
  limitOuter = 92;
  stepSize = 1.75;
  padding = 0.88;
  edgeDwell = 0;
  startDwell = 0;
  laserpointer = false;
  homed = false;
  motion: TraverseMotion = "idle";
  position = 47.3; // mm, unknown until homed
  traverseDirection = 1;
  dwellRevolutions = 0;

  // puller
  pullerRegulation: (typeof PULLER_REGULATION)[number] = "Speed";
  pullerTarget = 1;
  pullerForward = true;
  gearRatio: (typeof GEAR_RATIOS)[number] = "OneToOne";
  adaptiveSpeedDeltaMax = 0.1;
  adaptiveAdjustmentDistance = 1;
  adaptiveChangePerStep = 0.05;
  allowedDiameterDeviation = 0.02;
  referenceMachine: MachineIdentificationUnique | null = null;
  pullerSpeed = 0;
  modulation = 0;
  distanceSinceStep = 0;

  // tension arm
  zeroed = false;
  armOffset = 37.6; // raw encoder angle before zeroing
  armAngle = 0;
  armDrift = new Drift(1.2, 4);

  // spool
  spoolRegulation: (typeof SPOOL_REGULATION)[number] = "Adaptive";
  minmaxMin = 0;
  minmaxMax = 150;
  tensionTarget = 0.7;
  radiusLearningRate = 0.5;
  maxSpeedMultiplier = 4;
  accelerationFactor = 0.2;
  deaccelerationUrgency = 15;
  spoolForward = true;
  spoolRpm = 0;
  spoolProgress = 0;
  requiredMeters = 250;
  automaticAction: (typeof AUTOMATIC_ACTIONS)[number] = "NoAction";
  automaticActionDone = false;

  terminals(): TerminalSpec[] {
    return [
      { role: 0, name: "EK1100", product_id: 0x044c2c52, revision: 0x120000 },
      { role: 1, name: "EL2002", product_id: 0x07d23052, revision: 0x120000 },
      {
        role: 2,
        name: "EL7041-0052",
        product_id: 0x1b813052,
        revision: 0x100034,
      },
      { role: 3, name: "EL7031", product_id: 0x1b773052, revision: 0x1a0000 },
      { role: 4, name: "EL7031", product_id: 0x1b773052, revision: 0x10001e },
    ];
  }

  /** Homed, zeroed, winding at 10 m/min behind the laser. */
  preset(laser?: MachineIdentificationUnique) {
    this.homed = true;
    this.zeroed = true;
    this.position = this.limitInner + 14;
    this.motion = "traversing";
    this.mode = "Wind";
    this.pullerTarget = 10;
    this.pullerSpeed = 10;
    this.spoolProgress = 63.4;
    this.spoolRpm = this.requiredSpoolRpm();
    if (laser) {
      this.referenceMachine = laser;
      this.pullerRegulation = "Diameter";
    }
  }

  private spoolRadius() {
    const width = Math.max(0.005, (this.limitOuter - this.limitInner) / 1000);
    const area =
      (this.spoolProgress * FILAMENT_DIAMETER ** 2) / (4 * width * 0.85);
    return Math.sqrt(SPOOL_CORE_RADIUS ** 2 + area);
  }

  private requiredSpoolRpm() {
    return this.pullerSpeed / (2 * Math.PI * this.spoolRadius());
  }

  private canTraverse() {
    return this.homed && this.motion !== "homing";
  }

  private canWind() {
    return this.zeroed && this.homed && this.motion !== "homing";
  }

  private setMode(mode: Mode) {
    if (mode === "Wind" && !this.canWind()) {
      throw new MutationError(
        "cannot wind: home the traverse and zero the tension arm first",
      );
    }
    this.mode = mode;
    this.automaticActionDone = false;
    if (mode === "Wind") {
      this.motion = "traversing";
      this.dwellRevolutions = this.startDwell;
    } else if (this.motion === "traversing") {
      this.motion = "idle";
    }
  }

  step(dt: number, world: World) {
    // --- puller ---
    const pulling = this.mode === "Pull" || this.mode === "Wind";
    let target = pulling ? this.pullerTarget : 0;
    if (pulling && this.pullerRegulation === "Diameter") {
      const laser = this.referenceMachine
        ? (world.byUid(this.referenceMachine) as LaserSim | undefined)
        : undefined;
      if (laser && laser.slug === "laser1" && laser.diameter > 0) {
        this.distanceSinceStep += (this.pullerSpeed / 60) * dt;
        if (this.distanceSinceStep >= this.adaptiveAdjustmentDistance) {
          this.distanceSinceStep = 0;
          const deviation = laser.diameter - laser.targetDiameter;
          if (Math.abs(deviation) > this.allowedDiameterDeviation) {
            // too thick → pull faster, too thin → pull slower
            this.modulation = clamp(
              this.modulation +
                Math.sign(deviation) * this.adaptiveChangePerStep,
              -1,
              1,
            );
            this.dirty = true;
          }
        }
        target = Math.max(
          0,
          this.pullerTarget *
            (1 + this.modulation * this.adaptiveSpeedDeltaMax),
        );
      }
    } else if (this.pullerRegulation === "Speed") {
      this.modulation = 0;
    }
    this.pullerSpeed = ramp(this.pullerSpeed, target, PULLER_ACCELERATION, dt);

    // --- spool & tension arm ---
    const winding = this.mode === "Wind";
    const required = winding ? this.requiredSpoolRpm() : 0;
    let spoolTarget = required;
    if (winding && this.spoolRegulation === "MinMax") {
      spoolTarget = clamp(required, this.minmaxMin, this.minmaxMax);
    }
    const tau =
      this.spoolRegulation === "Adaptive"
        ? 0.6 / (0.2 + this.accelerationFactor)
        : 0.4;
    this.spoolRpm =
      this.mode === "Standby"
        ? lag(this.spoolRpm, 0, 0.8, dt)
        : lag(this.spoolRpm, spoolTarget, tau, dt);
    if (this.mode === "Hold") this.spoolRpm = lag(this.spoolRpm, 0, 0.2, dt);

    // arm: sits in its rest position, rises with tension while winding
    const armTarget = winding
      ? 25 + 60 * this.tensionTarget
      : this.mode === "Pull"
        ? 12
        : 3;
    this.armAngle = lag(this.armAngle, armTarget, 1.5, dt);
    this.armDrift.step(dt);

    if (winding) {
      this.spoolProgress += (this.pullerSpeed / 60) * dt;
      if (
        !this.automaticActionDone &&
        this.spoolProgress >= this.requiredMeters &&
        this.automaticAction !== "NoAction"
      ) {
        this.automaticActionDone = true;
        this.setMode(this.automaticAction);
        this.dirty = true;
      }
    }

    // --- traverse ---
    const inner = this.limitInner + this.padding;
    const outer = this.limitOuter - this.padding;
    switch (this.motion) {
      case "homing":
        this.position = Math.max(0, this.position - HOMING_SPEED * dt);
        if (this.position <= 0) {
          this.position = 0;
          this.homed = true;
          this.motion = this.mode === "Wind" ? "traversing" : "idle";
          this.dirty = true;
        }
        break;
      case "going_in":
        this.position = ramp(
          this.position,
          this.limitInner,
          TRAVERSE_JOG_SPEED,
          dt,
        );
        if (this.position === this.limitInner) {
          this.motion = "idle";
          this.dirty = true;
        }
        break;
      case "going_out":
        this.position = ramp(
          this.position,
          this.limitOuter,
          TRAVERSE_JOG_SPEED,
          dt,
        );
        if (this.position === this.limitOuter) {
          this.motion = "idle";
          this.dirty = true;
        }
        break;
      case "traversing": {
        const revs = (this.spoolRpm / 60) * dt;
        if (this.position < inner - 0.01 || this.position > outer + 0.01) {
          // first move into the winding window
          this.position = ramp(
            this.position,
            this.position < inner ? inner : outer,
            TRAVERSE_JOG_SPEED,
            dt,
          );
          break;
        }
        if (this.dwellRevolutions > 0) {
          this.dwellRevolutions -= revs;
          break;
        }
        this.position += this.traverseDirection * this.stepSize * revs;
        if (this.position >= outer) {
          this.position = outer;
          this.traverseDirection = -1;
          this.dwellRevolutions = this.edgeDwell;
        } else if (this.position <= inner) {
          this.position = inner;
          this.traverseDirection = 1;
          this.dwellRevolutions = this.edgeDwell;
        }
        break;
      }
      case "idle":
        break;
    }
  }

  live() {
    const raw = this.armAngle + this.armDrift.value + noise(0.15);
    return {
      traverse_position: this.homed ? round(this.position, 2) : null,
      puller_speed: round(
        this.pullerSpeed > 0 ? this.pullerSpeed + noise(0.01) : 0,
        3,
      ),
      spool_rpm: round(this.spoolRpm * (this.spoolForward ? 1 : -1), 2),
      tension_arm_angle: round(
        this.zeroed ? Math.max(0, raw) : raw + this.armOffset,
        2,
      ),
      spool_progress: round(this.spoolProgress, 2),
    };
  }

  state() {
    const traversing = this.motion === "traversing";
    return {
      traverse_state: {
        limit_inner: this.limitInner,
        limit_outer: this.limitOuter,
        position_in: 0,
        position_out: 0,
        is_going_in: this.motion === "going_in",
        is_going_out: this.motion === "going_out",
        is_homed: this.homed,
        is_going_home: this.motion === "homing",
        is_traversing: traversing,
        laserpointer: this.laserpointer,
        step_size: this.stepSize,
        padding: this.padding,
        edge_dwell_revolutions: this.edgeDwell,
        start_dwell_revolutions: this.startDwell,
        can_go_in: this.canTraverse(),
        can_go_out: this.canTraverse(),
        can_go_home: !this.homed,
      },
      puller_state: {
        regulation: this.pullerRegulation,
        target_speed: this.pullerTarget,
        forward: this.pullerForward,
        gear_ratio: this.gearRatio,
        adaptive_speed_delta_max: this.adaptiveSpeedDeltaMax,
        adaptive_adjustment_distance: this.adaptiveAdjustmentDistance,
        adaptive_change_per_step: this.adaptiveChangePerStep,
        allowed_diameter_deviation: this.allowedDiameterDeviation,
        adaptive_reference_machine: this.referenceMachine,
      },
      mode_state: { mode: this.mode, can_wind: this.canWind() },
      tension_arm_state: { zeroed: this.zeroed },
      spool_speed_controller_state: {
        regulation_mode: this.spoolRegulation,
        minmax_min_speed: this.minmaxMin,
        minmax_max_speed: this.minmaxMax,
        adaptive_tension_target: this.tensionTarget,
        adaptive_radius_learning_rate: this.radiusLearningRate,
        adaptive_max_speed_multiplier: this.maxSpeedMultiplier,
        adaptive_acceleration_factor: this.accelerationFactor,
        adaptive_deacceleration_urgency_multiplier: this.deaccelerationUrgency,
        forward: this.spoolForward,
      },
      spool_automatic_action_state: {
        spool_required_meters: this.requiredMeters,
        spool_automatic_action_mode: this.automaticAction,
      },
    };
  }

  protected apply(name: string, v: unknown, world: World) {
    switch (name) {
      case "GotoTraverseHome":
        this.motion = "homing";
        this.homed = false;
        return;
      case "GotoTraverseLimitInner":
        if (!this.canTraverse())
          throw new MutationError("traverse is not homed");
        this.motion = "going_in";
        return;
      case "GotoTraverseLimitOuter":
        if (!this.canTraverse())
          throw new MutationError("traverse is not homed");
        this.motion = "going_out";
        return;
      case "ZeroTensionArmAngle":
        this.zeroed = true;
        return;
      case "ResetSpoolProgress":
        this.spoolProgress = 0;
        this.automaticActionDone = false;
        return;
      case "EnableTraverseLaserpointer":
        this.laserpointer = bool(v, name);
        return;
      case "SetMode":
        this.setMode(oneOf(v, MODES, name));
        return;
      case "SetTraverseLimitInner":
        this.limitInner = num(v, name);
        return;
      case "SetTraverseLimitOuter":
        this.limitOuter = num(v, name);
        return;
      case "SetTraverseStepSize":
        this.stepSize = num(v, name);
        return;
      case "SetTraversePadding":
        this.padding = num(v, name);
        return;
      case "SetTraverseEdgeDwellRevolutions":
        this.edgeDwell = num(v, name);
        return;
      case "SetTraverseStartDwellRevolutions":
        this.startDwell = num(v, name);
        return;
      case "SetPullerTargetSpeed":
        this.pullerTarget = Math.max(0, num(v, name));
        return;
      case "SetPullerTargetDiameter":
        num(v, name);
        return;
      case "SetPullerRegulationMode":
        this.pullerRegulation = oneOf(v, PULLER_REGULATION, name);
        this.modulation = 0;
        this.distanceSinceStep = 0;
        return;
      case "SetPullerForward":
        this.pullerForward = bool(v, name);
        return;
      case "SetPullerGearRatio":
        this.gearRatio = oneOf(v, GEAR_RATIOS, name);
        return;
      case "SetPullerAdaptiveMaxSpeedChangePercent":
        this.adaptiveSpeedDeltaMax = num(v, name);
        return;
      case "SetPullerAdaptiveAdjustmentIntervalMeters":
        this.adaptiveAdjustmentDistance = num(v, name);
        return;
      case "SetPullerAdaptiveStepPercent":
        this.adaptiveChangePerStep = num(v, name);
        return;
      case "SetPullerAdaptiveAcceptedDifference":
        this.allowedDiameterDeviation = num(v, name);
        return;
      case "SetPullerAdaptiveReferenceMachine": {
        if (v === null) {
          this.referenceMachine = null;
          return;
        }
        const uid = v as MachineIdentificationUnique;
        const target = world.byUid(uid);
        if (!target || target.slug !== "laser1")
          throw new MutationError("reference machine must be a laser");
        this.referenceMachine = sameMachine(uid, target.uid) ? target.uid : uid;
        return;
      }
      case "SetSpoolRegulationMode":
        this.spoolRegulation = oneOf(v, SPOOL_REGULATION, name);
        return;
      case "SetSpoolForward":
        this.spoolForward = bool(v, name);
        return;
      case "SetSpoolMinMaxMinSpeed":
        this.minmaxMin = num(v, name);
        return;
      case "SetSpoolMinMaxMaxSpeed":
        this.minmaxMax = num(v, name);
        return;
      case "SetSpoolAdaptiveTensionTarget":
        this.tensionTarget = num(v, name);
        return;
      case "SetSpoolAdaptiveRadiusLearningRate":
        this.radiusLearningRate = num(v, name);
        return;
      case "SetSpoolAdaptiveMaxSpeedMultiplier":
        this.maxSpeedMultiplier = num(v, name);
        return;
      case "SetSpoolAdaptiveAccelerationFactor":
        this.accelerationFactor = num(v, name);
        return;
      case "SetSpoolAdaptiveDeaccelerationUrgencyMultiplier":
        this.deaccelerationUrgency = num(v, name);
        return;
      case "SetSpoolAutomaticRequiredMeters":
        this.requiredMeters = num(v, name);
        this.automaticActionDone = false;
        return;
      case "SetSpoolAutomaticAction":
        this.automaticAction = oneOf(v, AUTOMATIC_ACTIONS, name);
        this.automaticActionDone = false;
        return;
      default:
        throw new MutationError(`unknown winder mutation ${name}`);
    }
  }
}
