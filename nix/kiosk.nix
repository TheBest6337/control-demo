# A complete demo station: boots straight into the full-screen demo UI.
# Used by nixosConfigurations.kiosk (installed PC), .kiosk-vm and packages.iso.
{ lib, pkgs, ... }:

{
  imports = [ ./module.nix ];

  services.qitech-control-demo = {
    enable = true;
    kiosk.enable = true;
  };

  networking.hostName = lib.mkDefault "qitech-demo";
  networking.networkmanager.enable = lib.mkDefault true;
  time.timeZone = lib.mkDefault "Europe/Berlin";
  i18n.defaultLocale = lib.mkDefault "en_US.UTF-8";
  console.keyMap = lib.mkDefault "de";

  # remote maintenance; add your key in a host override
  services.openssh = {
    enable = lib.mkDefault true;
    settings.PasswordAuthentication = lib.mkDefault false;
  };
  users.users.admin = {
    isNormalUser = true;
    extraGroups = [ "wheel" "networkmanager" ];
    initialPassword = lib.mkDefault "qitech";
  };

  # quiet boot: no console text before the UI appears
  boot.consoleLogLevel = 3;
  boot.initrd.verbose = false;
  boot.kernelParams = [
    "quiet"
    "udev.log_level=3"
  ];

  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];

  environment.systemPackages = [ pkgs.git ];

  system.stateVersion = "26.05";
}
