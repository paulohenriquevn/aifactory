#!/usr/bin/env bash
# Installs the user services that keep the factory running: the server, the tunnel and the daily backup.
# They start at boot without a login (linger), and restart if they exit.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$HOME/.config/systemd/user"
mkdir -p "$dest"
for unit in "$root"/ops/systemd/*; do
  sed -e "s#@ROOT@#$root#g" -e "s#@HOME@#$HOME#g" -e "s#@NODE_BIN@#$(dirname "$(command -v node)")#g" \
    -e "s#@CLOUDFLARED@#$(command -v cloudflared)#g" "$unit" > "$dest/$(basename "$unit")"
done
systemctl --user daemon-reload
loginctl enable-linger "$USER"
systemctl --user enable aifactory.service aifactory-tunnel.service aifactory-backup.timer
echo "installed in $dest; start them with: systemctl --user start aifactory aifactory-tunnel aifactory-backup.timer"
