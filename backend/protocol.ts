// Wire format of the qitech_control legacy API, as consumed by the UI.
// See ui/src/client/socketioStore.ts (eventSchema) and ui/src/machines/types.ts.

export const VENDOR_QITECH = 1;

export type MachineIdentification = { vendor: number; machine: number };
export type MachineIdentificationUnique = {
  machine_identification: MachineIdentification;
  serial: number;
};

export type Event<T> = { name: string; data: T; ts: number };

export function event<T>(name: string, data: T): Event<T> {
  return { name, data, ts: Date.now() };
}

export function machineUid(
  machine: number,
  serial: number,
): MachineIdentificationUnique {
  return { machine_identification: { vendor: VENDOR_QITECH, machine }, serial };
}

export function sameMachine(
  a: MachineIdentificationUnique | null | undefined,
  b: MachineIdentificationUnique | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.serial === b.serial &&
    a.machine_identification.vendor === b.machine_identification.vendor &&
    a.machine_identification.machine === b.machine_identification.machine
  );
}

/** `/machine/<vendor>/<machine>/<serial>`, as built by serializeNamespaceId in the UI. */
export function machineNamespace(uid: MachineIdentificationUnique): string {
  const { vendor, machine } = uid.machine_identification;
  return `/machine/${vendor}/${machine}/${uid.serial}`;
}

export const MACHINE_NAMESPACE_RE = /^\/machine\/(\d+)\/(\d+)\/(\d+)$/;

/**
 * A Rust externally tagged enum as serde_json writes it: unit variants are a
 * bare string, newtype variants a single-key object.
 */
export type Mutation = string | Record<string, unknown>;

export function splitMutation(m: Mutation): [string, unknown] {
  if (typeof m === "string") return [m, undefined];
  if (m && typeof m === "object") {
    const keys = Object.keys(m);
    if (keys.length === 1) return [keys[0], m[keys[0]]];
  }
  throw new MutationError(`invalid mutation: ${JSON.stringify(m)}`);
}

export class MutationError extends Error {}
