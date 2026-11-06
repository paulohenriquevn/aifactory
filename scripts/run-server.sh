#!/usr/bin/env bash
# What the aifactory service runs: wait for Postgres, apply migrations, serve the build.
# The environment comes from .env.local; the server listens on this machine only.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source .env.local
set +a
export DATABASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:54329/factory}"
export PORT="${PORT:-3000}" HOST=127.0.0.1

for _ in $(seq 1 60); do
  (exec 3<>/dev/tcp/127.0.0.1/54329) 2>/dev/null && break
  sleep 2
done

[ -f .theokit/manifest.json ] || pnpm build
pnpm exec theokit db migrate
# theokit itself becomes the service's main process, so a stop's SIGTERM reaches it with no wrapper between
# (KillMode=mixed signals only the main process). Its shim execs node.
exec node_modules/.bin/theokit start
