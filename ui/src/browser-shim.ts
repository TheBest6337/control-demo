// control-demo: stand-ins for the globals that Electron's preload script
// (src/preload.ts → helpers/ipc/*-context.ts in control/electron) normally
// exposes. The machine pages never use them; they only back the
// theme/fullscreen/update/troubleshoot/export helpers.
//
// It also starts the simulated backend, which runs in this page
// (backend/browser.ts): the demo makes no network requests besides loading
// its own static files.

import { getBackend, resetDemo } from "@backend/browser.ts";
import { seedDemoPresets } from "./demo/presets";
import {
  createDemoNixos,
  createDemoUpdate,
  demoEnvironment,
} from "./demo/updates";

const ok = async () => ({ success: true });
const noop = async () => {};

function download(params: {
  suggestedName: string;
  content: string;
  encoding: "utf8" | "base64";
}) {
  let blob: Blob;
  if (params.encoding === "base64") {
    const bin = atob(params.content);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes]);
  } else {
    blob = new Blob([params.content], { type: "text/plain" });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = params.suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { success: true, filePath: params.suggestedName, isRemovable: false };
}

if (!("themeMode" in window)) {
  const backend = getBackend();
  let ethercatEnabled = true;

  // The demo line starts with the winder regulating on the laser diameter;
  // show the "Adaptive" puller option (Winder → Config) unless the visitor
  // switched it off.
  try {
    const key = "winder2_adaptive_puller_speed_enabled";
    if (localStorage.getItem(key) === null) localStorage.setItem(key, "true");
  } catch {
    // storage unavailable: keep the UI default
  }

  // example presets per material on the extruder, winder and laser
  seedDemoPresets();

  // Like an HMI panel: taps and drags never select text. Inputs stay editable
  // and selectable.
  const noSelect = document.createElement("style");
  noSelect.textContent = `
    html, body, body * { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
    input, textarea, [contenteditable]:not([contenteditable="false"]), [contenteditable] * {
      -webkit-user-select: text; user-select: text;
    }
  `;
  document.head.appendChild(noSelect);

  // Idle reset (kiosk, `?idleReset=<s>`): the backend starts over from the
  // start page, with presets and settings cleared, after that long without
  // input. Touches, clicks and key presses count as input.
  const reportActivity = () => backend.touch();
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(type, reportActivity, {
      capture: true,
      passive: true,
    });
  }

  const restart = async (preop: boolean) => {
    if (backend.down)
      return { success: false, error: "backend is restarting" };
    backend.restart(preop);
    return { success: true };
  };

  Object.assign(window, {
    themeMode: {
      toggle: async () => false,
      dark: noop,
      light: noop,
      system: async () => false,
      current: async () => "light" as const,
    },
    electronWindow: {
      minimize: noop,
      maximize: noop,
      close: noop,
      fullscreen: async (value: boolean) => {
        try {
          if (value && !document.fullscreenElement) {
            await document.documentElement.requestFullscreen();
          } else if (!value && document.fullscreenElement) {
            await document.exitFullscreen();
          }
        } catch {
          // fullscreen may be refused without a user gesture; ignore
        }
      },
    },
    environment: demoEnvironment,
    nixos: createDemoNixos(),
    update: createDemoUpdate(),
    troubleshoot: {
      // "Reboot HMI" brings the whole demo back to its initial state
      rebootHmi: async () => {
        setTimeout(resetDemo, 500);
        return { success: true };
      },
      restartBackend: () => restart(false),
      restartBackendIntoPreop: () => restart(true),
      exportLogs: async () =>
        download({
          suggestedName: "qitech-control-demo-logs.txt",
          content: "control-demo: simulated machines, no backend logs.\n",
          encoding: "utf8",
        }),
      getEthercatEnabled: async () => ({
        success: true,
        enabled: ethercatEnabled,
      }),
      setEthercatEnabled: async (enabled: boolean) => {
        ethercatEnabled = enabled;
        backend.setEthercatEnabled(enabled);
        return { success: true };
      },
    },
    fileExport: {
      saveFile: async (params: Parameters<typeof download>[0]) =>
        download(params),
      ejectUsb: ok,
    },
  });
}

export {};
