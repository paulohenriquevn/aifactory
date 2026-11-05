#!/usr/bin/env bash
# Builds and restarts the service, then waits for it to answer. The tunnel is not touched.
#
# Restarting stops the runs this process is working on, and each of those is minutes of the agent's
# usage limit. So it refuses while a task is working, unless FORCE=1 (or the database cannot be asked).
set -euo pipefail
cd "$(dirname "$0")/.."

working="select count(*) from task where stage in ('sandbox','build','push','verify','review','pr')"
if busy=$(docker compose exec -T postgres psql -U factory -d factory -At -c "$working" 2>/dev/null); then
  if [ "$busy" != "0" ] && [ "${FORCE:-}" != "1" ]; then
    echo "$busy task(s) are working, and a restart would stop the ones this process runs." >&2
    echo "Wait for them, stop the feeder to let the queue drain, or run FORCE=1 scripts/deploy.sh." >&2
    exit 2
  fi
else
  echo "could not ask the database whether tasks are working; going on" >&2
fi

pnpm build
systemctl --user restart aifactory.service
for _ in $(seq 1 40); do
  curl -fs -o /dev/null http://127.0.0.1:3000/api/health && { echo "aifactory is up"; exit 0; }
  sleep 1
done
echo "aifactory did not answer on :3000" >&2
journalctl --user -u aifactory.service -n 30 --no-pager >&2
exit 1
