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
# The framework runs one job at a time per process. FACTORY_WORKERS=3 adds three processes that only run
# jobs (ports 3001 to 3003), so four tasks can run at once. The crons stay in the main process.
for n in $(seq 1 "${FACTORY_WORKERS:-0}"); do
  systemctl --user enable "aifactory-worker@$n.service"
done
echo "installed in $dest; start them with: systemctl --user start aifactory aifactory-tunnel aifactory-backup.timer"
