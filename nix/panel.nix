# A QiTech Control panel switched to the demo (nixosConfigurations.nixos).
#
# Control's updater clones this repo to /home/qitech/control-demo and runs
# ./nixos-install.sh, which builds this configuration. It keeps what the panel
# had: the hostname, the `qitech` user with passwordless sudo, the bootloader
# settings and the original stateVersion. The previous control generations stay
# in the boot menu, and the control clone stays in /home/qitech/control.
{ lib, ... }:

{
  imports = [ ./kiosk.nix ];

  # the kiosk runs as the panel's own user, so /home/qitech is kept
  services.qitech-control-demo.kiosk.user = "qitech";
  users.users.qitech = {
    isNormalUser = true;
    description = "QiTech HMI";
    extraGroups = [
      "networkmanager"
      "wheel"
    ];
  };
  security.sudo.wheelNeedsPassword = false;

  networking.hostName = "nixos";

  boot.loader.systemd-boot = {
    enable = true;
    consoleMode = "max";
  };
  boot.loader.efi.canTouchEfiVariables = true;
  boot.tmp.cleanOnBoot = true;

  # control panels were installed with 24.11; changing this would migrate state
  system.stateVersion = lib.mkForce "24.11";
}
