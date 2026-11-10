import { machineUid, splitMutation } from "../protocol.ts";
import type { MachineIdentificationUnique, Mutation } from "../protocol.ts";

export type Notice = { title: string; message: string };

/** An EtherCAT terminal a machine expects, by role (see ui/src/machines/properties.ts). */
export type TerminalSpec = {
  role: number;
  name: string;
  product_id: number;
  revision: number;
};

/** Lookup of the other simulated machines, for couplings between them. */
export interface World {
  find<T extends MachineSim>(slug: string): T | undefined;
  byUid(uid: MachineIdentificationUnique): MachineSim | undefined;
}

export abstract class MachineSim {
  abstract readonly slug: string;
  abstract readonly machineId: number;
  readonly serial: number;

  /** Set when the next tick has to emit a StateEvent. */
  dirty = true;
  notices: Notice[] = [];

  constructor(serial: number) {
    this.serial = serial;
  }

  get uid(): MachineIdentificationUnique {
    return machineUid(this.machineId, this.serial);
  }

  /** EtherCAT terminals the machine needs; empty for Modbus-only machines. */
  abstract terminals(): TerminalSpec[];

  /** StateEvent data without `is_default_state`. */
  abstract state(): Record<string, unknown>;

  /** LiveValuesEvent data. */
  abstract live(): Record<string, unknown>;

  /** Advances the simulation by `dt` seconds. */
  abstract step(dt: number, world: World): void;

  /** Applies one mutation; throws MutationError for unknown or malformed input. */
  protected abstract apply(name: string, value: unknown, world: World): void;

  mutate(m: Mutation, world: World): void {
    const [name, value] = splitMutation(m);
    this.apply(name, value, world);
    this.dirty = true;
  }

  notify(title: string, message: string) {
    this.notices.push({ title, message });
  }
}
