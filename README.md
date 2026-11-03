# aifactory

Software factory que transforma issues do GitHub em pull requests verificadas, com agentes de
programação em sandboxes na nuvem. É uma ferramenta pessoal, open source e single-tenant, com
suporte a vários projetos.

Feita com [TheoKit](https://theokit.dev). O [plano](docs/PLAN.md) traz os marcos M0 a M7. O M0
(fundação) está em andamento: hoje existem o scaffold, o Postgres e as rotas de liveness e
readiness. Ingestão, execução, agentes e painel ainda não existem.

## Rodando localmente

```bash
pnpm install
docker compose up -d                 # Postgres 17 na porta 54329
cp .env.example .env                 # DATABASE_URL já aponta para o Compose
pnpm dev
```

| Rota              | Resposta                                                             |
| ----------------- | -------------------------------------------------------------------- |
| `GET /api/health` | 200 sempre que o processo está de pé                                 |
| `GET /api/ready`  | 200 com o Postgres respondendo, 503 com o motivo quando não responde |

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
pnpm db:generate        # drizzle-kit: gera migrations a partir do schema
pnpm db:migrate
```

Os testes de integração falham quando `DATABASE_URL` não está definida. Uma suíte pulada em
silêncio passaria por verde.

## Estrutura

```
src/app/              frontend (React, roteamento por arquivos)
src/server/
  db/                 Postgres: config, pool, schema Drizzle e sonda de saúde
  routes/             rotas HTTP (health, ready)
.theokit/             contexto de agente (THEO.md, rules, personalities), versionado
docs/PLAN.md          plano, marcos e ponto de retomada
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
