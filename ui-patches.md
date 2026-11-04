# Changes to the vendored UI

`ui/` is a copy of `control/electron` (revision in `ui/UPSTREAM`). It is kept as close to
upstream as possible so the demo looks exactly like production. `scripts/sync-ui.sh` re-applies
every change listed here. Replaced files (Spool, MarkerOverlay) are kept as they are; the
script warns when upstream changed them since the last sync.

| File | Change | Why |
|---|---|---|
| `src/main.ts`, `src/preload.ts`, `helpers/ipc/**/*-listeners.ts`, `*-context.ts`, `context-exposer.ts`, `listeners-register.ts`, `update/token-store.ts`, `export/removable-media.ts` | removed | Electron main-process code |
| `helpers/ipc/update/git-fetch-utils.ts` | reduced to its types | imported by `ChooseVersionPage` for `GitRefInfo` only |
| `src/browser-shim.ts` | **added** | stands in for the 7 preload globals (`themeMode`, `electronWindow`, `environment`, `update`, `troubleshoot`, `nixos`, `fileExport`) |
| `src/renderer.ts` | imports the shim first and `demo/prewarm` after the app | |
| `src/demo/prewarm.ts` | **added** | subscribes to every running machine at startup (pages open with data) and seeds the shift's graph markers from `GET /demo/markers` |
| `machines/winder/Spool.tsx` | **replaced** | spool turns on every animation frame from the latest rpm instead of jumping on each update |
| `components/graph/marker/MarkerOverlay.tsx` | marker dot on the graph value at its timestamp | upstream always draws it at mid-height |
| `client/useClient.tsx`, `client/socketioStore.ts`, `components/graph/excelExport/excelUtils.ts` | backend URL → `window.location.origin` | UI and mock are served from one origin |
| `routes/router.tsx` | start page `/machines/winder2/1/control` instead of `/setup/ethercat` | demo opens on a running machine |
| `vite.config.ts` | replaced | browser-only build, dev proxy to the mock |

## What the shim does

- **Troubleshoot → Restart Backend Process / Into Preop**: `POST /demo/restart[?preop=1]`. The
  mock drops every Socket.IO transport, is "down" for 2.5 s and rebuilds its machine list from
  the EtherCAT/Modbus assignments, like the real backend after an EEPROM write.
- **Troubleshoot → Reboot HMI Panel**: `POST /demo/reset` (back to the initial demo state) and reload.
- **EtherCAT ON/OFF toggle**: `POST /demo/ethercat`. Takes effect on the next restart.
- **Export logs / graph export**: browser download.
- **Update**: tabs stay visible; fetching versions reports that updates are unavailable in the demo.
- **Idle reset**: reports touches, clicks and key presses to `POST /demo/activity` (at most
  every 3 s) and polls `GET /demo/status`. When the server has reset the demo, it clears
  `localStorage`/`sessionStorage` and reloads.
- Theme is always light and fullscreen uses the Fullscreen API.
- On first load it turns on the winder's "Adaptive puller speed" option (Winder → Config,
  stored in `localStorage`), because the demo line starts in diameter regulation.

## Worth taking upstream

The Spool animation and the marker dot position fix bugs that the production UI has as well.

## Upstream quirks kept as-is

They look the same in production:
- Missing lucide icons are logged to the console (`lu:MessageSquareWarning`, …).
- The Sora font `url()` in `styles/global.css` points at `assets/fonts/Sora/`, but the file is in `assets/Sora/`, so text falls back to the default sans-serif font.
