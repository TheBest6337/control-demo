# Changes to the vendored UI

`ui/` is a copy of `control/electron` (revision in `ui/UPSTREAM`). It is kept as close to
upstream as possible so the demo looks exactly like production. `scripts/sync-ui.sh` re-applies
every change listed here.

| File | Change | Why |
|---|---|---|
| `src/main.ts`, `src/preload.ts`, `helpers/ipc/**/*-listeners.ts`, `*-context.ts`, `context-exposer.ts`, `listeners-register.ts`, `update/token-store.ts`, `export/removable-media.ts` | removed | Electron main-process code |
| `helpers/ipc/update/git-fetch-utils.ts` | reduced to its types | imported by `ChooseVersionPage` for `GitRefInfo` only |
| `src/browser-shim.ts` | **added** | stands in for the 7 preload globals (`themeMode`, `electronWindow`, `environment`, `update`, `troubleshoot`, `nixos`, `fileExport`) |
| `src/renderer.ts` | imports the shim first | |
| `client/useClient.tsx`, `client/socketioStore.ts`, `components/graph/excelExport/excelUtils.ts` | backend URL → `window.location.origin` | UI and mock are served from one origin |
| `routes/router.tsx` | start page `/setup/machines` instead of `/setup/ethercat` | demo opens on the machine list |
| `vite.config.ts` | replaced | browser-only build, dev proxy to the mock |

## What the shim does

- **Troubleshoot → Restart Backend Process / Into Preop**: `POST /demo/restart[?preop=1]`. The
  mock drops every Socket.IO transport, is "down" for 2.5 s and rebuilds its machine list from
  the EtherCAT/Modbus assignments, like the real backend after an EEPROM write.
- **Troubleshoot → Reboot HMI Panel**: `POST /demo/reset` (back to the initial demo state) and reload.
- **EtherCAT ON/OFF toggle**: `POST /demo/ethercat`. Takes effect on the next restart.
- **Export logs / graph export**: browser download.
- **Update**: tabs stay visible; fetching versions reports that updates are unavailable in the demo.
- Theme is always light and fullscreen uses the Fullscreen API.
- On first load it turns on the winder's "Adaptive puller speed" option (Winder → Config,
  stored in `localStorage`), because the demo line starts in diameter regulation.

## Upstream quirks kept as-is

They look the same in production:
- Missing lucide icons are logged to the console (`lu:MessageSquareWarning`, …).
- The Sora font `url()` in `styles/global.css` points at `assets/fonts/Sora/`, but the file is in `assets/Sora/`, so text falls back to the default sans-serif font.
