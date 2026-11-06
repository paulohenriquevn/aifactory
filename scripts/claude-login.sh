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
# FORCE=1 restarts even while tasks are working. ENV_FILE and NO_RESTART=1 exist for tests.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env.local}"

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

if [[ "${NO_RESTART:-}" == "1" ]]; then exit 0; fi

working="select count(*) from task where stage in ('sandbox','build','push','verify','review','pr')"
if busy=$(docker compose exec -T postgres psql -U factory -d factory -At -c "$working" 2>/dev/null) \
  && [[ "$busy" != "0" && "${FORCE:-}" != "1" ]]; then
  echo "$busy tarefa(s) estão trabalhando; reiniciar interrompe as que rodam nesses processos." >&2
  echo "O token já está gravado. Quando elas terminarem, rode: FORCE=1 scripts/claude-login.sh (ou reinicie os serviços)." >&2
  exit 2
fi

systemctl --user stop aifactory-feeder
systemctl --user restart aifactory.service
for w in 1 2 3; do
  if systemctl --user is-active --quiet "aifactory-worker@$w"; then systemctl --user restart "aifactory-worker@$w"; fi
done
for _ in $(seq 1 40); do
  curl -fs -o /dev/null http://127.0.0.1:3000/api/health && break
  sleep 1
done
node scripts/retry-waiting.mjs
systemctl --user start aifactory-feeder
echo "Pronto: a fábrica já usa a conta nova."
