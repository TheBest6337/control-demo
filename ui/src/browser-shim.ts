// control-demo: stand-ins for the globals that Electron's preload script
// (src/preload.ts → helpers/ipc/*-context.ts in control/electron) normally
// exposes. The machine pages never use them; they only back the
// theme/fullscreen/update/troubleshoot/export helpers.

const ok = async () => ({ success: true });
const noop = async () => {};
const UNAVAILABLE = "Software updates are not available in the demo.";

async function demo(
  path: string,
  body?: unknown,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${window.location.origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return res.ok
      ? { success: true }
      : { success: false, error: res.statusText };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

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
    environment: {
      getInfo: async () => ({ qitechOs: false }),
    },
    nixos: {
      isNixOSAvailable: false,
      listGenerations: async () => [],
      setGeneration: noop,
      deleteGeneration: noop,
      deleteAllOldGenerations: noop,
    },
    update: (() => {
      let fetchTargetsCb: ((r: unknown) => void) | undefined;
      let changelogCb: ((r: unknown) => void) | undefined;
      let endCb:
        | ((r: { success: boolean; error?: string }) => void)
        | undefined;
      return {
        execute: async () => endCb?.({ success: false, error: UNAVAILABLE }),
        fetchTargets: async () => fetchTargetsCb?.(UNAVAILABLE),
        fetchChangelog: async () => changelogCb?.(UNAVAILABLE),
        cancel: ok,
        checkLatestRelease: async () => ({ latest: null }),
        onLog: () => {},
        onEnd: (cb: typeof endCb) => {
          endCb = cb;
        },
        onStep: () => {},
        onFetchTargetsRecv: async (cb: typeof fetchTargetsCb) => {
          fetchTargetsCb = cb;
        },
        onFetchChangelog: async (cb: typeof changelogCb) => {
          changelogCb = cb;
        },
        hasToken: async () => false,
        saveToken: async () => ({ success: false, error: UNAVAILABLE }),
        loadTokenFromFile: async () => ({ success: false, error: UNAVAILABLE }),
        clearToken: ok,
      };
    })(),
    troubleshoot: {
      // "Reboot HMI" brings the whole demo back to its initial state
      rebootHmi: async () => {
        const r = await demo("/demo/reset");
        setTimeout(() => window.location.reload(), 500);
        return r;
      },
      restartBackend: () => demo("/demo/restart"),
      restartBackendIntoPreop: () => demo("/demo/restart?preop=1"),
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
        return demo("/demo/ethercat", { enabled });
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
