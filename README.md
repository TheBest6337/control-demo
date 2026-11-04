# QiTech Control Demo

The QiTech Control operator UI running in a browser against **simulated machines**. Customers
can try every page and every setting without any hardware: extruder, winder, laser, aquapath,
the EtherCAT subdevices and the Modbus port.

- `ui/` is the real renderer from [`control/electron`](https://github.com/qitechgmbh/control),
  vendored with a handful of browser patches (see [ui-patches.md](ui-patches.md)).
- `server/` is a Node.js mock of `qitech_control`. It speaks the same legacy REST and
  Socket.IO (msgpack) API on one port and also serves the built UI.
- `nix/` is a NixOS module plus a kiosk configuration: the machine boots straight into the
  full-screen demo.

## Simulated line

| UI | Machine | What happens |
|---|---|---|
| Extruder | ExtruderV3 (`extruder3`, id 22, serial 1) | 4 heating zones with a thermal model, screw ramp, pressure from rpm and melt viscosity, RPM or pressure regulation, cold-extrusion lock, pressure limit, inverter status, pressure PID auto-tune, ObserverPI/PID algorithm switch |
| Winder | WinderV1 (`winder2`, id 2, serial 1) | traverse homing, jogging and traversing between limits with dwell, tension arm zeroing, puller with gear ratio, spool rpm from a growing spool radius, MinMax/Adaptive spool control, meter counter with automatic Pull/Hold action, **diameter regulation from the laser** |
| Laser | LaserV1 (`laser1`, id 6, Modbus on `/dev/ttyUSB0`) | diameter from extruder output ÷ puller speed with process drift, x/y diameter, roundness, tolerance check, out-of-tolerance warning |
| Aquapath | AquapathV1 (`aquapath1`, id 9, serial 1) | two reservoirs: pump with cooldown, heater, fan cooling ramp Low/Ramp/Max (same bands as the real controller), heat input from the extruded strand, "Thermal Control Reset" notices |

The machines are coupled. Speeding up the puller makes the filament thinner. The winder
starts in *Speed Regulation → Adaptive* with the laser as reference, so it brings the diameter
back into tolerance on its own; switch to *Fixed* and change the puller speed to see the
diameter leave the tolerance band.

**Setup pages.**
- EtherCAT lists the 14 Beckhoff terminals of the three EtherCAT machines (EK1100, EL6021, EL2004, EL3021, EL3204, EL2002, EL7041, EL7031, EL2008, EL4002, EL3024) with their EEPROM assignments, plus two unassigned spares.
- Assigning a spare and restarting the backend (the dialog does this) rebuilds the machine list. An incomplete machine shows up with a "Missing devices" error, as on a real line.
- Modbus shows three serial ports.
- Troubleshoot → *Restart Backend Process* emulates a restart. *Reboot HMI Panel* resets the whole demo.

**Scenarios.** `DEMO_SCENARIO=running` (default) starts with a warm line producing 1.75 mm
filament. `cold` starts everything in Standby at ambient temperature, as after power-on.

## Development

```bash
npm install
npm run dev        # mock on :3001 (watch mode) + Vite on http://localhost:5173
npm test           # simulations vs. the UI's own zod schemas and mutation lists
npm run build      # ui/dist + dist-server
npm start          # everything on http://localhost:3001
```

Environment variables for the server:

| Variable | Default | |
|---|---|---|
| `PORT` | `3001` | |
| `HOST` | `0.0.0.0` | |
| `DEMO_SCENARIO` | `running` | `running` or `cold` |
| `DEMO_IDLE_RESET_MIN` | `0` | reset the demo after N minutes without input |
| `DEMO_RESTART_DOWNTIME_MS` | `2500` | how long an emulated backend restart takes |
| `DEMO_STATIC_DIR` | `ui/dist` | built UI |

Requires Node ≥ 22.6 for `npm run dev`, which runs the server's TypeScript directly. Use Node 24 for everything; the Nix dev shell provides it: `nix develop`.

## NixOS kiosk

The flake provides:

- `packages.<system>.default`: the demo (`bin/qitech-control-demo`).
- `nixosModules.default`: the `services.qitech-control-demo` options.
- `nixosConfigurations.kiosk`: a complete demo PC. It autologins on tty1 into
  [cage](https://github.com/cage-kiosk/cage) running Chromium `--kiosk`, never sleeps, and resets after 15 min without input.
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
            idleResetMinutes = 15;
            openFirewall = false;         # true: other devices can open http://<pc>:3001
          };
        }
      ];
    };
  };
}
```

### Build and run

```bash
nix build .#default && ./result/bin/qitech-control-demo   # server only
nix run .#nixosConfigurations.kiosk-vm.config.system.build.vm  # kiosk in a VM (Linux)
nix build .#iso                                            # USB image → result/iso/*.iso
sudo nixos-rebuild switch --flake .#kiosk                  # on an installed demo PC
```

Touch panels work without a system on-screen keyboard: the UI brings its own
(`components/touch/TouchNumpad.tsx`, `TouchKeyboard.tsx`).

## Updating the UI

```bash
scripts/sync-ui.sh ../control   # copies control/electron and re-applies the patches
npm test                        # fails if a machine's state/live payload or mutations changed
```

If a test fails, update the simulation in `server/sim/` to the new fields. The tests parse
every payload with the UI's own schemas, and every mutation name in the machine hooks must be
handled.
