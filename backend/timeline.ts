// The past hour of the demo line, replayed while the history is pre-filled
// (server/main.ts: prefillHistory). Every event changes the simulation at
// that moment, and its markers show up on the UI's graphs at exactly that
// point. Spool changes and a speed change happen silently; only a few
// events carry a marker, enough to show the feature (all within the graphs'
// default 30 min window).

import type { Plant } from "./plant.ts";
import type { ExtruderSim } from "./sim/extruder.ts";
import type { LaserSim } from "./sim/laser1.ts";
import type { Winder2Sim } from "./sim/winder2.ts";

/** Graph groups as the UI keys its marker store (machineId props in *Graph*.tsx). */
export type MarkerGraph = "winder2" | "extruder-graphs" | "laser1-graphs";

export type DemoMarker = {
  graph: MarkerGraph;
  name: string;
  timestamp: number;
  color: string;
};

type TimelineEvent = {
  /** Seconds before "now" (the end of the pre-filled hour). */
  ago: number;
  markers: { graph: MarkerGraph; name: string; color: string }[];
  apply: (line: Line) => void;
};

type Line = {
  extruder?: ExtruderSim;
  winder?: Winder2Sim;
  laser?: LaserSim;
  plant: Plant;
};

const COLORS = {
  spool: "#16a34a",
  temperature: "#ea580c",
  material: "#2563eb",
  speed: "#475569",
  quality: "#9333ea",
};

function line(plant: Plant): Line {
  return {
    plant,
    extruder: plant.find<ExtruderSim>("extruder3"),
    winder: plant.find<Winder2Sim>("winder2"),
    laser: plant.find<LaserSim>("laser1"),
  };
}

/** Conditions an hour ago, before the events below. */
export function applyTimelineStart(plant: Plant) {
  const { extruder, winder } = line(plant);
  if (extruder) {
    extruder.zones.nozzle.target = 205;
    extruder.targetRpm = 30;
    extruder.rpm = 30;
  }
  if (winder) winder.spoolProgress = 180;
}

export const TIMELINE: TimelineEvent[] = [
  {
    ago: 55 * 60,
    markers: [],
    apply: ({ winder, plant }) => winder?.mutate("ResetSpoolProgress", plant),
  },
  {
    ago: 33 * 60,
    markers: [],
    apply: ({ winder, plant }) => winder?.mutate("ResetSpoolProgress", plant),
  },
  {
    ago: 26 * 60,
    markers: [
      {
        graph: "extruder-graphs",
        name: "Nozzle 205 → 210 °C",
        color: COLORS.temperature,
      },
    ],
    apply: ({ extruder, plant }) =>
      extruder?.mutate({ SetNozzleHeatingTemperature: 210 }, plant),
  },
  {
    ago: 18 * 60,
    markers: [
      {
        graph: "extruder-graphs",
        name: "Masterbatch added (blue, 2 %)",
        color: COLORS.material,
      },
    ],
    apply: ({ extruder, laser }) => {
      if (extruder) extruder.viscosityFactor = 1.04;
      if (laser) laser.disturbance = 0.035;
    },
  },
  {
    ago: 12 * 60,
    markers: [{ graph: "winder2", name: "New spool", color: COLORS.spool }],
    apply: ({ winder, plant }) => winder?.mutate("ResetSpoolProgress", plant),
  },
  {
    ago: 40 * 60,
    markers: [],
    apply: ({ extruder, plant }) =>
      extruder?.mutate({ SetInverterTargetRpm: 32 }, plant),
  },
  {
    ago: 5 * 60,
    markers: [
      {
        graph: "laser1-graphs",
        name: "Quality check OK (1.75 ± 0.02 mm)",
        color: COLORS.quality,
      },
    ],
    apply: () => {},
  },
];

/** Runs the events due at `ago` seconds before now; returns their markers. */
export function runTimeline(
  plant: Plant,
  fromAgo: number,
  toAgo: number,
  now: number,
): DemoMarker[] {
  const out: DemoMarker[] = [];
  const l = line(plant);
  for (const e of TIMELINE) {
    if (e.ago <= fromAgo && e.ago > toAgo) {
      e.apply(l);
      for (const m of e.markers)
        out.push({ ...m, timestamp: now - e.ago * 1000 });
    }
  }
  return out;
}
