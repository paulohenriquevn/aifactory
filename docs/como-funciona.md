# Como a fábrica funciona

Este documento descreve a fábrica como ela está hoje, com o Claude Code e com o Codex. Onde algo
ainda não existe, o texto diz. O plano e os marcos ficam em [PLAN.md](PLAN.md).

| Agente      | Estado em 2026-11-04                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | Funciona do webhook ao pull request, por chave de API ou por assinatura. Testado ao vivo nos dois modos.                                   |
| Codex       | Implementado. Instala, autentica pelo firewall e lê a parada por cota numa execução real. Falta uma execução que complete (cota da conta). |
| Outros      | Um agente novo é um arquivo que implementa `CodingHarness` e uma linha no registro. Nenhum outro está implementado.                        |

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
   agente construtor (Claude Code ou Codex) implementa a issue
        |-- precisa de uma decisão --> pergunta na issue, snapshot do sandbox, task em waiting
        |       (uma resposta de quem tem acesso de escrita retoma a mesma sessão, num sandbox restaurado)
        v
   a fábrica faz o commit e o push
        |
        v
   a fábrica roda os checks no commit enviado  --> tabela evidence
        |-- falharam --> volta ao mesmo agente, com a saída que falhou (até 3 tentativas)
        |-- passaram
        v
   revisor independente lê o diff, e a fábrica soma fatos do diff --> tabela review
        |-- pede mudanças --> volta ao mesmo agente, com os achados (até 3 tentativas)
        |-- aprova
        v
   check run "success" + pull request com "Closes #<n>"
        |
        v
   pré-release no GitHub (a entrega da fábrica)
        |
        v  (um humano pelo painel, ou um agente em modo auto)
   release: merge do PR preso ao SHA + versão final

(sem aprovação e sem tentativas: PR em rascunho + comentário na issue = handoff, e também uma pré-release)
```

O agente escreve código. Quem commita, envia, verifica e abre o PR é a fábrica. Uma declaração do
agente, como "todos os testes passam", nunca vira evidência.

## Os estágios de uma task

Cada estágio fica gravado em `stage_event`, na mesma transação que atualiza `task.stage`.

| Estágio    | O que acontece                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| `intake`   | O webhook criou a task. Uma issue tem no máximo uma task, mesmo que a label saia e volte.                   |
| `sandbox`  | Pede um token do GitHub App só para este repositório, lê a issue, cria o sandbox e clona o repositório.     |
| `build`    | O agente roda no sandbox, na branch `factory/<n>`, com o texto da issue como tarefa.                        |
| `push`     | Confere que houve mudança, faz o commit com a identidade do App e envia a branch (até três tentativas).     |
| `verify`   | Roda os checks exigidos (`npm test` por padrão) no commit enviado e grava cada resultado em `evidence`.     |
| `review`   | Um revisor independente lê o diff e dá um veredito, gravado em `review`. A fábrica soma fatos do diff.      |
| `waiting`  | O agente perguntou algo. A pergunta foi para a issue, o sandbox foi salvo e a task espera uma resposta.     |
| `pr`       | Se o portão abriu, cria o check run `aifactory/verify` e o pull request, ou devolve o que já estava aberto. |
| `done`     | Guarda o SHA, a URL do PR, a pré-release, o número de tentativas e o custo total (construtor e revisor).    |
| `released` | O PR foi mergeado e a release publicada, por um humano ou pelo veredito de um agente.                       |
| `handoff`  | Sem aprovação e sem tentativas: abriu um PR em rascunho e comentou na issue. Uma pessoa assume daqui.       |
| `failed`   | Qualquer falha. O detalhe traz `failedAt` (o estágio) e `error` (o motivo).                                 |

Depois de um retrabalho, a task volta a `build` e repete `push`, `verify` e `review`: o histórico mostra cada tentativa.

O job `run-task` não tenta de novo sozinho (`maxAttempts: 1`): repetir gastaria o orçamento do
agente na mesma issue. Uma task que falha fica em `failed` para uma pessoa olhar.

## Isolamento e segredos

A fábrica só roda um agente dentro de um sandbox com uma lista explícita de domínios de saída.
Lista vazia, `*` ou endereço IP fazem a execução ser recusada (`IsolationRefused`).

O sandbox é um microVM do Vercel Sandbox. Ele alcança apenas (a linha do agente depende de qual roda):

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

Um agente pode editar o próprio script de teste para sempre passar. A fábrica checa isso (ver
"Review independente e tentativas") e o revisor lê o diff.

## Review independente e tentativas

Um PR só abre com duas coisas: evidência verde para o SHA enviado **e** a aprovação de um revisor
que não escreveu o código.

**O revisor** é um agente (o mesmo registro do construtor) rodado numa sessão nova, sem acesso à
conversa do construtor. Ele recebe a issue e o comando `git diff <base>...HEAD`, é instruído a não
alterar nada e termina com um objeto JSON: `verdict` (`approve` ou `changes`), `summary` e
`findings`, cada um com `severity` (`blocker`, `major`, `minor`), `file` e `issue`. Tudo o que ele
escrever no checkout é descartado (`git reset --hard` e `git clean -fd` no SHA enviado).

O padrão é o revisor ser o próprio agente do construtor, numa sessão limpa. Isso é uma segunda
leitura, não uma segunda opinião. Para uma opinião de verdade, use outro agente:
`FACTORY_REVIEWER=codex`, ou o label `reviewer:codex` na issue. O sandbox recebe as regras de
firewall dos dois agentes, e dois agentes não podem assinar o mesmo domínio de formas diferentes.

**Leitura do veredito.** Uma resposta sem veredito, com uma palavra que não seja `approve` ou
`changes`, ou uma aprovação que lista um achado `blocker` ou `major`, vale como `invalid`: sem
aprovação. Quando o revisor se contradiz, a fábrica não escolhe a leitura mais gentil.

**Fatos do diff.** Duas coisas que um agente pode entortar e um revisor pode deixar passar são
checadas sem modelo e valem como achados que impedem a aprovação:

- o script `test` do `package.json` mudou entre a base e o commit (os checks passariam a rodar outra
  coisa), ou o diff toca `.github/`: achado `blocker`;
- um arquivo de teste foi apagado: achado `major`.

**Tentativas.** São no máximo 3, contadas juntas para checks e review.

| Situação                                            | O que acontece                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Checks falham, há tentativa e o agente sabe retomar | Volta à mesma sessão do construtor com a saída que falhou                                    |
| Checks falham, sem tentativa ou sem como retomar    | `failed` em `verify`, sem PR, com o número de tentativas                                     |
| Revisor pede mudanças, há tentativa                 | Volta à mesma sessão com os achados                                                          |
| Revisor pede mudanças na 3ª tentativa               | `handoff`: PR em rascunho (título `[needs a person]`) e comentário na issue com o que sobrou |
| Veredito inválido, ou revisor que falha             | `handoff` na hora: não há o que devolver ao construtor                                       |
| Retrabalho que não muda nada                        | `failed` em `push`: revisar o mesmo commit de novo não adiantaria                            |
| Cota do revisor esgotada                            | `failed` em `review` com `quota: true`                                                       |

O retomar usa `claude -p --resume <id>` ou `codex exec resume <id>`, na mesma sessão e no mesmo
sandbox. O retrabalho gera um novo commit (`<título>: address feedback (attempt n)`), e os checks
rodam de novo no SHA novo, com um novo check run. O PR traz o veredito do revisor e os achados que
restaram.

## Perguntas ao humano (`waiting`)

O agente não deve adivinhar quando falta uma decisão que só uma pessoa pode tomar. O prompt do
construtor combina um protocolo simples: deixar o repositório como está e terminar a resposta com uma
linha `QUESTION:` seguida de uma pergunta específica, com as opções que ele vê.

**Perguntar.** A fábrica lê essa linha e, nesta ordem:

1. salva o disco do sandbox num snapshot (o que também para o sandbox);
2. comenta na issue, como o App, com a pergunta e um marcador escondido
   (`<!-- aifactory:question -->`) para nunca ler o próprio comentário como resposta;
3. grava a pergunta em `question`, com o snapshot, o id da sessão do agente, o diretório do
   checkout, o commit base, o número da tentativa e o custo até ali;
4. põe a task em `waiting` e termina. Nada fica rodando, e nada se perde se o servidor reiniciar.

Se o provedor de sandbox não sabe salvar o disco, ou o agente não devolveu um id de sessão, a task
falha dizendo isso, em vez de esperar sem poder retomar. Se o comentário não puder ser postado, o
snapshot é apagado.

**Receber a resposta.** Um cron (`poll-answers`) roda a cada minuto, lê os comentários novos de cada
issue em espera e pega o que pessoas **com acesso de escrita** (`OWNER`, `MEMBER`, `COLLABORATOR`)
escreveram depois da pergunta, em ordem. Não contam: bots, a própria fábrica, um desconhecido, ou
qualquer coisa de antes da pergunta. Isso importa porque o texto da resposta vira instrução para um
agente com permissões desligadas, e numa issue pública qualquer pessoa pode comentar. A resposta e
quem a deu ficam gravadas, e o job `resume-task` entra na fila na mesma transação.

Escolhi sondar em vez de assinar o evento de comentário do GitHub porque isso exige outro evento no
App, e a sondagem também cobre uma resposta que chegou com o servidor fora do ar.

**Retomar.** `resume-task` pega a resposta uma única vez (duas execuções nunca retomam a mesma
pergunta), cria um sandbox a partir do snapshot, com as mesmas regras de rede e um token novo do
GitHub, apaga o snapshot e retoma a sessão do agente com a pergunta, a resposta e quem respondeu. O
checkout, a branch e a conversa do agente voltam como estavam. Daí em diante é o fluxo normal: commit,
checks, revisão. Uma pergunta não gasta uma das três tentativas, e uma pergunta feita durante um
retrabalho volta na mesma tentativa.

**Sem resposta.** Depois de 7 dias, que é quanto o snapshot vive, a task falha com `failedAt: waiting`
e o snapshot é apagado.

Cada snapshot ocupa cerca de 800 MB, e o plano Hobby da Vercel limita o armazenamento. Muitas
perguntas abertas ao mesmo tempo esgotam esse limite.

## Entrega: pré-release e release

A fábrica entrega por pré-release, e a release é a promoção dessa entrega. São dois passos com donos
diferentes de propósito.

**Pré-release.** É feita pela fábrica, sempre, sem pedir a ninguém: uma tag `pre/<issue>-<sha7>` sobre o
commit entregue, marcada como pré-release no GitHub. Ela não mexe na branch padrão, então não há o que
pedir licença. Nas notas vão os checks que rodaram naquele commit, o veredito do review, as tentativas, o
custo e o que o agente disse. Cada commit entregue tem a sua tag, e pedir duas vezes a mesma devolve a
primeira. A fábrica a faz para todo commit com checks verdes que chegou a um PR, inclusive um trabalho
entregue a uma pessoa (as notas dizem que o revisor não aprovou). Checks vermelhos não geram entrega,
porque não há o que entregar. Se o GitHub recusar a pré-release, a task não falha: o motivo fica no
estágio `done`.

**Release.** É a promoção: o PR é mergeado e uma release de verdade (não pré-release) é publicada, com a
versão seguinte à da última release (`v0.1.0` na primeira, e `patch`, `minor` ou `major` escolhe o que
sobe). Quem a faz:

- um humano, pelo painel. O clique vale como a aprovação, e o painel pede confirmação;
- um agente, quando o modo permite. `FACTORY_RELEASE_MODE` é `manual` (padrão: só humanos), `trial` (a
  fábrica registra que "um agente teria liberado", sem liberar) ou `auto` (a fábrica libera um commit com
  checks verdes e review aprovado). Trabalho entregue a uma pessoa nunca é liberado sozinho.
  No modo `auto` a liberação não espera aprovação no painel (decisão do dono): valem só as recusas
  abaixo.

`release()` recusa, dizendo por quê, quando:

- a task não está concluída, ou já foi liberada, ou outra liberação está em curso;
- o commit não tem pré-release ou os checks não estão verdes;
- o PR não existe, está fechado, já foi mergeado, é um rascunho, ou **andou** para outro commit que não
  foi entregue.

O merge é fixado ao SHA entregue: se um push cair entre olhar e mergear, o GitHub recusa o merge em vez de
juntar o que ninguém viu, e a task volta a `done`. Se o merge acontece mas a release não pôde ser criada,
a task fica `released` com o erro registrado, porque o merge não se desfaz.

Depois do release, o vigia olha a `main` (a próxima seção).

## O vigia da `main`

Depois de um release, o merge está na branch padrão, e a fábrica continua olhando para ele. Cada release
registra uma vigília sobre o commit de merge, e um cron (`watch-main`) lê, a cada minuto, os check runs e
os statuses desse commit:

| O que ele vê                                                                                       | O que acontece                                                          |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Um check falhou (`failure`, `timed_out`, `action_required`, `startup_failure`, ou status com erro) | Vermelho na hora, sem esperar os outros checks: abre o PR de revert.    |
| Tudo terminou bem                                                                                  | A vigília termina `green`.                                              |
| Algo ainda roda, ou nada reportou ainda                                                            | Continua olhando.                                                       |
| Passou a janela de 60 minutos sem veredito                                                         | Termina `silent`, dizendo se nenhum check reportou ou se ainda rodavam. |

Uma run cancelada ou ignorada não conta como falha. A falta de qualquer check não é verde: ninguém disse
que o commit está bom, então a vigília espera e, no fim, diz que não houve sinal.

**O PR de revert.** A fábrica o abre com a mutação `revertPullRequest` do GitHub, que desfaz o PR mergeado,
e o corpo diz o que quebrou (os checks que falharam, o commit, o release). **Ela só o abre. Nenhum caminho do
código o mergeia**, e um teste falha se o vigia chamar um merge. Quem decide é uma pessoa, porque um revert
também pode estar errado, por exemplo quando commits posteriores se apoiaram no que ele desfaz.

A vigília passa por `reverting` enquanto o PR é aberto, e só então vira `red`. Assim a caixa de entrada não
diz "nenhum revert foi aberto" no meio do caminho. Se o GitHub recusar o revert (por conflito, digamos), a
vigília fica `red` sem link, com o motivo, e o painel diz que não há revert.

No painel, a task liberada ganha a seção "Default branch after the release", com o estado da vigília, o link
do revert e o botão "I dealt with it", que tira o caso da caixa de entrada sem mexer em nada no GitHub. Uma
`main` vermelha aparece na caixa de entrada e no cartão da task.

## Saúde da própria fábrica

**Custo por execução.** Toda execução de um agente (um build, um retrabalho, uma retomada depois de uma
resposta, um review) é uma linha com o agente, o papel, a tentativa, o custo, o tempo e o resultado. Uma
execução que não voltou (o sandbox morreu) ou que bateu na cota fica registrada como tal, e um agente
que não informa custo (o Codex) fica com o custo vazio, não zero. O detalhe de cada task mostra as suas
execuções, e a página Health mostra o custo nas últimas 24 horas, nos últimos 7 dias e no total, e por
agente e papel, com o tempo médio e quantas falharam ou bateram na cota.

**O supervisor.** Um cron confere a fábrica a cada 5 minutos e abre achados tipados. Ele só reporta; uma
pessoa resolve cada um pelo painel.

| Achado                   | O que é                                                                                  | O que o painel oferece |
| ------------------------ | ---------------------------------------------------------------------------------------- | ---------------------- |
| `stalled` run            | Uma task num estágio de trabalho sem evento há mais de 45 minutos, mais que qualquer run | Começar de novo        |
| `orphaned` queued_run    | Uma task na fila e nenhum job para rodá-la (ou o job falhou)                             | Começar de novo        |
| `orphaned` answer_resume | Uma pergunta respondida há mais de 10 minutos e nenhum job para retomá-la                | Retomar de novo        |
| `orphaned` revert        | A `main` ficou vermelha e o revert nunca foi confirmado aberto                           | Mostrar como vermelha  |
| `orphaned` snapshot      | Um snapshot que nenhuma pergunta em espera usa (só custa armazenamento)                  | Apagar o snapshot      |

Um achado fica aberto enquanto for verdade e se resolve sozinho quando deixa de ser, ou quando uma pessoa
age. Se voltar, recomeça com um novo "visto pela primeira vez". Uma checagem que não pôde rodar (a lista de
snapshots do provedor, a tabela de jobs) não resolve os achados dela: não ver um problema não é o problema
ter sumido. "Começar de novo" apaga a branch e recomeça do zero, e o painel pede confirmação, porque uma run
que parecia parada pode, raramente, ainda estar viva.

## Qualidade do código

Três gates rodam no job `quality` do CI, ao lado do `check`. Localmente: `pnpm quality`, ou cada um
(`pnpm coverage`, `pnpm crap`, `pnpm dup`, `pnpm mutation`).

- **CRAP.** Para cada função, `complexidade² × (1 − cobertura)³ + complexidade`: uma função complicada que
  os testes não alcançam é o código mais arriscado, e um número diz o quanto. A complexidade é a ciclomática
  (ramos, laços, `catch`, ternários, `&&`, `||`, `??`), pela API do TypeScript, e a cobertura é a real, de
  `pnpm coverage`. Nenhuma função nova pode passar de 30, e as que já passassem estariam em
  `quality/crap-baseline.json` e só poderiam diminuir. Hoje não há dívida: nenhuma função passa de 30 e o baseline está vazio. Se algum
  dia uma função entrar nele, só poderá diminuir, e `node scripts/crap.mjs --update` trava cada ganho.
- **Duplicação.** Menos de 1% de código copiado (`jscpd`; hoje 0,15%). Os testes ficam de fora, porque
  repetem por natureza.
- **Mutação.** O Stryker muda a lógica de decisão (o portão de evidência, o veredito do review, as guardas do
  diff, a classificação da `main`, a leitura da resposta, as versões, as notas e a formatação do painel) e
  confere se algum teste falha. A nota mínima é 90; hoje é 97. Textos (literais de string) ficam de fora, para
  o gate cobrar lógica e não redação. Só os testes de unidade desses módulos rodam por mutante, sem banco.

## O painel

Uma interface local para ver e conduzir a fábrica. Abre em `http://localhost:3000` e mostra, ao vivo:

- O quadro: uma coluna por situação (na fila, trabalhando, esperando você, pull request, precisa de
  uma pessoa), com o custo e o número de tentativas de cada task.
- A caixa de entrada: só o que espera uma pessoa, do mais antigo ao mais novo. É uma pergunta do
  agente, um PR que ninguém aprovou, um trabalho entregue depois de três tentativas ou uma execução
  que falhou (com "sem cota" dito como tal).
- O detalhe da task: a linha do tempo de estágios, a evidência (comando, SHA, código de saída e a
  saída), os reviews com os achados, as perguntas e respostas e as decisões tomadas.

**Tempo real.** O servidor manda um evento (SSE, `/api/panel/stream`) a cada mudança de estágio, e a
página recarrega só o que mudou. Um relógio lento cobre o que o evento não traz, como o custo que cresce
enquanto o agente trabalha, e uma conexão que caiu.

**Ações.** Todas passam pelo servidor, que confere o estágio da task de novo, então uma página velha não
consegue fazer o que a task já não permite.

| Ação           | Quando                          | O que faz                                                                                                             |
| -------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Aprovar        | task com PR (`done`, `handoff`) | Grava a aprovação **presa ao commit** em que o PR está. Se a branch andar, a aprovação não cobre o commit novo.       |
| Pedir mudanças | task com PR, com um texto       | Uma nova execução parte da branch que o agente já enviou, com o texto no prompt, e passa de novo por checks e review. |
| Tentar de novo | task `failed` ou `handoff`      | Apaga a branch (o que fecha o PR) e recomeça do zero.                                                                 |

Se o agente, ao receber um pedido de mudança, concluir que não há o que mudar (o teste já existia, por
exemplo), a task volta a `done` e a resposta dele vira um comentário na issue, em vez de falhar.

Aprovar não faz merge. Quem mergeia é o Release.

**Quem entra.** O painel tem um dono, que entra com o token de `FACTORY_PANEL_TOKEN`. A sessão é um
cookie criptografado com `FACTORY_PANEL_SECRET` (os dois com pelo menos 32 caracteres, por exemplo
`openssl rand -base64 36`). Cinco tokens errados do mesmo cliente bloqueiam esse cliente por uma hora.
Sem token e segredo configurados, o painel recusa todo mundo. As rotas `/api/panel/*` só respondem ao
dono, e as que mudam algo exigem o cabeçalho `X-Theo-Action: 1` (a proteção contra CSRF do TheoKit).

**Onde ele aparece.** Só nesta máquina. O servidor escuta em `127.0.0.1` (`HOST=127.0.0.1`), e o
Cloudflare Tunnel só deixa passar `/api/webhooks/github` e `/api/health`, então o painel não é
alcançável pela internet. Expô-lo exigiria mudar essa regra do túnel, e isso só deve acontecer com o
login já atrás de algo mais forte que um token (por exemplo, o Cloudflare Access).

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

Com as duas definidas, vale a assinatura. `FACTORY_CLAUDE_AUTH=api-key|subscription` escolhe o contrário. Se a
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

**Estado:** completa uma issue de ponta a ponta, como construtor e como revisor (verificado em
2026-11-04, com revisão cruzada com o Claude Code nos dois sentidos).

O que foi verificado numa execução real da fábrica (2026-11-04), com saída apenas para
`github.com`, `registry.npmjs.org` e `chatgpt.com`:

- O sandbox instala `@openai/codex@0.166.0` por npm (versão fixa, para uma nova release não mudar o
  comportamento de uma execução).
- Recebe um `auth.json` de placeholder: as claims que o Codex lê (plano, conta), tokens com a
  assinatura trocada e um `refresh_token` falso. O token real nunca entra.
- O firewall injeta `Authorization: Bearer` com o access token real, e o servidor da OpenAI
  respondeu autenticado.
- A resposta de limite de uso foi lida como parada por cota: a task terminou em `failed` com
  `quota: true` e `resetsAt: "Nov 5th, 2026 11:48 AM"` no detalhe, em vez de um erro genérico.
- A conexão por WebSocket falha com "Attack attempt detected", porque o cabeçalho não é injetado no
  upgrade, e o Codex cai para HTTPS depois de cinco tentativas. Isso soma alguns segundos por
  execução. A versão 0.166 não tem chave de configuração conhecida para desligar o WebSocket.

### Como o harness funciona

1. `egress()` lê o login no host e devolve a regra de firewall: `api.openai.com` com a chave de API,
   ou `chatgpt.com` com o access token da assinatura.
2. `prepare()` instala o Codex no sandbox e grava o `auth.json` de placeholder (assinatura) ou nada
   (chave de API, que vai como `OPENAI_API_KEY=placeholder-not-a-secret`).
3. `run()` executa `codex exec --json --dangerously-bypass-approvals-and-sandbox -` com o prompt
   lido de um arquivo. O sandbox do próprio Codex fica desligado porque o microVM é a fronteira.
4. A saída é uma linha de JSON por evento. A fábrica guarda o `thread_id` (para `resume`), a última
   mensagem do agente como resumo e distingue falha comum de parada por cota.

O Codex não informa custo em dólar, então `costUsd` fica vazio.

### Credencial e login dedicado

| Modo           | Variável                      | Como a chamada é assinada                   |
| -------------- | ----------------------------- | ------------------------------------------- |
| `api-key`      | `OPENAI_API_KEY`              | `Authorization: Bearer` em `api.openai.com` |
| `subscription` | login em `FACTORY_CODEX_HOME` | `Authorization: Bearer` em `chatgpt.com`    |

Com as duas, vale a chave; `FACTORY_CODEX_AUTH=api-key|subscription` escolhe. O login da assinatura
fica em `~/.codex-factory-1` por padrão:

```bash
CODEX_HOME=~/.codex-factory-1 codex login --device-auth
```

O `auth.json` do Codex tem um token de renovação que rotaciona. Se o Codex do uso diário e a
fábrica compartilharem o mesmo login, o primeiro que renovar invalida o outro, por isso a fábrica
tem um login só dela. O access token dura 10 dias. A fábrica o renova no host quando faltam menos
de 2 dias, e grava o token novo no mesmo arquivo. Se a renovação for recusada, a task diz como
fazer o login de novo. Cada execução simultânea do Codex por assinatura precisa do seu login
(`~/.codex-factory-2` e assim por diante); o Claude por token não tem essa restrição. A renovação
foi coberta por teste de unidade e exercitada contra a OpenAI em 2026-11-04. A OpenAI recomenda não
usar login de assinatura em repositório público.

## Escolhendo o agente

O agente de uma task vem, nesta ordem, de:

1. um label `harness:<nome>` na issue (`harness:codex`, `harness:claude-code`);
2. `FACTORY_HARNESS`;
3. o padrão, `claude-code`.

O revisor segue a mesma regra com `reviewer:<nome>` e `FACTORY_REVIEWER`; sem nenhum dos dois, é o agente
do construtor. Dois labels de agentes diferentes, ou um nome desconhecido, fazem a task falhar no estágio
`sandbox`, antes de criar o sandbox: rodar o agente errado em silêncio custaria dinheiro. Cada agente
só precisa da sua credencial quando uma task o pede.

## Cota esgotada

Quando o agente informa que o limite da conta acabou (Claude: "limit reached", Codex: "usage
limit"), a task termina em `failed` com `quota: true` e, quando a mensagem traz, `resetsAt`. Nada é
enviado e nenhum PR abre. O motivo fica claro no detalhe do estágio, e a task pode ser repetida
depois do horário. Tratar isso como uma espera que retoma sozinha entra com o `waiting` do M4.

## O contrato para outros agentes

Um agente é um arquivo que implementa `CodingHarness` (`src/server/factory/harness.ts`) e uma linha
em `harness-registry.ts`:

- `name`;
- `egress()`: as regras de firewall que assinam as chamadas do agente. É o único lugar onde a
  credencial é lida;
- `prepare(backend)` (opcional): instala e configura o agente num sandbox novo;
- `run(backend, { prompt, cwd, timeoutMs })`, que devolve `{ ok, summary, costUsd?, sessionId?, quota? }`;
- `resume(backend, sessionId, input)` (opcional): continua uma conversa. O id é validado como UUID
  antes de entrar numa linha de shell.

O orquestrador (`runTask`) não conhece nenhum agente pelo nome.

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
   Com as duas credenciais no `.env.local`, o teste usa a assinatura; para testar a chave, acrescente `FACTORY_CLAUDE_AUTH=api-key`.

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

- Uma task por issue. Repor a label não reexecuta, nem depois de uma task que falhou por falta de resposta.
- Um repositório de cada vez no sentido de operação: não há onboarding de repositórios.
- O servidor e o túnel rodam como processos da sessão de trabalho, sem supervisor.
- O vigia só olha o commit de merge de cada release, não a `main` inteira.
- O painel é local e tem um dono só, com um token.
- A resposta é lida por sondagem a cada minuto, não por evento.
- O supervisor só reporta; não corrige nada sozinho.
- Uma aprovação do revisor não é prova de que o código está certo. A evidência continua sendo os checks.
- A sessão do Vercel Sandbox no plano Hobby termina em 45 minutos.
