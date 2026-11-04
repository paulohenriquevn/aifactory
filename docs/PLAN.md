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
- O executor é um CLI externo atrás de uma interface `CodingHarness`. Claude Code e
  Codex são suportados desde o início; o desenho deve aceitar outros assistentes de
  código sem mexer no orquestrador (seção "Agentes de código e autenticação").
- Cada agente paga com uma chave de API ou com a assinatura do dono (Paulo aceitou o
  risco em 2026-11-04). Em qualquer dos modos o segredo fica com a fábrica e o
  firewall do sandbox o injeta; só um fallback documentado coloca um token dentro.
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

| Marco | Entrega                                                        | Critério de aceite                                                                                                                                                                                   | Estado       |
| ----- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| M0    | Fundação: TheoKit, PostgreSQL, Drizzle, CI, branch `workspace` | CI executa `theokit check` e testes, com resultado verde                                                                                                                                             | Concluído    |
| M1    | Ingestão                                                       | Uma issue com label `factory` gera exatamente uma task em `intake`; repetir o delivery não duplica                                                                                                   | Concluído    |
| M2    | Execução                                                       | Uma task de repositório de teste envia a branch `factory/<n>` e registra os estágios em ordem em `stage_event`                                                                                       | Concluído    |
| M3    | Evidência + PR                                                 | PR só abre com evidência verde no head SHA; teste demonstra que uma declaração do agente sem evidência não abre PR                                                                                   | Concluído    |
| M3b   | Vários agentes de código                                       | Claude Code e Codex rodam a mesma task pelo mesmo `CodingHarness`, por chave ou assinatura, com o segredo fora do sandbox; trocar o agente é configuração                                            | Em andamento |
| M4a   | Review independente + rodadas                                  | Checks vermelhos ou review que pede mudanças devolvem o trabalho à mesma sessão do agente; após três tentativas, PR em rascunho e comentário na issue; um PR só abre com evidência verde e aprovação | Concluído    |
| M4b   | `waiting`                                                      | Pergunta do agente vira comentário na issue e a resposta de uma pessoa retoma a mesma sessão, num sandbox restaurado de snapshot                                                                     | Concluído    |
| M5    | Painel + inbox                                                 | Board, timeline, custo e evidência em tempo real via SSE; aprovar, pedir mudanças e tentar novamente pelo painel                                                                                     | Não iniciado |
| M6    | Merge + vigia                                                  | `trial` registra “would merge” sem executar; `auto` faz merge preso ao SHA; main vermelha gera PR de revert                                                                                          | Não iniciado |
| M7    | Saúde e qualidade                                              | Custo por execução, achados tipados do supervisor como `stalled` e `orphaned`, gates CRAP, duplicação e mutação                                                                                      | Não iniciado |

As aprovações de ferramentas com efeitos externos seguem a convenção do
`AGENTS.md`. A interação entre essa regra e o futuro modo `auto` precisa ser
explicitada antes do M6.

## Agentes de código e autenticação

Estado em 2026-11-04: o contrato `CodingHarness` (`egress`, `prepare`, `run`, `resume`, com
`sessionId` e sinal de cota no resultado) está implementado, com o Claude Code e o Codex como
harnesses e um registro que escolhe o agente por label `harness:<nome>`, `FACTORY_HARNESS` ou o
padrão. O Claude Code roda do início ao fim por chave de API e por assinatura. O Codex instala,
autentica pelo firewall e lê a parada por cota numa execução real da fábrica; falta uma execução que
complete uma issue, que depende da cota da conta do ChatGPT (libera em 2026-11-05 11:48). O
M3b fecha com essa execução, com a renovação do token do Codex exercitada contra a OpenAI e com o
login dedicado `~/.codex-factory-1`. Um terceiro agente deve custar um arquivo.

**Contrato do harness.** `CodingHarness` hoje só tem `run`. Para suportar vários agentes e o
`waiting` do M4, cada harness passa a declarar:

- `egress(credential)`: as regras de firewall que assinam as chamadas do agente (Claude: `x-api-key`
  ou `Authorization: Bearer`; Codex: o mesmo mecanismo contra a API da OpenAI).
- as variáveis de ambiente com placeholder, para que o CLI se comporte como logado sem receber o
  segredo.
- `run` e `resume(sessionId)`: o resultado devolve o `sessionId`, o custo e um sinal de limite de
  cota atingido, que é espera e não falha.
- um nome registrado. O harness de uma task vem de configuração, de um label da issue (como
  `harness:codex`) ou do padrão, e o reviewer do M4 pode usar um agente diferente do builder.

**Claude Code.** Chave de API ou token de `claude setup-token`, sempre pelo firewall. Verificado em
2026-11-04 com um token real: o CLI envia o bearer, o firewall o substitui e o sandbox só tem
o placeholder. A fábrica completa (issue, agente, push, checks, PR) rodou por assinatura, com
custo equivalente de US$ 0,04. O token vem de `claude setup-token`, que mostra na página do
navegador um código `código#estado` para colar de volta no terminal; só então imprime o token
`sk-ant-oat01-`. Não há necessidade do fallback com o token dentro do sandbox.

**Snapshots do Vercel Sandbox.** O SDK cria sandboxes persistentes por padrão e tira um snapshot
de cerca de 1 GB a cada `stop()`. Vinte execuções (16,8 GB) esgotaram o armazenamento do plano
Hobby, e todo `create` passou a falhar com 402 até os snapshots serem apagados. O adapter agora
cria com `persistent: false`, e o M4 deve tirar um snapshot explícito, com validade curta, só
quando uma task entrar em `waiting`.

**Codex.** `codex exec` sem interface. Com chave (`OPENAI_API_KEY`) o caminho é o mesmo do
Claude: placeholder no ambiente e firewall assinando. Com login do ChatGPT é mais difícil: o
`auth.json` tem token de renovação que rotaciona, e copiar o login do Paulo para um sandbox pode
invalidar o dele. O marshal-factory resolve com um login dedicado por sandbox simultâneo
(`CODEX_HOME` separado, "slots"). A fábrica deve fazer o mesmo, e talvez renovar o token no host
e assinar pelo firewall. A OpenAI recomenda não usar login de assinatura em repositório público.
Spike de 2026-11-04 em um sandbox real, com egress só para `registry.npmjs.org` e `chatgpt.com`:
o `codex` 0.166 instalou por npm e aceitou um `auth.json` de placeholder (id_token e access_token
com a assinatura trocada, refresh_token falso). O firewall assinou `Authorization: Bearer` e o
servidor respondeu com a mensagem de limite de uso da conta e a hora da liberação, o que só
acontece com a conta autenticada. O access token dura 10 dias e o de renovação pode ficar só no
host. A conexão por WebSocket falha com "Attack attempt detected" (o cabeçalho não é injetado no
upgrade) e o Codex cai para HTTPS depois de cinco tentativas; desligar o WebSocket na configuração
evita a demora. Uma execução completa não foi possível, porque a conta estava sem cota até
2026-11-05 11:48. Isso confirma que o sinal de limite atingido precisa virar espera. O login
usado foi copiado de `~/.codex`; um login dedicado em `~/.codex-factory-1` evita que o Codex do
Paulo e a fábrica invalidem o token um do outro quando um deles o renovar.

**Assinatura: limites e termos.** O uso do binário oficial `claude -p` com a assinatura do
próprio dono, nos próprios repositórios, está dentro dos termos lidos em 2026-11-04. Uma fábrica
ligada o dia todo cai numa zona cinzenta de volume, e a Anthropic recomenda chave de API para
qualquer coisa compartilhada. As regras mudaram várias vezes em 2026 e devem ser relidas antes
de depender delas. Efeitos para o código: "limite atingido" vira espera; o custo em dólar vira
valor equivalente e o painel o rotula assim.

**Assumir a sessão do agente.** O marshal-factory roda o T3 Code dentro do sandbox, e o botão
"Open in T3" gera um token de pareamento de 15 minutos para abrir a sessão no navegador e
conduzir o agente. O Vercel Sandbox permite isso: o SDK 3.9.1 tem `ports`, `domain(porta)`,
`snapshot` e `extendTimeout`. Não foi verificado se o T3 roda sem interface nesse sandbox, e a
regra "TheoKit primeiro" manda ver antes o que o framework já oferece. Quem tiver o link executa
código no sandbox, que não guarda segredos, então o link deve ser curto e de uso único. A sessão
no plano Hobby termina em 45 minutos. Fica depois do painel (M5), a menos que o Paulo peça antes.

**Ordem.** M3b (contrato, spike do Codex, spike da assinatura do Claude) antes do M4. O M4 usa
`resume` para a pergunta e a resposta. O "assumir ao vivo" vem depois do M5.

## Fora do escopo por enquanto, mas decidido que virá

- Vários repositórios com onboarding (hoje, um por vez, pelo GitHub App instalado em todos).
- Rodar sempre ligado: hoje o servidor e o túnel são processos da sessão de trabalho.
- Fonte Linear por adapter, depois do GitHub Issues.

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

## Sandbox: Vercel Sandbox aceito como primeiro adapter

O benchmark documental de 2026-10-30 recomendou o Vercel Sandbox, e o Paulo aceitou a escolha em
2026-11-03. O spike rodou no mesmo dia contra um projeto Hobby e verificou os cinco pontos
previstos: bloqueio de hosts fora da allowlist (incluindo DNS), segredo fora do sandbox,
streaming incremental de stdout, workspace preservado ao retomar e o que o estado `waiting`
precisa preservar. Os resultados estão na [ADR 0003](adr/0003-sandbox.md).

Uma chamada real do Claude Code dentro do sandbox, com a chave só no firewall, também
funcionou. O E2B segue como segundo adapter.

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
documentação do site (`website#26` e `website#27`) e o que depende de contas do Paulo: a chave
da Anthropic para o Claude Code headless e o acesso do GitHub à fábrica.

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
- ADRs 0001 a 0004 em `docs/adr/`, e CI em `.github/workflows/ci.yml`.
- M2: `runTask` leva uma task a `factory/<n>` e registra os estágios em `stage_event`. Contra o
  GitHub, a Vercel e o Postgres reais, com um agente roteirizado no lugar do Claude (`pnpm
test:e2e`), a issue #1 do playground virou uma branch `factory/1` enviada. A task e o job
  `run-task` entram juntos, na mesma transação, e o worker do TheoKit executa o job. Pela URL
  pública `factory.aquim.ai`, a label `factory` na issue #1 do playground levou o fluxo real,
  webhook do GitHub incluído, de `intake` a `done` em 31 segundos, por US$ 0,06: `factory/1` foi
  enviada pelo GitHub App e os 6 testes dela passam fora do sandbox. Com o Claude Code
  de verdade (`FACTORY_LIVE=1 pnpm test:e2e -t "real agent"`), o mesmo fluxo implementou a issue #1 em
  46 segundos, por US$ 0,03, enviou `factory/1` e os testes do que ele enviou passaram fora do
  sandbox. Uma primeira tentativa falhou num erro interno do GitHub no push (`fatal error in
commit_refs`), que não se repetiu; o push agora tenta até três vezes.
- M3: depois do push, a fábrica roda os checks (`npm test` por padrão) no commit enviado, dentro
  do sandbox, e grava cada resultado em `evidence` com o SHA, o código de saída real e o fim da
  saída. Uma função pura, `gate`, só libera o PR quando cada check exigido passou no SHA enviado;
  resultado de outro SHA não conta, e a ausência de checks exigidos também fecha o portão. O
  resultado vira o check run `aifactory/verify` no commit, e o PR abre apontando para a issue,
  com a fala do agente dentro de um bloco recolhido. Um teste com um agente que diz "todos os
  testes passam" enquanto `npm test` sai com 1 mostra que nenhum PR abre. Contra o GitHub real,
  o agente roteirizado e o Claude Code de verdade (US$ 0,06) abriram o PR com check run verde.
  Limite conhecido: um agente pode editar o próprio script de teste. Quem pega isso é o review
  independente do M4.
- M4a: depois dos checks verdes, um revisor independente (uma sessão nova do mesmo agente, ou outro
  por `FACTORY_REVIEWER`) lê o diff e devolve um veredito em JSON, gravado em `review`. A fábrica
  soma fatos que não dependem de modelo: o script `test` do `package.json` mudou, o diff toca
  `.github/` ou apaga testes. Checks vermelhos e review que pede mudanças voltam à mesma sessão do
  construtor (`claude -p --resume`, `codex exec resume`), com a saída que falhou ou os achados, até
  três tentativas. Sem aprovação e sem tentativas, a fábrica abre um PR em rascunho, comenta na issue
  e a task termina em `handoff`. Contra os serviços reais: o Claude Code construiu, outro Claude Code
  revisou e aprovou (US$ 0,04 no total, PR #9), e, com um revisor roteirizado que pediu um teste
  específico, o Claude real retomou a mesma sessão, acrescentou o teste, houve o segundo commit, o
  segundo review aprovou e o PR #10 abriu. Falta rodar o revisor em outro agente (Codex), por causa
  da cota da conta.
- M4b: o agente que não pode seguir sem uma decisão termina a resposta com `QUESTION:`. A fábrica salva
  o disco do sandbox num snapshot, comenta a pergunta na issue, grava tudo o que uma retomada precisa
  em `question` e põe a task em `waiting`. Um cron (`poll-answers`, a cada minuto) lê os comentários
  novos, aceita só os de quem tem acesso de escrita (`OWNER`, `MEMBER`, `COLLABORATOR`) e enfileira
  `resume-task` na mesma transação que grava a resposta. A retomada restaura o snapshot, apaga-o e
  retoma a mesma sessão do agente com a resposta. Contra os serviços reais, o Claude Code recebeu uma
  issue que mandava perguntar antes de escrever, fez uma pergunta com quatro opções, o snapshot e a
  restauração rodaram na Vercel, a resposta veio de um comentário real do dono do repositório, e a
  mesma sessão implementou o pedido e abriu o PR #12. Um snapshot custa cerca de 800 MB, restaurá-lo
  levou menos de um segundo, e nenhum sobrou depois. O cron enfileira por um backend de jobs
  compartilhado, porque job e cron não têm `ctx.queue`
  ([usetheokit/theokit#1150](https://github.com/usetheokit/theokit/issues/1150)).
- Readiness sem `DATABASE_URL`: o servidor sobe e `/api/ready` responde 503 com o motivo. Com
  uma URL que não é `postgres://`, o `theokit` recusa iniciar.

## Próximas ações para concluir M0

- [x] Confirmar a release publicada do TheoKit e a presença das correções necessárias.
- [x] Adotar o TheoKit corrigido (`^0.77.4`) e migrar a gestão do banco para o caminho
      suportado, com teste contra PostgreSQL real e proteção contra erro em conexão ociosa.
- [x] Resolver o contrato de `createPool`: o teste passou a exercitar o pool de `getPool()`.
- [x] Definir o comportamento de readiness para configuração inválida do banco.
- [x] Alinhar README e configuração com a fábrica.
- [x] Registrar ADRs da arquitetura, base de conhecimento e sandbox; a do sandbox foi
      aceita depois do spike.
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
