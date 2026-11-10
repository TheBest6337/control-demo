# Changes to the vendored UI

`ui/` is a copy of `control/electron` (revision in `ui/UPSTREAM`). It is kept as close to
upstream as possible so the demo looks exactly like production. `scripts/sync-ui.sh` re-applies
every change listed here. Replaced files (Spool, MarkerOverlay) are kept as they are; the
script warns when upstream changed them since the last sync.

**Ahead of `ui/UPSTREAM`:** the PDF machine manuals from
[control#1803](https://github.com/qitechgmbh/control/pull/1803) (commits `b089a89a`, `caa9fe83`
of `1802-add-new-machine-manuals`) are applied on top. Once that PR is merged, the next
`scripts/sync-ui.sh` brings in the same files.

| File | Change | Why |
|---|---|---|
| `src/main.ts`, `src/preload.ts`, `helpers/ipc/**/*-listeners.ts`, `*-context.ts`, `context-exposer.ts`, `listeners-register.ts`, `update/token-store.ts`, `export/removable-media.ts` | removed | Electron main-process code |
| `helpers/ipc/update/git-fetch-utils.ts` | reduced to its types | imported by `ChooseVersionPage` for `GitRefInfo` only |
| `src/browser-shim.ts` | **added** | stands in for the 7 preload globals (`themeMode`, `electronWindow`, `environment`, `update`, `troubleshoot`, `nixos`, `fileExport`) |
| `src/renderer.ts` | imports the shim first and `demo/prewarm` after the app | |
| `src/demo/prewarm.ts` | **added** | subscribes to every running machine at startup (pages open with data) and seeds the shift's graph markers from the in-browser backend |
| `src/demo/presets.ts` | **added** | example presets (PLA 1.75, PETG 1.75, ABS 2.85 mm) for the extruder, winder and laser, written by the shim when the visitor has no presets yet |
| `machines/winder/Spool.tsx` | **replaced** | spool turns on every animation frame from the latest rpm instead of jumping on each update |
| `components/graph/marker/MarkerOverlay.tsx` | marker dot on the graph value at its timestamp | upstream always draws it at mid-height |
| `lib/timeseries.ts` | **replaced** `insert`: O(1) ring-buffer write instead of immer `produce` | upstream copies and freezes the whole 3600-entry buffer on every sample, so replaying the hour of history blocked the page for ~20 s at startup |
| `client/useClient.tsx`, `client/socketioStore.ts`, `components/graph/excelExport/excelUtils.ts` | backend URL → `window.location.origin` | the in-browser backend answers same-origin `/api/…` calls |
| `routes/router.tsx` | start page `/machines/winder2/1/control` instead of `/setup/ethercat` | demo opens on a running machine |
| `vite.config.ts` | replaced | browser-only static build (`base: "./"`); aliases `socket.io-client` and `socket.io-msgpack-parser` to the in-browser backend |

## The backend runs in the page

There is no server: `backend/` (the simulated `qitech_control`) is bundled into the UI.

- **Socket.IO**: Vite aliases `socket.io-client` to `backend/socketio-client.ts`, an in-memory
  client with the same behaviour towards `socketioStore.ts` (async delivery, `connect` before the
  first event, reconnect after a dropped connection, explicit `disconnect()` stays down).
- **REST**: `backend/browser.ts` wraps `window.fetch` and answers same-origin `/api/…` requests;
  everything else goes to the real `fetch`.
- **Settings** come from the page URL: `?scenario=cold`, `?idleReset=150`.

## What the shim does

- Starts the in-browser backend before the app loads.
- **Troubleshoot → Restart Backend Process / Into Preop**: the backend drops every connection,
  is "down" for 2.5 s and rebuilds its machine list from the EtherCAT/Modbus assignments, like
  the real backend after an EEPROM write.
- **Troubleshoot → Reboot HMI Panel**: clears `localStorage`/`sessionStorage` and reloads, which
  starts a fresh simulation.
- **EtherCAT ON/OFF toggle**: takes effect on the next restart.
- **Export logs / graph export**: browser download.
- **Update** (`demo/updates.ts`): lists control's versions, branches and master commits with their changelogs from a snapshot (`demo/control-versions.json`, written by `scripts/snapshot-versions.mjs` during `sync-ui.sh`, loaded on first use). The current version is `ui/UPSTREAM`; "Installed Versions" shows it and the two releases before it. "Apply Update" explains in the terminal that the demo installs nothing.
- **Idle reset** (only with `?idleReset=<s>`): touches, clicks, key presses and setting changes
  count as input. After that many seconds without any, the page clears its storage and reloads.
- Theme is always light and fullscreen uses the Fullscreen API.
- Text cannot be selected (`user-select: none`), as on a panel; inputs stay selectable.
- On first load it turns on the winder's "Adaptive puller speed" option (Winder → Config,
  stored in `localStorage`), because the demo line starts in diameter regulation.

## Worth taking upstream

The Spool animation, the marker dot position and the O(1) time series insert fix bugs that the
production UI has as well.

## Upstream quirks kept as-is

They look the same in production:
- Missing lucide icons are logged to the console (`lu:MessageSquareWarning`, …).
- The Sora font `url()` in `styles/global.css` points at `assets/fonts/Sora/`, but the file is in `assets/Sora/`, so text falls back to the default sans-serif font.
