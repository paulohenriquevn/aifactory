#!/usr/bin/env bash
# Builds and restarts the service, the workers and the feeder, then waits for the server to answer. The
# tunnel is not touched.
#
# A restart does not cut the runs in progress: systemd signals theokit only (KillMode=mixed), which stops
# taking jobs, waits for the run it is on (up to 32 minutes, see src/server/factory/drain.ts) and exits.
# So a deploy while tasks work takes as long as the longest of them.
set -euo pipefail
cd "$(dirname "$0")/.."

working="select count(*) from task where stage in ('sandbox','build','push','verify','review','pr')"
if busy=$(docker compose exec -T postgres psql -U factory -d factory -At -c "$working" 2>/dev/null); then
  if [ "$busy" != "0" ]; then
    echo "$busy task(s) are working; the restart waits for them to finish (up to 32 minutes)." >&2
  fi
else
  echo "could not ask the database whether tasks are working; going on" >&2
fi

pnpm build
# All at once, so each process drains its own run in parallel. The workers run tasks and the feeder hands them
# out from the same build, so each one left alone keeps the code from before it. try-restart restarts only the
# ones running: the feeder is started on purpose, never here.
systemctl --user restart aifactory.service &
server=$!
systemctl --user try-restart 'aifactory-worker@*.service' aifactory-feeder.service &
others=$!
wait "$server"
wait "$others"
for _ in $(seq 1 40); do
  curl -fs -o /dev/null http://127.0.0.1:3000/api/health && { echo "aifactory is up"; exit 0; }
  sleep 1
done
echo "aifactory did not answer on :3000" >&2
journalctl --user -u aifactory.service -n 30 --no-pager >&2
exit 1
