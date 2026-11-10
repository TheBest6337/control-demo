# NixOS module: runs the demo server and, optionally, a full-screen kiosk
# browser on the local display (cage + Chromium, autologin on tty1).
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.qitech-control-demo;
  url = "http://127.0.0.1:${toString cfg.port}/";
  # the simulation runs in the browser; its settings travel in the page URL
  kioskUrl = "${url}?scenario=${cfg.scenario}&idleReset=${toString cfg.idleResetSeconds}";

  kioskSession = pkgs.writeShellScript "qitech-control-demo-kiosk" ''
    # wait for the web server so the browser never shows an error page
    for _ in $(seq 1 120); do
      ${pkgs.curl}/bin/curl -fsS -o /dev/null ${url} && break
      sleep 0.5
    done
    exec ${lib.getExe cfg.kiosk.browser} \
      --kiosk "${kioskUrl}" \
      --ozone-platform=wayland \
      --incognito \
      --no-first-run \
      --no-default-browser-check \
      --noerrdialogs \
      --disable-infobars \
      --disable-session-crashed-bubble \
      --disable-translate \
      --disable-features=TranslateUI,Translate \
      --disable-pinch \
      --overscroll-history-navigation=0 \
      --check-for-update-interval=31536000 \
      --password-store=basic \
      --user-data-dir=/tmp/qitech-control-demo-browser \
      ${lib.escapeShellArgs cfg.kiosk.extraBrowserFlags}
  '';
in
{
  options.services.qitech-control-demo = {
    enable = lib.mkEnableOption "the QiTech Control demo (simulated machines + operator UI)";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = "The demo package.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3001;
      description = "Port of the demo web server.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Serve the demo on all interfaces and open the port, so other devices (tablets, laptops) can open it too. Every browser runs its own simulated line.";
    };

    scenario = lib.mkOption {
      type = lib.types.enum [
        "running"
        "cold"
      ];
      default = "running";
      description = ''
        Initial state of the simulated line in the kiosk browser. `running`: warm extruder,
        winder winding, laser in tolerance, aquapath in Auto. `cold`: everything
        in Standby at ambient temperature, as after power-on.
      '';
    };

    idleResetSeconds = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 150; # 2.5 min
      description = ''
        Return to the initial demo state after this many seconds without anyone
        touching the kiosk UI or changing a setting, so the next visitor finds
        the line as expected. 0 disables it.
      '';
    };

    kiosk = {
      enable = lib.mkEnableOption "the full-screen kiosk browser on tty1";

      user = lib.mkOption {
        type = lib.types.str;
        default = "kiosk";
        description = "User that runs the kiosk session (created if it does not exist).";
      };

      browser = lib.mkOption {
        type = lib.types.package;
        default = pkgs.chromium;
        defaultText = lib.literalExpression "pkgs.chromium";
        description = "Chromium-based browser used for the kiosk.";
      };

      extraBrowserFlags = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "--force-device-scale-factor=1.25" ];
        description = "Extra command line flags for the kiosk browser.";
      };
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        systemd.services.qitech-control-demo = {
          description = "QiTech Control demo web server";
          wantedBy = [ "multi-user.target" ];
          after = [ "network.target" ];
          environment = {
            PORT = toString cfg.port;
            HOST = if cfg.openFirewall then "0.0.0.0" else "127.0.0.1";
            NODE_ENV = "production";
          };
          serviceConfig = {
            Type = "simple";
            ExecStart = lib.getExe cfg.package;
            Restart = "always";
            RestartSec = "2s";
            DynamicUser = true;
            NoNewPrivileges = true;
            ProtectSystem = "strict";
            ProtectHome = true;
            PrivateTmp = true;
            PrivateDevices = true;
            ProtectKernelTunables = true;
            ProtectKernelModules = true;
            ProtectControlGroups = true;
            RestrictNamespaces = true;
            RestrictRealtime = true;
            LockPersonality = true;
            CapabilityBoundingSet = "";
            RestrictAddressFamilies = [
              "AF_INET"
              "AF_INET6"
              "AF_UNIX"
            ];
            SystemCallArchitectures = "native";
          };
        };

        networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
      }

      (lib.mkIf cfg.kiosk.enable {
        users.users.${cfg.kiosk.user} = {
          isNormalUser = lib.mkDefault true;
          description = lib.mkDefault "QiTech demo kiosk";
          extraGroups = [
            "video"
            "input"
          ];
        };

        # cage: a Wayland compositor that shows exactly one fullscreen app,
        # started by autologin on tty1
        services.cage = {
          enable = true;
          user = cfg.kiosk.user;
          program = kioskSession;
          extraArguments = [ "-d" ]; # no client-side decorations
          environment = {
            WLR_LIBINPUT_NO_DEVICES = "1"; # start even before a touchscreen shows up
            XCURSOR_SIZE = "24";
          };
        };
        systemd.services."cage-tty1" = {
          after = [ "qitech-control-demo.service" ];
          wants = [ "qitech-control-demo.service" ];
          # come back if the browser is closed or crashes
          serviceConfig.Restart = lib.mkForce "always";
          serviceConfig.RestartSec = lib.mkForce "2s";
        };

        hardware.graphics.enable = true;
        fonts.packages = [
          pkgs.dejavu_fonts
          pkgs.noto-fonts
        ];

        # a demo station stays awake (same as control/nixos/os/configuration.nix)
        systemd.targets.sleep.enable = false;
        systemd.targets.suspend.enable = false;
        systemd.targets.hibernate.enable = false;
        systemd.targets.hybrid-sleep.enable = false;
        services.logind.settings.Login = {
          HandlePowerKey = lib.mkDefault "ignore";
          HandleSuspendKey = "ignore";
          HandleHibernateKey = "ignore";
          HandleLidSwitch = "ignore";
          IdleAction = "ignore";
        };
      })
    ]
  );
}
