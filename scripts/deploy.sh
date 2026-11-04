#!/usr/bin/env bash
# Builds and restarts the service, then waits for it to answer. The tunnel is not touched.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm build
systemctl --user restart aifactory.service
for _ in $(seq 1 40); do
  curl -fs -o /dev/null http://127.0.0.1:3000/api/health && { echo "aifactory is up"; exit 0; }
  sleep 1
done
echo "aifactory did not answer on :3000" >&2
journalctl --user -u aifactory.service -n 30 --no-pager >&2
exit 1
