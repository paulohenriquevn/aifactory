# Como a fábrica funciona

Este documento descreve a fábrica como ela está hoje, com o Claude Code e com o Codex. Onde algo
ainda não existe, o texto diz. O plano e os marcos ficam em [PLAN.md](PLAN.md).

| Agente      | Estado em 2026-11-04                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Claude Code | Funciona do webhook ao pull request, por chave de API ou por assinatura. Testado ao vivo nos dois modos.           |
| Codex       | Verificado em um spike (instala, autentica pelo firewall). O harness ainda não existe e é o primeiro item do M3b.  |
| Outros      | O contrato `CodingHarness` foi pensado para aceitar mais um agente com um arquivo. Nenhum outro está implementado. |

## Visão geral

```
issue com a label "factory"
        |
        v  webhook assinado (X-Hub-Signature-256)
   ingress + task + job run-task          (uma transação, Postgres)
        |
        v  worker do TheoKit
   sandbox isolado ----- clone, branch factory/<n>
        |
        v
   agente (Claude Code ou Codex) implementa a issue
        |
        v
   a fábrica faz o commit e o push
        |
        v
   a fábrica roda os checks no commit enviado  --> tabela evidence
        |
        v
   portão: todos os checks passaram neste SHA?
        |-- não --> check run "failure", task em failed, nenhum PR
        |-- sim --> check run "success" + pull request com "Closes #<n>"
```

O agente escreve código. Quem commita, envia, verifica e abre o PR é a fábrica. Uma declaração do
agente, como "todos os testes passam", nunca vira evidência.

## Os estágios de uma task

Cada estágio fica gravado em `stage_event`, na mesma transação que atualiza `task.stage`.

| Estágio   | O que acontece                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| `intake`  | O webhook criou a task. Uma issue tem no máximo uma task, mesmo que a label saia e volte.                   |
| `sandbox` | Pede um token do GitHub App só para este repositório, lê a issue, cria o sandbox e clona o repositório.     |
| `build`   | O agente roda no sandbox, na branch `factory/<n>`, com o texto da issue como tarefa.                        |
| `push`    | Confere que houve mudança, faz o commit com a identidade do App e envia a branch (até três tentativas).     |
| `verify`  | Roda os checks exigidos (`npm test` por padrão) no commit enviado e grava cada resultado em `evidence`.     |
| `pr`      | Se o portão abriu, cria o check run `aifactory/verify` e o pull request, ou devolve o que já estava aberto. |
| `done`    | Guarda o SHA, a URL do PR e o custo.                                                                        |
| `failed`  | Qualquer falha. O detalhe traz `failedAt` (o estágio) e `error` (o motivo).                                 |

O job `run-task` não tenta de novo sozinho (`maxAttempts: 1`): repetir gastaria o orçamento do
agente na mesma issue. Uma task que falha fica em `failed` para uma pessoa olhar.

## Isolamento e segredos

A fábrica só roda um agente dentro de um sandbox com uma lista explícita de domínios de saída.
Lista vazia, `*` ou endereço IP fazem a execução ser recusada (`IsolationRefused`).

O sandbox é um microVM do Vercel Sandbox. Ele alcança apenas:

| Domínio              | Para quê              | O firewall injeta                                                  |
| -------------------- | --------------------- | ------------------------------------------------------------------ |
| `github.com`         | clone e push          | `Authorization: Basic` com o token do App, limitado ao repositório |
| `api.anthropic.com`  | o Claude Code         | `x-api-key` (chave) ou `Authorization: Bearer` (assinatura)        |
| `registry.npmjs.org` | instalar dependências | nada                                                               |

**O segredo nunca entra no sandbox.** O ambiente leva um placeholder (`placeholder-not-a-secret`) e
o firewall troca o cabeçalho na saída. Código malicioso dentro do sandbox não encontra a chave em
variável, arquivo ou comando. Ele só consegue pedir ao firewall que assine chamadas para os três
domínios acima.

Outras garantias:

- O token do GitHub vale para um repositório. O App está instalado em todos os da conta, então
  `installationToken(repo)` é o único caminho e sempre nomeia o repositório.
- Texto que veio da issue (título, corpo) chega ao git por arquivo, nunca por uma linha de shell.
- O sandbox é criado com `persistent: false`. Sem isso o SDK tira um snapshot de cerca de 1 GB a
  cada parada, e 20 execuções esgotam o armazenamento do plano Hobby (erro 402).
- Prazos: sandbox 30 minutos, agente 25 minutos, cada check 10 minutos. O job renova o lock a cada
  40 segundos (`extendLease`), então um worker que morre libera a task em minutos.
- O sandbox sempre é parado, inclusive quando o run falha ou o lock expira.

## Evidência e portão

Depois do push, a fábrica confere que o checkout é exatamente o commit enviado e que a árvore está
limpa. Em seguida roda cada check com `cd <repo> && <comando>` e grava na tabela `evidence`: nome,
comando, SHA, código de saída real, fim da saída e duração.

`gate()` é uma função pura. O PR só abre quando:

1. há ao menos um check exigido (lista vazia mantém o portão fechado);
2. cada check exigido tem resultado **para o SHA enviado** (resultado de outro commit não conta);
3. o resultado mais recente de cada um passou (código 0 e sem estouro de prazo).

O resultado também aparece no GitHub como o check run `aifactory/verify`. O corpo do PR traz
`Closes #<n>`, os checks e, dentro de um bloco recolhido, o que o agente disse.

Limite conhecido: um agente pode editar o próprio script de teste para sempre passar. O review
independente do M4 deve pegar isso.

## Claude Code

O harness roda `claude -p --output-format json --dangerously-skip-permissions` com o prompt lido
de um arquivo. As permissões ficam desligadas porque o sandbox é a fronteira e uma execução sem
interface não tem quem responda a uma pergunta. O resultado JSON traz o texto final, o custo e o
estado de erro.

O prompt manda o agente ler o `AGENTS.md`, adicionar ou atualizar testes, manter a mudança pequena,
não rodar nenhum comando git que escreva e não editar nada em `.github/`.

### Chave de API ou assinatura

| Modo           | Variável                  | Como a chamada é assinada           | Custo                                  |
| -------------- | ------------------------- | ----------------------------------- | -------------------------------------- |
| `api-key`      | `ANTHROPIC_API_KEY`       | `x-api-key` no firewall             | cobrado na chave                       |
| `subscription` | `CLAUDE_CODE_OAUTH_TOKEN` | `Authorization: Bearer` no firewall | sai da cota da assinatura (ver abaixo) |

Com as duas definidas, vale a chave. `FACTORY_CLAUDE_AUTH=api-key|subscription` escolhe. Se a
escolhida estiver faltando, a fábrica diz o que falta em vez de usar a outra.

No modo `subscription`, o `total_cost_usd` que o CLI informa é um valor equivalente: nada é
cobrado, mas a cota da assinatura é consumida. Ao atingir o limite, a execução falha com a
mensagem do CLI. Tratar isso como espera, e não como falha, é parte do M3b.

### Como gerar o token da assinatura

1. Rode `claude setup-token` num terminal largo (120 colunas ou mais), para o token caber numa linha.
2. Autorize no navegador. A página mostra um código no formato `código#estado`. Ele **não** é o token.
3. Cole o código de volta no terminal. O comando imprime o token final, que começa com
   `sk-ant-oat01-` e tem cerca de 100 caracteres.
4. Grave sem deixar rastro no histórico:

   ```bash
   read -rs "t?Cole o token: "; echo
   sed -i '/^CLAUDE_CODE_OAUTH_TOKEN=/d' .env.local
   printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$t" >> .env.local; unset t
   ```

O token dura um ano e só faz requisições de modelo.

### Termos de uso

O uso do binário oficial `claude -p` com a assinatura do próprio dono, nos próprios repositórios,
está dentro dos termos lidos em 2026-11-04. Uma fábrica ligada o dia todo cai numa zona cinzenta de
volume, e a Anthropic recomenda chave de API para qualquer coisa compartilhada. As regras mudaram
várias vezes em 2026 e devem ser relidas antes de depender delas.

## Codex

**Estado:** só o spike existe. A fábrica ainda não roda o Codex, e a implementação do harness é o
primeiro item do M3b.

O que o spike de 2026-11-04 mostrou, num sandbox real com saída apenas para `registry.npmjs.org` e
`chatgpt.com`:

- `npm i -g @openai/codex` instala o `codex` 0.166 no sandbox.
- Um `auth.json` com tokens de mentira (assinatura trocada, `refresh_token` falso) é aceito pelo
  CLI, e o firewall injetando `Authorization: Bearer` com o access token real basta para a
  autenticação: o servidor respondeu com a mensagem de limite de uso da conta e a hora da
  liberação, o que só acontece com a conta autenticada.
- O access token dura 10 dias. O token de renovação pode ficar só no host, que renova a cada poucos
  dias, e nunca entra no sandbox.
- A conexão por WebSocket falha com "Attack attempt detected", porque o cabeçalho não é injetado no
  upgrade. O Codex cai para HTTPS depois de cinco tentativas. Desligar o WebSocket na configuração
  evita a demora.
- Uma execução completa ficou pendente: a conta estava sem cota até 2026-11-05 11:48.

### Como será o harness do Codex

- `codex exec` sem interface, com o prompt por arquivo, como no Claude Code.
- Domínios de saída: `chatgpt.com` (login do ChatGPT) ou `api.openai.com` (chave
  `OPENAI_API_KEY`), mais `github.com` e `registry.npmjs.org`.
- Com chave de API, o caminho é o mesmo do Claude: placeholder no ambiente e firewall assinando.
- Com login do ChatGPT, o sandbox recebe um `auth.json` com placeholders e o firewall assina com o
  access token.

### Login dedicado do Codex

O `auth.json` do Codex tem um token de renovação que rotaciona. Se o Codex do Paulo e a fábrica
compartilharem o mesmo login, o primeiro que renovar invalida o outro. Por isso a fábrica usa um
login só dela:

```bash
CODEX_HOME=~/.codex-factory-1 codex login --device-auth
```

Cada execução simultânea do Codex precisa do seu próprio login (`~/.codex-factory-2` e assim por
diante). O Claude por token não tem essa restrição. A OpenAI recomenda não usar login de assinatura
em repositório público.

## O contrato para outros agentes

`CodingHarness` hoje tem `name` e `run(backend, input)`, e o resultado é `{ ok, summary, costUsd }`.
Para aceitar vários agentes e o `waiting` do M4, cada harness vai declarar também:

- `egress(credential)`: as regras de firewall que assinam as chamadas daquele agente;
- as variáveis de ambiente com placeholder;
- `resume(sessionId)`, e o resultado passa a devolver o `sessionId` e um sinal de limite de cota;
- um nome registrado, escolhido por configuração, por label da issue (como `harness:codex`) ou pelo
  padrão. O reviewer do M4 pode usar um agente diferente do builder.

Adicionar um agente deve custar um arquivo, sem mexer no orquestrador (`runTask`).

## Configuração

Tudo vem do ambiente, lido quando um job começa, não na subida do servidor. O servidor sobe e
responde `/api/health` mesmo sem as credenciais.

| Variável                                              | Para quê                                             |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `DATABASE_URL`                                        | Postgres do estado e da fila de jobs                 |
| `GITHUB_WEBHOOK_SECRET`                               | verifica a assinatura do webhook                     |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`                    | identidade do GitHub App                             |
| `GITHUB_APP_PRIVATE_KEY_PATH`                         | chave privada do App (arquivo em `.secrets/`)        |
| `ANTHROPIC_API_KEY` ou `CLAUDE_CODE_OAUTH_TOKEN`      | credencial do Claude Code                            |
| `FACTORY_CLAUDE_AUTH`                                 | `api-key` ou `subscription`, quando as duas existem  |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Vercel Sandbox, sem a validade de 12 horas do OIDC   |
| `VERCEL_OIDC_TOKEN`                                   | alternativa de desenvolvimento, de `vercel env pull` |

`.env.local` e `.secrets/` ficam fora do git, com modo 600.

## Operando

1. Suba o Postgres (`docker compose up -d`), aplique as migrations (`pnpm db:migrate`) e inicie o
   servidor (`pnpm build && pnpm start`). O worker de jobs roda no mesmo processo.
2. Exponha só o webhook e o health check com o Cloudflare Tunnel (README, "Exposição pública").
3. Ponha a label `factory` numa issue de um repositório onde o App está instalado.
4. Acompanhe os estágios:

   ```sql
   select stage, at, left(detail::text, 200) from stage_event where task_id = 1 order by id;
   select name, sha, passed, exit_code from evidence where task_id = 1;
   ```

5. Para testar sem esperar um webhook: `pnpm test:e2e` usa um agente roteirizado contra os serviços
   reais, e `FACTORY_LIVE=1 pnpm test:e2e -t "real agent"` usa o Claude Code de verdade (centavos).
   Para testar com a assinatura, acrescente `FACTORY_CLAUDE_AUTH=subscription`.

## Quando algo falha

| Sintoma                                           | Causa provável                                             | O que fazer                                                              |
| ------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| Task em `failed`, `failedAt: sandbox`, erro 402   | Armazenamento de snapshots da Vercel cheio                 | Apagar snapshots e sandboxes antigos; o adapter já cria sem persistência |
| `failedAt: sandbox`, "not installed on <repo>"    | O App não está instalado nesse repositório                 | Instalar o App                                                           |
| `failedAt: build`, "did not finish"               | O agente falhou, ou a cota da assinatura acabou            | Ler o resumo no detalhe; esperar a cota ou trocar para chave de API      |
| `failedAt: push`, "no change"                     | O agente não alterou nada                                  | Reescrever a issue com critérios mais claros                             |
| `failedAt: push`, "remote rejected"               | GitHub recusou o push (por exemplo, arquivo em `.github/`) | Ver os arquivos listados no erro                                         |
| `failedAt: verify`, "no pull request: ... failed" | Os checks falharam no commit enviado                       | Ler `evidence.output`; a branch continua enviada                         |
| `failedAt: verify`, "no checks are required"      | Lista de checks vazia                                      | Configurar os checks exigidos                                            |
| `failedAt: pr`                                    | O GitHub recusou o PR                                      | O check run já foi publicado; ver a mensagem de erro                     |
| "the job lease expired before the run finished"   | O worker parou de renovar o lock                           | Reiniciar o servidor e reenfileirar                                      |

## Limites conhecidos

- Uma task por issue. Repor a label não reexecuta.
- Um repositório de cada vez no sentido de operação: não há onboarding de repositórios.
- O servidor e o túnel rodam como processos da sessão de trabalho, sem supervisor.
- Não há pergunta ao humano, review independente, painel nem merge. Estão no M4 a M6.
- Só o Claude Code roda. O Codex depende do M3b.
- A sessão do Vercel Sandbox no plano Hobby termina em 45 minutos.
