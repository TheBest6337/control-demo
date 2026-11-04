{
  description = "QiTech Control demo: the operator UI in a browser with simulated machines";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
  };

  outputs =
    { self, nixpkgs }:
    let
      forSystems = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      # an installed demo PC; falls back to a generic hardware profile when
      # /etc/nixos/hardware-configuration.nix is missing (CI, evaluation on macOS)
      hardware =
        { lib, modulesPath, ... }:
        let
          hw = /etc/nixos/hardware-configuration.nix;
        in
        if builtins.pathExists hw then
          { imports = [ hw ]; }
        else
          {
            imports = [ "${modulesPath}/profiles/all-hardware.nix" ];
            fileSystems."/" = lib.mkDefault {
              device = "/dev/disk/by-label/nixos";
              fsType = "ext4";
            };
            fileSystems."/boot" = lib.mkDefault {
              device = "/dev/disk/by-label/boot";
              fsType = "vfat";
            };
          };

      bootloader = {
        boot.loader.systemd-boot.enable = true;
        boot.loader.efi.canTouchEfiVariables = true;
      };
    in
    {
      overlays.default = final: _prev: {
        qitech-control-demo = final.callPackage ./nix/package.nix { };
      };

      nixosModules.default =
        { pkgs, ... }:
        {
          imports = [ ./nix/module.nix ];
          services.qitech-control-demo.package = pkgs.callPackage ./nix/package.nix { };
        };

      packages = forSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          demo = pkgs.callPackage ./nix/package.nix { };
        in
        {
          default = demo;
          qitech-control-demo = demo;
        }
        // nixpkgs.lib.optionalAttrs (system == "x86_64-linux") {
          # bootable live USB stick that starts straight into the demo
          iso =
            (nixpkgs.lib.nixosSystem {
              inherit system;
              modules = [
                ./nix/kiosk.nix
                (
                  { modulesPath, lib, ... }:
                  {
                    imports = [ "${modulesPath}/installer/cd-dvd/iso-image.nix" ];
                    isoImage.makeEfiBootable = true;
                    isoImage.makeUsbBootable = true;
                    image.baseName = lib.mkForce "qitech-control-demo";
                    services.qitech-control-demo.idleResetMinutes = 15;
                  }
                )
              ];
            }).config.system.build.isoImage;
        }
      );

      nixosConfigurations = {
        # `nixos-rebuild switch --flake .#kiosk` on the demo PC
        kiosk = nixpkgs.lib.nixosSystem {
          system = "x86_64-linux";
          modules = [
            ./nix/kiosk.nix
            hardware
            bootloader
          ];
        };

        # `nix run .#nixosConfigurations.kiosk-vm.config.system.build.vm`
        kiosk-vm = nixpkgs.lib.nixosSystem {
          system = "x86_64-linux";
          modules = [
            ./nix/kiosk.nix
            (
              { modulesPath, ... }:
              {
                imports = [ "${modulesPath}/virtualisation/qemu-vm.nix" ];
                virtualisation = {
                  memorySize = 3072;
                  cores = 2;
                  resolution = {
                    x = 1280;
                    y = 800;
                  };
                  qemu.options = [ "-device virtio-vga-gl" "-display gtk,gl=on" ];
                  forwardPorts = [
                    {
                      from = "host";
                      host.port = 3001;
                      guest.port = 3001;
                    }
                  ];
                };
                services.qitech-control-demo.openFirewall = true;
              }
            )
          ];
        };
      };

      devShells = forSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell { packages = [ pkgs.nodejs_24 ]; };
        }
      );

      formatter = forSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-rfc-style);
    };
}
