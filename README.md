# aifactory

Software factory que transforma issues do GitHub em pull requests verificadas, com agentes de
programação em sandboxes na nuvem. É uma ferramenta pessoal, open source e single-tenant, com
suporte a vários projetos.

Feita com [TheoKit](https://theokit.dev). O [plano](docs/PLAN.md) traz os marcos M0 a M7, e
[como a fábrica funciona](docs/como-funciona.md) descreve o fluxo, o isolamento, a evidência e o
uso do Claude Code e do Codex. Os marcos M0 a M7 estão concluídos: uma issue com a label `factory`
chega a um pull request, aberto só com os checks verdes no commit enviado e a aprovação de um
revisor independente, com até três tentativas de retrabalho na mesma sessão do agente. O Claude Code
funciona por chave de API ou por assinatura. O Codex também completa uma issue, como construtor e como
revisor. Quando o agente precisa
de uma decisão, ele pergunta na issue e a task espera a resposta de quem tem acesso de escrita.
O painel local (quadro, caixa de entrada, detalhe, aprovar, pedir mudanças e tentar de novo) mostra
tudo ao vivo. A fábrica entrega por pré-release (uma tag marcada como pré-release, que ela gera sempre), e a
release, o merge e a versão final, é feita por um humano pelo painel ou por um agente, conforme
`FACTORY_RELEASE_MODE`. Depois de um release, um vigia olha os checks do merge na `main` e, se ficarem
vermelhos, abre um PR de revert que a fábrica nunca mergeia. A página Health do painel mostra o custo
por execução e o que o supervisor achou de errado (`stalled`, `orphaned`), e o CI cobra CRAP, duplicação
e mutação.

## Primeiros passos, pelo painel

Com o servidor no ar (`scripts/install-services.sh`, ou `pnpm dev`), abra `http://localhost:3000` e entre
com o token de `FACTORY_PANEL_TOKEN`.

1. A página Setup mostra o que falta e leva à página que conserta.
2. Em Repositories, o botão "Install on GitHub" abre o GitHub, onde você escolhe a conta ou a
   organização e o que a App alcança, e o painel percebe quando a instalação termina. Habilite os repositórios em que a fábrica pode trabalhar e ajuste os checks, os
   domínios e os agentes de cada um.
3. Em Plans, escreva o objetivo, revise as issues que o agente propõe e crie-as (já iniciadas ou não).
4. O botão New job no quadro abre uma issue avulsa.
5. Acompanhe no quadro, aprove, peça mudanças e faça o release.

Em toda caixa de texto há um botão "Help me say it" (ou "Set this up for me", nos checks de um
repositório): diga o que quer com as suas palavras e o assistente escreve o que a fábrica precisa. Nada muda
até você apertar "Use this". Precisa de `ANTHROPIC_API_KEY` no servidor.

Detalhes em [como a fábrica funciona](docs/como-funciona.md#do-zero-ao-primeiro-pr-pelo-painel).

## Rodando localmente

```bash
pnpm install
docker compose up -d                 # Postgres 17 na porta 54329 (só em 127.0.0.1)
cp .env.example .env                 # DATABASE_URL já aponta para o Compose
pnpm db:migrate                      # cria as tabelas ingress e task
pnpm dev
```

| Rota              | Resposta                                                             |
| ----------------- | -------------------------------------------------------------------- |
| `GET /api/health` | 200 sempre que o processo está de pé                                 |
| `GET /api/ready`  | 200 com o Postgres respondendo, 503 com o motivo quando não responde |

### Webhook do GitHub

`POST /api/webhooks/github` recebe as entregas. A GitHub App entrega os eventos `Issues` de todos os
repositórios em que está instalada, com o secret de `GITHUB_WEBHOOK_SECRET`; sem a App, configure no
repositório um webhook de eventos `Issues`, com conteúdo `application/json` e o mesmo secret.

- Uma issue que recebe a label `factory`, ou que é aberta com ela, vira uma task em `intake`.
- Cada entrega fica em `ingress`, com o resultado, um código e o motivo. Uma entrega repetida
  (mesmo `X-GitHub-Delivery`) não muda nada. Uma issue tem no máximo uma task, mesmo que a label
  seja removida e posta de novo.
- Quando a entrega cria uma task, o job `run-task` entra na fila na mesma transação (job do
  TheoKit, em Postgres). O worker do `theokit start` o executa: sandbox isolado, agente e push de
  `factory/<n>`.
- A assinatura `X-Hub-Signature-256` é verificada sobre o corpo bruto antes de qualquer escrita.
  Assinatura inválida ou ausente responde 401. Sem `GITHUB_WEBHOOK_SECRET` a rota responde 503.

### Painel

`http://localhost:3000`, com o token de `FACTORY_PANEL_TOKEN`. O servidor deve escutar só nesta
máquina (`HOST=127.0.0.1 pnpm start`): o painel não passa pelo túnel, que só deixa o webhook e o health
check saírem. Veja [como a fábrica funciona](docs/como-funciona.md#o-painel).

### Exposição pública

O webhook precisa de uma URL pública. A fábrica usa um Cloudflare Tunnel para `factory.aquim.ai`,
criado a partir desta máquina, que expõe **só** o webhook e o health check; qualquer outro caminho
responde 404 na borda da Cloudflare.

```yaml
# ~/.cloudflared/aifactory.yml (fora do repositório; a credencial do túnel fica em ~/.cloudflared/)
tunnel: <id do túnel>
credentials-file: /home/<usuário>/.cloudflared/<id do túnel>.json
ingress:
  - hostname: factory.aquim.ai
    path: ^/api/(webhooks/github|health)$
    service: http://localhost:3000
  - service: http_status:404
```

```bash
cloudflared tunnel --config ~/.cloudflared/aifactory.yml run aifactory
```

O webhook do GitHub App aponta para essa URL (`node --env-file=.env.local
scripts/github-app-webhook.mjs https://factory.aquim.ai/api/webhooks/github` grava a URL, o tipo de
conteúdo e o secret). A API do GitHub não liga o webhook do App: a caixa "Active" fica na página de
configurações do App, e o GitHub pede a confirmação de acesso (sudo) para abri-la. No repositório de
teste há também um webhook próprio do repositório, com a mesma URL e o mesmo secret.

### Readiness

Sem `DATABASE_URL` o servidor sobe e `/api/ready` responde 503 com "Database "main" not
configured". Com `DATABASE_URL` que não é uma URL `postgres://`, o `theokit` recusa iniciar e
mostra o erro de configuração.

## Comandos

```bash
pnpm dev                # servidor de desenvolvimento
pnpm build && pnpm start
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test               # unidade
pnpm test:integration   # exige Postgres e DATABASE_URL exportada
pnpm test:e2e           # GitHub, Vercel Sandbox e Postgres reais; exige o .env.local
pnpm quality            # cobertura, CRAP, duplicação e mutação (os gates do job `quality` do CI)
FACTORY_LIVE=1 pnpm test:e2e -t "real agent"   # com o Claude Code de verdade; custa centavos
pnpm db:generate        # drizzle-kit: gera migrations a partir do schema
pnpm db:migrate
```

Os testes de integração falham quando `DATABASE_URL` não está definida. Uma suíte pulada em
silêncio passaria por verde. Eles nunca rodam no banco da fábrica: um arquivo de setup aponta as
suítes para `<nome>_test` no mesmo servidor, que é criado sozinho, porque elas truncam as tabelas e
o banco real guarda as tasks.

## Estrutura

```
src/app/              frontend (React, roteamento por arquivos)
src/server/
  db/                 Postgres: config, pool, schema Drizzle e sonda de saúde
  ingest/             decisão sobre cada entrega do GitHub e persistência de ingress e task
  factory/            execução de uma task: sandbox isolado, agente, push de factory/<n>, estágios
  github/             autenticação do GitHub App e leitura de issues
  panel/              consultas, ações, sessão e eventos do painel
  crons/              poll-answers (respostas), watch-main (vigia da main) e supervise (saúde)
src/shared/           contratos que o servidor e a interface leem
src/app/              a interface do painel (React)
  routes/             rotas HTTP (health, ready, webhooks/github)
drizzle/              migrations geradas pelo drizzle-kit
scripts/               registro e verificação do GitHub App (ADR 0004)
spikes/vercel-sandbox/ scripts que verificam o Vercel Sandbox (ADR 0003); rodam com `.env.local`
.theokit/             contexto de agente (THEO.md, rules, personalities), versionado
docs/PLAN.md          plano, marcos e ponto de retomada
docs/como-funciona.md  o fluxo da fábrica, o isolamento e os agentes
docs/adr/             decisões de arquitetura
theo.config.ts        configuração do TheoKit, inclusive o bloco `storage`
```

### Banco de dados

O pool do Postgres pertence ao `StorageManager` do TheoKit: `getPool()` chama
`getStorageManager().usePostgres('main', ...)`. O manager encerra o pool no desligamento e registra
um aviso, sem derrubar o processo, quando o Postgres derruba uma conexão ociosa
([usetheokit/theokit#1019](https://github.com/usetheokit/theokit/issues/1019)).

O TheoKit lê credenciais como campos e não lê `DATABASE_URL`. Por isso `theo.config.ts` separa a
URL em servidor e banco (`src/server/db/config.ts`) e o `drizzle-kit` continua usando a mesma
variável.

## Contexto para agentes

`AGENTS.md` descreve o código para quem o escreve. `.theokit/THEO.md` descreve o produto para o
agente que conversa com os usuários. O segundo ainda é o texto do scaffold, porque a fábrica não
tem agente.
