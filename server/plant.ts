// The simulated shop floor: EtherCAT bus, Modbus ports and the machines built
// from them. Mirrors how qitech_control identifies machines: every terminal's
// EEPROM holds {machine uid, role}; a machine exists once the backend (re)starts
// and finds all its roles. Modbus machines (the laser) come from port assignments.

import { machineUid, sameMachine } from "./protocol.ts";
import type { MachineIdentificationUnique } from "./protocol.ts";
import { AquapathSim } from "./sim/aquapath1.ts";
import { ExtruderSim } from "./sim/extruder.ts";
import { LaserSim } from "./sim/laser1.ts";
import type { MachineSim, TerminalSpec, World } from "./sim/machine.ts";
import { Winder2Sim } from "./sim/winder2.ts";

export type DeviceMachineIdentification = {
  machine_identification_unique: MachineIdentificationUnique;
  role: number;
};

export type EthercatDevice = {
  configured_address: number;
  name: string;
  vendor_id: number;
  product_id: number;
  revision: number;
  device_identification: {
    device_machine_identification: DeviceMachineIdentification | null;
    device_hardware_identification: { Ethercat: { subdevice_index: number } };
  };
};

export type ModbusPort = {
  port: string;
  present: boolean;
  device_node: string | null;
  by_id: string | null;
  description: string | null;
  usb_vid: number | null;
  usb_pid: number | null;
  usb_serial: string | null;
  assignment: {
    machine_identification_unique: MachineIdentificationUnique;
    slave_id: number;
  } | null;
};

export type MachineEntry = {
  machine_identification_unique: MachineIdentificationUnique;
  error: string | null;
};

const BECKHOFF = 2;

/** Machine types this demo can simulate, by machine id. */
const FACTORIES: Record<number, (serial: number) => MachineSim> = {
  0x0002: (s) => new Winder2Sim(s),
  0x0016: (s) => new ExtruderSim(s),
  0x0006: (s) => new LaserSim(s),
  0x0009: (s) => new AquapathSim(s),
};

export type Scenario = "running" | "cold";

export class Plant implements World {
  ethercatEnabled = true;
  ethercatState: "op" | "preop" | "no interface" = "op";
  devices: EthercatDevice[] = [];
  modbus: ModbusPort[] = [];
  machines: MachineEntry[] = [];
  /** Simulations by `${machine}/${serial}`; survive restarts like persisted config. */
  sims = new Map<string, MachineSim>();
  readonly scenario: Scenario;

  constructor(scenario: Scenario) {
    this.scenario = scenario;
    this.reset();
  }

  /** Factory state: the demo line wired up and identified, machines built. */
  reset() {
    this.ethercatEnabled = true;
    this.sims.clear();
    this.devices = [];
    this.modbus = [];

    const extruder = new ExtruderSim(1);
    const winder = new Winder2Sim(1);
    const laser = new LaserSim(1);
    const aquapath = new AquapathSim(1);
    const line: MachineSim[] = [extruder, aquapath, laser, winder];
    for (const sim of line) this.sims.set(key(sim.uid), sim);

    if (this.scenario === "running") {
      extruder.preset();
      aquapath.preset();
      laser.preset();
      winder.preset(laser.uid);
    }

    for (const sim of line) {
      for (const t of sim.terminals())
        this.addDevice(t, {
          machine_identification_unique: sim.uid,
          role: t.role,
        });
    }

    this.modbus = [
      {
        port: "/dev/ttyUSB0",
        present: true,
        device_node: "/dev/ttyUSB0",
        by_id: "/dev/serial/by-id/usb-FTDI_USB-RS485_Cable_FT6ZQ1K8-if00-port0",
        description: "USB-RS485 Cable",
        usb_vid: 0x0403,
        usb_pid: 0x6001,
        usb_serial: "FT6ZQ1K8",
        assignment: { machine_identification_unique: laser.uid, slave_id: 1 },
      },
      {
        port: "/dev/ttyUSB1",
        present: true,
        device_node: "/dev/ttyUSB1",
        by_id: "/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0",
        description: "USB Serial",
        usb_vid: 0x1a86,
        usb_pid: 0x7523,
        usb_serial: null,
        assignment: null,
      },
      {
        port: "/dev/ttyS0",
        present: true,
        device_node: "/dev/ttyS0",
        by_id: null,
        description: null,
        usb_vid: null,
        usb_pid: null,
        usb_serial: null,
        assignment: null,
      },
    ];
    this.restart(false);
  }

  private addDevice(
    t: TerminalSpec,
    ident: DeviceMachineIdentification | null,
  ) {
    const index = this.devices.length;
    this.devices.push({
      configured_address: 0x1000 + index,
      name: t.name,
      vendor_id: BECKHOFF,
      product_id: t.product_id,
      revision: t.revision,
      device_identification: {
        device_machine_identification: ident,
        device_hardware_identification: {
          Ethercat: { subdevice_index: index },
        },
      },
    });
  }

  /** What the backend does at startup: identify machines from EEPROMs and ports. */
  restart(preop: boolean) {
    this.ethercatState = !this.ethercatEnabled
      ? "no interface"
      : preop
        ? "preop"
        : "op";
    const found = new Map<
      string,
      { uid: MachineIdentificationUnique; roles: Set<number> }
    >();
    const note = (uid: MachineIdentificationUnique, role: number) => {
      const k = key(uid);
      if (!found.has(k)) found.set(k, { uid, roles: new Set() });
      found.get(k)!.roles.add(role);
    };
    if (this.ethercatState === "op") {
      for (const d of this.devices) {
        const id = d.device_identification.device_machine_identification;
        if (id) note(id.machine_identification_unique, id.role);
      }
    }
    for (const p of this.modbus) {
      if (p.present && p.assignment)
        note(p.assignment.machine_identification_unique, -1);
    }

    const machines: MachineEntry[] = [];
    for (const [k, { uid, roles }] of found) {
      const factory = FACTORIES[uid.machine_identification.machine];
      if (!factory || uid.machine_identification.vendor !== 1) continue;
      let sim = this.sims.get(k);
      if (!sim) {
        sim = factory(uid.serial);
        this.sims.set(k, sim);
      }
      const missing = sim
        .terminals()
        .filter((t) => !roles.has(t.role))
        .map((t) => `role ${t.role} (${t.name})`);
      machines.push({
        machine_identification_unique: uid,
        error: missing.length ? `Missing devices: ${missing.join(", ")}` : null,
      });
    }
    machines.sort(
      (a, b) =>
        a.machine_identification_unique.machine_identification.machine -
          b.machine_identification_unique.machine_identification.machine ||
        a.machine_identification_unique.serial -
          b.machine_identification_unique.serial,
    );
    this.machines = machines;
  }

  /** Simulations that are currently running (listed without error). */
  active(): MachineSim[] {
    const out: MachineSim[] = [];
    for (const m of this.machines) {
      if (m.error !== null) continue;
      const sim = this.sims.get(key(m.machine_identification_unique));
      if (sim) out.push(sim);
    }
    return out;
  }

  /** A new simulation of the same machine with factory defaults. */
  freshCopy(sim: MachineSim): MachineSim {
    return FACTORIES[sim.machineId](sim.serial);
  }

  find<T extends MachineSim>(slug: string): T | undefined {
    return this.active().find((s) => s.slug === slug) as T | undefined;
  }

  byUid(uid: MachineIdentificationUnique): MachineSim | undefined {
    return this.active().find((s) => sameMachine(s.uid, uid));
  }

  step(dt: number) {
    for (const sim of this.active()) sim.step(dt, this);
  }

  writeDeviceIdentification(
    subdeviceIndex: number,
    ident: DeviceMachineIdentification,
  ) {
    const d = this.devices[subdeviceIndex];
    if (!d)
      throw new Error(`no EtherCAT subdevice with index ${subdeviceIndex}`);
    d.device_identification.device_machine_identification = {
      machine_identification_unique: machineUid(
        ident.machine_identification_unique.machine_identification.machine,
        ident.machine_identification_unique.serial,
      ),
      role: ident.role,
    };
  }

  writeModbusAssignment(
    port: string,
    assignment: {
      machine_identification_unique: MachineIdentificationUnique;
      slave_id: number;
    } | null,
  ) {
    const p = this.modbus.find((m) => m.port === port);
    if (!p) throw new Error(`no Modbus port ${port}`);
    p.assignment = assignment;
  }
}

export function key(uid: MachineIdentificationUnique) {
  return `${uid.machine_identification.vendor}/${uid.machine_identification.machine}/${uid.serial}`;
}
