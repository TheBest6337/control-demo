// control-demo: keep every machine's namespace connected from app start.
//
// Upstream, a machine page opens its Socket.IO namespace when it mounts, so
// the first visit to a page shows empty values and graphs until data arrives.
// For the demo, open all running machines' namespaces as soon as the machine
// list is known and hold one reference forever: every page is filled with
// live data and graph history the moment a visitor opens it.

import { mainNamespaceStore } from "@/client/mainNamespace";
import { serializeNamespaceId, useSocketioStore } from "@/client/socketioStore";
import type { NamespaceId } from "@/client/socketioStore";
import { useMarkerStore } from "@/stores/markerStore";
import {
  aquapath1MessageHandler,
  createAquapath1NamespaceStore,
} from "@/machines/aquapath/aquapath1/aquapath1Namespace";
import {
  createExtruder3NamespaceStore,
  extruder3MessageHandler,
} from "@/machines/extruder/extruder3/extruder3Namespace";
import {
  createLaser1NamespaceStore,
  laser1MessageHandler,
} from "@/machines/laser/laser1/laser1Namespace";
import {
  createWinder2NamespaceStore,
  winder2MessageHandler,
} from "@/machines/winder/winder2/winder2Namespace";

type Impl = {
  createStore: () => any;
  createEventHandler: (...a: any[]) => any;
};

// machine id → the namespace implementation the machine's page hook uses
const IMPLEMENTATIONS: Record<number, Impl> = {
  0x0002: {
    createStore: createWinder2NamespaceStore,
    createEventHandler: winder2MessageHandler,
  },
  0x0016: {
    createStore: createExtruder3NamespaceStore,
    createEventHandler: extruder3MessageHandler,
  },
  0x0006: {
    createStore: createLaser1NamespaceStore,
    createEventHandler: laser1MessageHandler,
  },
  0x0009: {
    createStore: createAquapath1NamespaceStore,
    createEventHandler: aquapath1MessageHandler,
  },
};

/** Namespaces this module holds a reference on. */
const held = new Set<string>();

function prewarm() {
  const machines = mainNamespaceStore.getState().machines?.data?.machines ?? [];
  const sockets = useSocketioStore.getState();
  for (const m of machines) {
    if (m.error !== null) continue;
    const impl =
      IMPLEMENTATIONS[
        m.machine_identification_unique.machine_identification.machine
      ];
    if (!impl) continue;
    const id: NamespaceId = {
      type: "machine",
      machine_identification_unique: m.machine_identification_unique,
    };
    const path = serializeNamespaceId(id);
    const exists = sockets.hasNamespace(id);
    // the UI deletes a namespace when its machine leaves the list; take a new
    // reference once it is back
    if (held.has(path) && exists) continue;
    if (!exists)
      sockets.initNamespace(id, impl.createStore, impl.createEventHandler);
    // the reference that keeps the namespace (and its data) alive, also when
    // a page opened it first
    sockets.incrementNamespace(id);
    held.add(path);
  }
}

mainNamespaceStore.subscribe((state, prev) => {
  if (state.machines !== prev.machines) prewarm();
});
prewarm();

// ---------------------------------------------------------------- markers
//
// The server pre-fills an hour of history from a scripted shift
// (server/timeline.ts: new spools, temperature change, masterbatch, …) and
// publishes the matching graph markers. Put them into the UI's marker store
// next to whatever a visitor adds, replacing those of an earlier server run.

type DemoMarker = {
  graph: string;
  name: string;
  timestamp: number;
  color: string;
};

const SEEDED_KEY = "control-demo-seeded-markers";

async function seedMarkers() {
  let markers: DemoMarker[] = [];
  try {
    const res = await fetch(`${window.location.origin}/demo/markers`);
    if (!res.ok) return;
    markers = (await res.json()).markers;
  } catch {
    return;
  }
  const store = useMarkerStore.getState();
  let previous: DemoMarker[] = [];
  try {
    previous = JSON.parse(localStorage.getItem(SEEDED_KEY) ?? "[]");
  } catch {
    previous = [];
  }
  for (const m of previous) store.removeMarker(m.graph, m.timestamp, m.name);
  for (const m of markers) {
    const existing = useMarkerStore.getState().getMarkers(m.graph);
    if (
      !existing.some((e) => e.timestamp === m.timestamp && e.name === m.name)
    ) {
      store.addMarker(m.graph, {
        name: m.name,
        timestamp: m.timestamp,
        color: m.color,
      });
    }
  }
  try {
    localStorage.setItem(SEEDED_KEY, JSON.stringify(markers));
  } catch {
    // storage unavailable: markers still show for this session
  }
}

void seedMarkers();
