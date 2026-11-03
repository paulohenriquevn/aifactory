# Plano da aifactory

Plano recuperado em 2026-10-31 da sessão de arquitetura iniciada em 2026-10-30.
Este documento reúne as decisões acordadas, os marcos propostos e o ponto de
retomada. Relatos de releases externas não equivalem a uma verificação atual.

## Objetivo

Transformar issues do GitHub em pull requests verificadas, usando agentes de
programação em sandboxes na nuvem. A ferramenta é pessoal, open source e
single-tenant, com suporte a vários projetos.

## Decisões acordadas

- GitHub Issues é a fonte inicial; Linear entra depois por adapter.
- O executor é um CLI externo atrás de uma interface `CodingHarness`: Claude Code
  headless primeiro, Codex depois.
- O isolamento é fornecido por um `SandboxProvider` na nuvem. Sem isolamento, a
  execução é recusada; ambiente e acesso de saída usam allowlists.
- A dependência do TheoKit vem do npm publicado, sem link para o checkout local.
- Usar o máximo possível do TheoKit: verificar funcionalidades e pacotes do
  framework antes de adicionar bibliotecas ou mecanismos próprios. Lacunas devem
  ser registradas no framework antes de adotar um contorno documentado.
- Commits nunca incluem coautoria.

## Arquitetura planejada

```text
GitHub: issue com label factory
  → webhook TheoKit: assinatura + deduplicação por delivery ID
  → PostgreSQL: ingress → task
  → política de transição: aceita ou recusa com código e motivo
  → jobs persistidos: idempotência, lease, backoff e limite de concorrência
  → SandboxProvider → CodingHarness
  → estágios reportados pelo MCP da fábrica
  → fábrica executa checks no SHA e registra evidências + check run
  → review independente, somente leitura, no mesmo SHA
  → PR a partir do SHA aprovado
  → política de merge: off / trial / auto
  → vigia pós-merge → PR de revert se a main quebrar

Painel TheoKit: board, timeline, custos, evidências e inbox
```

Princípios:

- O agente não certifica o próprio trabalho: a fábrica executa os checks.
- Evidência, review e merge devem se referir ao SHA correspondente.
- Toda decisão deve ser registrada no audit log.
- Ausência de isolamento impede a execução.

## Marcos e critérios de aceite

Os marcos abaixo recuperam a proposta da sessão; os estados refletem o código
local inspecionado em 2026-11-03.

| Marco | Entrega                                                        | Critério de aceite                                                                                                                  | Estado       |
| ----- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| M0    | Fundação: TheoKit, PostgreSQL, Drizzle, CI, branch `workspace` | CI executa `theokit check` e testes, com resultado verde                                                                            | Concluído    |
| M1    | Ingestão                                                       | Uma issue com label `factory` gera exatamente uma task em `intake`; repetir o delivery não duplica                                  | Concluído    |
| M2    | Execução                                                       | Uma task de repositório de teste envia a branch `factory/<n>` e registra os estágios em ordem em `stage_event`                      | Não iniciado |
| M3    | Evidência + PR                                                 | PR só abre com evidência verde no head SHA; teste demonstra que uma declaração do agente sem evidência não abre PR                  | Não iniciado |
| M4    | Review + `waiting`                                             | Reprovação retorna ao build; após três rodadas, encaminha ao humano. Pergunta vira comentário na issue e resposta retoma a execução | Não iniciado |
| M5    | Painel + inbox                                                 | Board, timeline, custo e evidência em tempo real via SSE; aprovar, pedir mudanças e tentar novamente pelo painel                    | Não iniciado |
| M6    | Merge + vigia                                                  | `trial` registra “would merge” sem executar; `auto` faz merge preso ao SHA; main vermelha gera PR de revert                         | Não iniciado |
| M7    | Saúde e qualidade                                              | Custo por execução, achados tipados do supervisor como `stalled` e `orphaned`, gates CRAP, duplicação e mutação                     | Não iniciado |

As aprovações de ferramentas com efeitos externos seguem a convenção do
`AGENTS.md`. A interação entre essa regra e o futuro modo `auto` precisa ser
explicitada antes do M6.

## Base de conhecimento aprovada

```text
aifactory/                         código open source
  templates/knowledge/             template da base de conhecimento

factory-global                    repositório privado global
  MEMORY.md
  knowledge/                      regras e conhecimento curados
  memory/                         observações

<owner>/<projeto>-knowledge        repositório privado por projeto
  MEMORY.md
  knowledge/
  memory/
```

- Usar o formato Agent Memory Repo: `MEMORY.md` como índice, entradas com origem,
  data e links para documentos.
- Cada execução carrega a base global e a do projeto, presas a SHAs registrados.
- `knowledge/` tem autoridade de instrução e muda por PR aprovado pelo Paulo.
- `memory/` é referência observada, nunca instrução. O agente propõe via MCP;
  a fábrica valida e é a única escritora, serializando as escritas.
- Observações precisam de proveniência, escopo válido e referência à execução.
- Um curador deduplica, expira observações e propõe PRs promovendo lições para
  `knowledge/`; lições comuns podem ser propostas para a base global.
- O playbook base permanece no código da fábrica. `AGENTS.md` e a documentação do
  repositório de código continuam sendo contexto do projeto.
- O onboarding cria a base privada do projeto a partir do template; a execução
  recebe acesso somente às bases correspondentes.

## Sandbox: recomendação pendente de validação

O benchmark documental de 2026-10-30 recomendou Vercel Sandbox como primeiro
adapter e E2B como alternativa. Isso não é uma escolha validada em execução.
As contas e o spike estavam pendentes; bloqueiam M2, não M0 ou M1.

O spike deve verificar ao menos:

- Bloqueio de hosts fora da allowlist, incluindo comportamento de DNS.
- Ausência de secrets dentro da sandbox e compatibilidade do Claude Code com
  credenciais intermediadas pelo provedor.
- Streaming incremental de stdout.
- Preservação do workspace ao retomar.
- Se `waiting` exige preservar processos em memória ou apenas o filesystem.

As condições e capacidades dos provedores devem ser verificadas novamente no
spike, sem tratar o benchmark histórico como garantia atual.

## Ponto de retomada

O M0 foi interrompido para corrigir problemas encontrados no TheoKit, seguindo a
decisão de aproveitar o framework em vez de contorná-lo na fábrica. Com as correções
publicadas e adotadas, ele foi concluído em 2026-11-03.

A sessão relatou publicação do TheoKit 0.76.0 e correções em ORM e plugins.
O lote seguinte (#1037, #1031, #1038 e #1051 de `usetheokit/theokit`) foi concluído
em 2026-10-31: `theokit@0.76.1` e `create-theokit@3.0.21` foram publicados,
verificados como consumidor contra PostgreSQL real e as quatro issues foram
fechadas com evidências. Veja o [registro da release](THEOKIT-RELEASE-0.76.1.md).

Entre 2026-10-31 e 2026-11-03 a auditoria de prontidão do TheoKit abriu, corrigiu e verificou
no pacote publicado as issues #1069 a #1079, #1086, #1096, #1097, #1100 a #1102 e #1123. A
última versão é a `theokit@0.77.4`, que a fábrica adotou. Ficam fora da auditoria a
documentação do site (`website#26` e `website#27`) e o que depende de contas do Paulo: sandbox
na nuvem, Claude Code headless e OAuth do GitHub.

Estado local confirmado em 2026-11-03, com `theokit@0.77.4`:

- Scaffold React/TheoKit com página inicial e rotas de liveness e readiness.
- PostgreSQL local via Compose. O pool vem de `getStorageManager().usePostgres`, e o
  `theo.config.ts` monta o bloco `storage` a partir de `DATABASE_URL`.
- Tabelas `ingress` e `task` (migration `0000_ingest_and_task`) e o webhook
  `POST /api/webhooks/github`. Ainda não há agentes nem jobs. No servidor real (`theokit start`)
  contra o Postgres do Compose, uma entrega assinada criou uma task em `intake`, a mesma entrega
  respondeu `duplicate` e a assinatura inválida respondeu 401.
- Typecheck, lint, formatação, build e `theokit check` passam. Há 19 testes de unidade e 12 de
  integração, todos verdes contra o PostgreSQL do Compose.
- ADRs 0001 a 0003 em `docs/adr/`, e CI em `.github/workflows/ci.yml`.
- Readiness sem `DATABASE_URL`: o servidor sobe e `/api/ready` responde 503 com o motivo. Com
  uma URL que não é `postgres://`, o `theokit` recusa iniciar.

## Próximas ações para concluir M0

- [x] Confirmar a release publicada do TheoKit e a presença das correções necessárias.
- [x] Adotar o TheoKit corrigido (`^0.77.4`) e migrar a gestão do banco para o caminho
      suportado, com teste contra PostgreSQL real e proteção contra erro em conexão ociosa.
- [x] Resolver o contrato de `createPool`: o teste passou a exercitar o pool de `getPool()`.
- [x] Definir o comportamento de readiness para configuração inválida do banco.
- [x] Alinhar README e configuração com a fábrica.
- [x] Registrar ADRs da arquitetura, base de conhecimento e sandbox; esta última permanece
      proposta até o spike.
- [x] Configurar o CI: formatação, `theokit check` (tipos, lint e scan), testes de unidade e de
      integração, e build.
- [x] Confirmar o CI verde no GitHub após o primeiro push (run 41696481251, todos os passos).
- [x] Iniciar M1 com persistência do ingress, task e deduplicação de deliveries.

## Origem

Recuperado da sessão Claude Code
`d6692f50-0656-450e-9cf5-814e9a4c7fb7`, nas conversas de 2026-10-30 e 2026-10-31,
e das memórias `aifactory-architecture-decisions.md` e
`prefer-theokit-everything.md`. Este documento mantém o plano acessível sem
depender dos arquivos pessoais da sessão.
