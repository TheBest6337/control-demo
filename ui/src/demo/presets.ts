// control-demo: example presets so visitors can try Presets → Apply right away.
//
// One preset per material on the extruder, winder and laser. Applied together
// they fit: the diameter follows extruder output ÷ puller speed (see
// backend/sim/laser1.ts), and diameter regulation only trims the puller by
// ±10 %, so each material sets a matching screw rpm and base puller speed.
//
//   PLA  1.75 mm: 32 rpm, 10 m/min   (the running line)
//   PETG 1.75 mm: 28 rpm, 8.75 m/min
//   ABS  2.85 mm: 40 rpm, 4.7 m/min  (1.75 · √((40/32)/(4.7/10)) ≈ 2.85)
//
// Seeded only when the visitor has no presets yet; idle reset and "Reboot HMI
// Panel" clear storage, so the next visitor gets them again.

const VENDOR_QITECH = 0x0001;
const EXTRUDER3 = { vendor: VENDOR_QITECH, machine: 0x0016 };
const WINDER2 = { vendor: VENDOR_QITECH, machine: 0x0002 };
const LASER1 = { vendor: VENDOR_QITECH, machine: 0x0006 };

type Seed = {
  name: string;
  machineIdentification: { vendor: number; machine: number };
  data: Record<string, unknown>;
};

const extruder = (
  name: string,
  [nozzle, front, middle, back]: [number, number, number, number],
  rpm: number,
): Seed => ({
  name,
  machineIdentification: EXTRUDER3,
  data: {
    targetNozzleHeatingTemperature: nozzle,
    targetFrontHeatingTemperature: front,
    targetMiddleHeatingTemperature: middle,
    targetBackHeatingTemperature: back,
    inverterRegulation: "RPM",
    targetInverterRpm: rpm,
    targetInverterPressure: 45,
    inverterRotationDirection: "Forward",
    pressureLimit: 100,
    pressureLimitEnabled: true,
    pidPressureKp: 0.16,
    pidPressureKi: 0,
    pidPressureKd: 0.008,
  },
});

const winder = (
  name: string,
  speed: number,
  filament: number,
): Seed => ({
  name,
  machineIdentification: WINDER2,
  data: {
    traverse_state: {
      limit_inner: 22,
      limit_outer: 92,
      step_size: filament,
      padding: Math.round(filament * 50) / 100,
      edge_dwell_revolutions: 0,
      start_dwell_revolutions: 0,
      laserpointer: false,
    },
    puller_state: {
      regulation: "Diameter",
      target_speed: speed,
      forward: true,
      gear_ratio: "OneToOne",
    },
    spool_speed_controller_state: {
      regulation_mode: "Adaptive",
      forward: true,
      minmax_min_speed: 0,
      minmax_max_speed: 150,
    },
  },
});

const laser = (name: string, diameter: number, tolerance: number): Seed => ({
  name,
  machineIdentification: LASER1,
  data: {
    targetDiameter: diameter,
    lowerTolerance: tolerance,
    higherTolerance: tolerance,
  },
});

export const SEEDS: Seed[] = [
  extruder("PLA 1.75 mm", [180, 180, 150, 130], 32),
  extruder("PETG 1.75 mm", [205, 205, 170, 145], 28),
  extruder("ABS 2.85 mm", [210, 210, 180, 150], 40),
  winder("PLA 1.75 mm", 10, 1.75),
  winder("PETG 1.75 mm", 8.75, 1.75),
  winder("ABS 2.85 mm", 4.7, 2.85),
  laser("PLA 1.75 mm", 1.75, 0.05),
  laser("PETG 1.75 mm (tight tolerance)", 1.75, 0.03),
  laser("ABS 2.85 mm", 2.85, 0.1),
];

/** Writes the example presets unless the visitor already has a preset store. */
export function seedDemoPresets() {
  const key = "preset-storage"; // name of the persisted store in lib/preset/presetStore.ts
  try {
    if (localStorage.getItem(key) !== null) return;
    // oldest first, so the list (newest on top) shows PLA, PETG, ABS
    const base = Date.now() - 24 * 3600 * 1000;
    const presets = SEEDS.map((seed, i) => ({
      id: i + 1,
      name: seed.name,
      lastModified: new Date(base - i * 60_000).toISOString(),
      machineIdentification: seed.machineIdentification,
      schemaVersion: 1,
      data: seed.data,
    }));
    localStorage.setItem(
      key,
      JSON.stringify({ state: { presets, latestPresetIds: [] }, version: 0 }),
    );
  } catch {
    // storage unavailable: the presets page just starts empty
  }
}
