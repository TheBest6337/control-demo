# QiTech Control Demo

The QiTech Control operator UI running in a browser against **simulated machines**. Customers
can try every page and every setting without any hardware: extruder, winder, laser, aquapath,
the EtherCAT subdevices and the Modbus port.

- `ui/` is the real renderer from [`control/electron`](https://github.com/qitechgmbh/control),
  vendored with a handful of browser patches (see [ui-patches.md](ui-patches.md)).
- `backend/` is a mock of `qitech_control` that **runs in the browser**. The UI's Socket.IO
  client and its REST calls are wired to it in memory, so the demo is a static site: after
  loading its files it makes no network requests, and every visitor runs their own line.
- `server/` is a tiny static file server for the kiosk and `npm start`. Any web host works too.
- `nix/` is a NixOS module plus a kiosk configuration: the machine boots straight into the
  full-screen demo.

## Simulated line

| UI | Machine | What happens |
|---|---|---|
| Extruder | ExtruderV3 (`extruder3`, id 22, serial 1) | 4 heating zones with a thermal model, screw ramp, pressure from rpm and melt viscosity, RPM or pressure regulation, cold-extrusion lock (all zones ≥ 120 °C; the real default is 150 °C), pressure limit, inverter status, pressure PID auto-tune, ObserverPI/PID algorithm switch |
| Winder | WinderV1 (`winder2`, id 2, serial 1) | traverse homing, jogging and traversing between limits with dwell, tension arm zeroing, puller with gear ratio, spool rpm from a growing spool radius, MinMax/Adaptive spool control, meter counter with automatic Pull/Hold action, **diameter regulation from the laser** |
| Laser | LaserV1 (`laser1`, id 6, Modbus on `/dev/ttyUSB0`) | diameter from extruder output ÷ puller speed with process drift, x/y diameter, roundness, tolerance check, out-of-tolerance warning |
| Aquapath | AquapathV1 (`aquapath1`, id 9, serial 1) | two reservoirs: pump with cooldown, heater, fan cooling ramp Low/Ramp/Max (same bands as the real controller), heat input from the extruded strand, "Thermal Control Reset" notices |

The machines are coupled. Speeding up the puller makes the filament thinner. The winder
starts in *Speed Regulation → Adaptive* with the laser as reference, so it brings the diameter
back into tolerance on its own; switch to *Fixed* and change the puller speed to see the
diameter leave the tolerance band.

**Setup pages.**
- EtherCAT lists the 14 Beckhoff terminals of the three EtherCAT machines (EK1100, EL6021, EL2004, EL3021, EL3204, EL2002, EL7041, EL7031, EL2008, EL4002, EL3024), all assigned in their EEPROMs.
- Reassigning a terminal and restarting the backend (the dialog does this) rebuilds the machine list. An incomplete machine shows up with a "Missing devices" error, as on a real line.
- Modbus shows three serial ports.
- Troubleshoot → *Restart Backend Process* emulates a restart. *Reboot HMI Panel* resets the whole demo.

**One hour of history.** On page load the backend runs the simulation through the past hour,
which takes about 0.2 s. Every graph opens with a full hour of data, and the UI keeps all
machines subscribed from the start, so no page opens empty. That hour follows a scripted shift
(`backend/timeline.ts`): spool changes, a screw speed step, a nozzle temperature change and
masterbatch added. Four of these events carry graph markers inside the default 30‑minute
window: nozzle temperature, masterbatch, new spool and quality check. The demo opens on the
winder's control page.

**Idle reset** (kiosk). With `?idleReset=150` in the URL, the demo returns to its initial state
after 150 s (2.5 min) without a touch, click, key press or setting change: the page reloads on the start
page with presets and local settings cleared, so the next visitor finds the line running as
expected. Off by default, so website visitors are never reset (NixOS: `idleResetSeconds`).

**Example presets.** Extruder, winder and laser each come with *PLA 1.75 mm*, *PETG 1.75 mm*
and *ABS 2.85 mm* presets (`ui/src/demo/presets.ts`). Applying the same material on all three
switches the line to it: the winder's diameter regulation brings the laser back into tolerance
at the new diameter. They come back after an idle reset.

**Scenarios.** The default starts with a warm line producing 1.75 mm filament. `?scenario=cold`
starts everything in Standby at ambient temperature, as after power-on.

## Development

```bash
npm install
npm run dev        # Vite on http://localhost:5173
npm test           # simulations vs. the UI's own zod schemas and mutation lists
npm run build      # ui/dist (the static site) + dist-server
npm start          # serves ui/dist on http://localhost:3001
```

### Hosting on a website

`npm run build` and upload `ui/dist/` to any static host, at any path (e.g.
`https://example.com/control-demo/`). Asset URLs are relative and the UI routes in memory,
so no rewrite rules are needed. The page loads its own files and nothing else: no API, no
websocket, no tracking.

URL parameters:

| Parameter | Default | |
|---|---|---|
| `scenario` | `running` | `running` or `cold` |
| `idleReset` | `0` | back to the initial state after N s without input; 0 disables (use it on kiosks) |

The static server (`npm start`, NixOS) reads `PORT` (default `3001`), `HOST` (`0.0.0.0`) and
`DEMO_STATIC_DIR` (`ui/dist`).

Use Node 24; the Nix dev shell provides it: `nix develop`.

## NixOS kiosk

The flake provides:

- `packages.<system>.default`: the demo (`bin/qitech-control-demo`).
- `nixosModules.default`: the `services.qitech-control-demo` options.
- `nixosConfigurations.kiosk`: a complete demo PC. It autologins on tty1 into
  [cage](https://github.com/cage-kiosk/cage) running Chromium `--kiosk`, and never sleeps.
- `nixosConfigurations.kiosk-vm`: the same in QEMU, for trying it out.
- `packages.x86_64-linux.iso`: a bootable USB image that starts straight into the demo.

### Use the module in an existing NixOS config

```nix
{
  inputs.control-demo.url = "github:qitechgmbh/control-demo"; # or "path:/path/to/control-demo"

  outputs = { nixpkgs, control-demo, ... }: {
    nixosConfigurations.demo-pc = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./configuration.nix
        control-demo.nixosModules.default
        {
          services.qitech-control-demo = {
            enable = true;
            kiosk.enable = true;          # full-screen browser on the local display
            scenario = "running";         # or "cold"
            idleResetSeconds = 150;       # back to the running line when nobody touches it
            openFirewall = false;         # true: other devices can open http://<pc>:3001 (each runs its own line)
          };
        }
      ];
    };
  };
}
```

### Build and run

```bash
nix build .#default && ./result/bin/qitech-control-demo   # web server only
nix run .#nixosConfigurations.kiosk-vm.config.system.build.vm  # kiosk in a VM (Linux)
nix build .#iso                                            # USB image → result/iso/*.iso
sudo nixos-rebuild switch --flake .#kiosk                  # on an installed demo PC
```

### Switching a QiTech Control panel to the demo

In control's update page, point the update source at this repository. The updater clones
it to `/home/qitech/control-demo` and runs [`nixos-install.sh`](nixos-install.sh), which
builds `nixosConfigurations.nixos` ([`nix/panel.nix`](nix/panel.nix)) and reboots into the
kiosk. The panel keeps its hardware configuration, hostname, `qitech` user and stateVersion.

Back to control: pick an older generation in the boot menu, or run
`cd /home/qitech/control && ./nixos-install.sh` (SSH or a terminal).

Touch panels work without a system on-screen keyboard: the UI brings its own
(`components/touch/TouchNumpad.tsx`, `TouchKeyboard.tsx`).

## Updating the UI

```bash
scripts/sync-ui.sh ../control   # copies control/electron and re-applies the patches
npm test                        # fails if a machine's state/live payload or mutations changed
```

If a test fails, update the simulation in `backend/sim/` to the new fields. The tests parse
every payload with the UI's own schemas, and every mutation name in the machine hooks must be
handled.
