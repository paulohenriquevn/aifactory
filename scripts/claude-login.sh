#!/usr/bin/env bash
# Changes the Claude Code account the factory uses: checks the new token really works, writes it to
# .env.local (mode 600, never printed, never in the shell history), restarts what reads it, starts again
# the tasks that were waiting for the old account, and lets the feeder go on.
#
#   1. In another terminal, at least 120 columns wide, signed in to the account you want:
#        claude setup-token
#      Open the link in a browser signed in to that account, and paste the code back. It prints a token
#      that starts with sk-ant-oat01-. (The code the page shows is NOT the token.)
#   2. Run this script and paste the token when it asks.
#
# The restart waits for the tasks in progress to finish (see scripts/deploy.sh). ENV_FILE and NO_RESTART=1
# exist for tests.
# FACTORY_CLAUDE_TOKEN_FILE is where the panel keeps the token it saved (src/server/factory/claude-token.ts).
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env.local}"
TOKEN_FILE="${FACTORY_CLAUDE_TOKEN_FILE:-.secrets/claude-oauth-token}"

read -rsp "Cole o token do Claude Code (não aparece na tela): " token
echo
if [[ ! "$token" =~ ^sk-ant-oat01-[A-Za-z0-9_-]{60,}$ ]]; then
  echo "Isso não parece o token: ele começa com sk-ant-oat01- e tem uns 100 caracteres. O código que a página do navegador mostra não é o token." >&2
  exit 1
fi

# A token that is refused, or whose account is already at its limit, is not worth saving.
reply=$(env -u ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN="$token" timeout 120 claude -p "Responda apenas: ok" --output-format json 2>&1 || true)
problem=$(printf '%s' "$reply" | python3 -c "
import sys, json
t = sys.stdin.read()
try:
    d = json.loads(t)
    print(str(d.get('result', ''))[:200] if d.get('is_error') else '')
except Exception:
    print(t[:200].replace(chr(10), ' ') or 'sem resposta do claude')
")
if [[ -n "$problem" ]]; then
  echo "Esse token não funciona agora: $problem" >&2
  echo "Nada foi gravado." >&2
  exit 1
fi
echo "O token funciona."

# Written beside the file and moved over it, so a failure never leaves it half written.
tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
chmod 600 "$tmp"
grep -v -e '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" > "$tmp" || true
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$token" >> "$tmp"
grep -q '^FACTORY_CLAUDE_AUTH=' "$tmp" || echo 'FACTORY_CLAUDE_AUTH=subscription' >> "$tmp"
mv "$tmp" "$ENV_FILE"
unset token reply
echo "Gravado em $ENV_FILE."
# A token saved from the panel wins over the environment file, so the old one would keep being used.
if [[ -e "$TOKEN_FILE" ]]; then
  rm -f "$TOKEN_FILE"
  echo "Removido o token que o painel tinha salvo, para valer o novo."
fi

if [[ "${NO_RESTART:-}" == "1" ]]; then exit 0; fi

working="select count(*) from task where stage in ('sandbox','build','push','verify','review','pr')"
if busy=$(docker compose exec -T postgres psql -U factory -d factory -At -c "$working" 2>/dev/null) \
  && [[ "$busy" != "0" ]]; then
  echo "$busy tarefa(s) estão trabalhando; o reinício espera elas terminarem (até 52 minutos)." >&2
fi

systemctl --user stop aifactory-feeder
# Each process finishes the run it is on before it restarts (KillMode=mixed, src/server/factory/drain.ts).
systemctl --user restart aifactory.service &
server=$!
systemctl --user try-restart 'aifactory-worker@*.service' &
workers=$!
wait "$server"
wait "$workers"
for _ in $(seq 1 40); do
  curl -fs -o /dev/null http://127.0.0.1:3000/api/health && break
  sleep 1
done
node scripts/retry-waiting.mjs
systemctl --user start aifactory-feeder
echo "Pronto: a fábrica já usa a conta nova."
