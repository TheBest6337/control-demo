#!/usr/bin/env bash
# Switches a QiTech Control panel to the demo. Control's updater runs this from
# its clone of the repo (/home/qitech/control-demo); it also works by hand.
#
# Back to control: pick an older generation in the boot menu, or run
#   cd /home/qitech/control && ./nixos-install.sh

set -euo pipefail
cd "$(dirname "$0")"

# --impure: the configuration reads /etc/nixos/hardware-configuration.nix
sudo nixos-rebuild boot \
  --flake .#nixos \
  --impure \
  --show-trace \
  -L

sudo reboot
