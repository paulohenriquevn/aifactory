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
   merge do PR em workspace, preso ao SHA verificado (a fábrica, sem pedir a ninguém;
   se workspace exige checks, o auto-merge do GitHub, depois do CI do repositório)
        |
        v
   develop avança até o commit integrado + pré-release no GitHub
        |
        v  (um humano pelo painel, ou um agente em modo auto)
   release: PR develop -> main mergeado + versão final

(sem aprovação e sem tentativas: PR em rascunho + comentário na issue = handoff, e também uma pré-release)
```

O agente escreve código. Quem commita, envia, verifica e abre o PR é a fábrica. Uma declaração do
agente, como "todos os testes passam", nunca vira evidência.

## Os estágios de uma task

Cada estágio fica gravado em `stage_event`, na mesma transação que atualiza `task.stage`.

| Estágio     | O que acontece                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `intake`    | O webhook criou a task. Uma issue tem no máximo uma task, mesmo que a label saia e volte.                         |
| `sandbox`   | Pede um token do GitHub App só para este repositório, lê a issue, cria o sandbox e clona o repositório.           |
| `plan`      | Numa task nova, o agente lê o código e escreve um plano, sem mudar nada. O plano é gravado em `change_plan`.      |
| `build`     | O agente roda no sandbox, na branch `factory/<n>`, com o texto da issue como tarefa.                              |
| `push`      | Confere que houve mudança, faz o commit com a identidade do App e envia a branch (até três tentativas).           |
| `verify`    | Roda os checks exigidos (`npm test` por padrão) no commit enviado e grava cada resultado em `evidence`.           |
| `review`    | Um revisor independente lê o diff e dá um veredito, gravado em `review`. A fábrica soma fatos do diff.            |
| `waiting`   | O agente perguntou algo. A pergunta foi para a issue, o sandbox foi salvo e a task espera uma resposta.           |
| `pr`        | Se o portão abriu, cria o check run `aifactory/verify`, abre o PR contra `workspace`, mergeia e avança `develop`. |
| `done`      | Guarda o SHA, a URL do PR, a pré-release, o número de tentativas e o custo total (construtor e revisor).          |
| `released`  | `develop` foi promovida para `main` e a release publicada, por um humano ou pelo veredito de um agente.           |
| `handoff`   | Sem aprovação e sem tentativas: abriu um PR em rascunho e comentou na issue. Uma pessoa assume daqui.             |
| `failed`    | Qualquer falha. O detalhe traz `failedAt` (o estágio) e `error` (o motivo).                                       |
| `cancelled` | Uma run interrompida porque a issue deixou de pedir o trabalho. Nenhum caminho entra nele ainda.                  |

### O que cada evento faz em cada estágio

`src/server/factory/transitions.ts` declara, para cada par de estágio e evento, o que acontece: a ação que
vale, `ignored` com o motivo ou `refused` com o motivo. É uma função pura, sem banco e sem GitHub. Um teste
percorre todos os estágios e todos os eventos e falha para um par sem resultado declarado.

| Grupo de eventos | Eventos                                                                           | Quem lê a tabela                                         |
| ---------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Painel           | `approve`, `request_changes`, `retry`, `retry_from_finding`, `resolve`, `release` | `panel/actions.ts` e `release()` em `factory/deliver.ts` |
| Automáticos      | `retry_due`, `conflict_rerun`, `send_back_after_ci`                               | `retryAutomatically` e `sendBackAutomatically`           |
| Automáticos      | `hand_over`, `integrate`                                                          | Ninguém ainda: a run decide onde está                    |
| Webhook          | `issue_labeled` e um evento por código de intenção de `decideIngress`             | Ninguém ainda: a entrega só é gravada                    |

Os eventos que ninguém lê estão em `NOT_WIRED`. A tabela diz o que eles devem fazer quando algo agir sobre
eles: um comentário numa task em `waiting` responde à pergunta; um comentário ou review de alguém confiável
no PR aberto da fábrica devolve o trabalho, e num trabalho já integrado abre uma issue de continuação; um
check concluído numa task que espera o CI reavalia a integração; tirar a label ou fechar a issue cancela a
task que está na fila, trabalhando, esperando resposta ou falhada; repor a label numa task `failed`,
`handoff` ou `cancelled` começa de novo.

O limite de execuções automáticas seguidas (`AUTOMATIC_RETRIES`, três) também mora nesse arquivo, e é o
mesmo para falha de ambiente, conflito com a base e check exigido que falhou.

### O que cada entrega do webhook significa

`decideIngress` (`src/server/ingest/decide.ts`) lê o evento e o payload, validado com Zod, e devolve uma
de três coisas. A entrega fica em `ingress` com o resultado, um código e o motivo.

| Resultado em `ingress.outcome` | Quando                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `task_created`, `task_exists`  | `issues` com a label `factory` posta, ou aberta já com ela.                          |
| `routed`                       | Um dos eventos da tabela abaixo. Não cria task nem job.                              |
| `ignored`                      | Todo o resto, com o código de sempre (`event_not_issues`, `action_not_relevant`...). |

| Evento e ação                         | Código                                                    | O que a intenção leva                             |
| ------------------------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| `issue_comment.created`               | `issue_comment_created` ou `pull_request_comment_created` | número da issue ou do PR, id do comentário, autor |
| `pull_request_review.submitted`       | `pull_request_review_submitted`                           | número do PR, id do review, head SHA, autor       |
| `pull_request_review_comment.created` | `pull_request_review_comment_created`                     | número do PR, id do comentário, head SHA, autor   |
| `check_suite.completed`               | `check_suite_completed`                                   | head SHA, conclusão                               |
| `check_run.completed`                 | `check_run_completed`                                     | head SHA, nome do check, conclusão                |
| `issues.unlabeled` (label `factory`)  | `issue_unlabeled`                                         | número da issue, quem tirou a label               |
| `issues.closed`, `issues.reopened`    | `issue_closed`, `issue_reopened`                          | número da issue, quem fechou ou reabriu           |

Toda intenção leva o repositório. O autor de um comentário ou review vem com o login e a associação que
o GitHub informa (`OWNER`, `MEMBER`, `NONE`...). Um payload que não bate com o schema do seu evento fica
como `payload_invalid`. Por enquanto a fábrica só registra a intenção: nada lê uma entrega `routed`, a
resposta a uma pergunta continua vindo da sondagem e a integração depois do CI continua vindo do cron.
A App só recebe os eventos que assina, e a página Setup tem uma linha que lê as assinaturas (`GET /app`)
e diz quais faltam.

Depois de um retrabalho, a task volta a `build` e repete `push`, `verify` e `review`: o histórico mostra cada tentativa.

O job `run-task` não tenta de novo sozinho (`maxAttempts: 1`): repetir gastaria o orçamento do
agente na mesma issue. Uma task que falha pelo próprio trabalho fica em `failed` para uma pessoa olhar.

A falha que passa sozinha volta a rodar pelo cron `retry-due`, a cada 5 minutos e no máximo 3 tasks por
passada, a que espera há mais tempo primeiro:

- Parada por cota: roda 1 minuto depois do instante em que a cota volta. A fábrica grava esse instante
  (`resumesAt`, em UTC) no momento da falha, a partir do horário que o agente escreveu e do fuso que ele
  usou; sem horário legível, espera 1 hora. Repete quantas vezes for preciso, porque esperar é o que
  resolve.
- Falha de ambiente (rede, GitHub, sandbox, reinício, provedor de sandbox que recusa por cobrança, como
  o `403: team is blocked: spend_limit` da E2B): espera 5, 10 e 20 minutos, e para depois da terceira vez.
  Aí vai para "Needs a person".
- Agente que usou todo o tempo da execução (25 minutos) não volta sozinho, mesmo que o texto diga "timed
  out": nada em volta falhou, e uma nova execução pararia no mesmo ponto gastando a mesma cota. Vai para
  "Needs a person", que divide a issue ou dá mais tempo. O timeout de um comando do ambiente (clone,
  instalação) continua sendo falha de ambiente.

- PR que o GitHub recusou por conflito com a base (`Pull Request has merge conflicts`): outra task mexeu
  nos mesmos arquivos e entrou antes. A task fica `done` sem commit integrado, e a mesma passada a
  recomeça sobre a base nova, como faria o "Retry", com o mesmo limite de 3 vezes e até 3 tasks por
  passada. Merge recusado por outro motivo continua esperando uma pessoa.

O reinício automático não grava uma decisão em nome de ninguém: o evento `intake` leva
`automatic: true`, e um "Retry" de uma pessoa zera a contagem. O cartão diz quando a task roda de novo, e
as tentativas contam só a execução atual.

## Onde os sandboxes rodam

Por padrão, num Vercel Sandbox. `FACTORY_SANDBOX=docker` os roda como containers nesta máquina, para quando
o plano da Vercel não tem mais capacidade (o plano Hobby devolve `402 usage limit exceeded` até o mês virar,
e isso aconteceu em 2026-11-05 depois de 25 execuções) ou para manter o trabalho fora da nuvem.

O modelo de segurança é o mesmo, com outras peças. Cada sandbox ganha uma rede privada **sem saída** e um
container de proxy (mitmproxy) que é a única coisa nessa rede que alcança a internet. O proxy aplica a lista
de domínios da execução e anexa os cabeçalhos de cada regra, então a credencial nunca existe dentro do
sandbox: ela fica num arquivo do host, montado só no proxy. O sandbox confia na CA do proxy por um bundle
que todas as ferramentas leem (git, curl, Node, pnpm, Codex). O container roda como usuário comum, sem
nenhuma capability, com limite de memória (`FACTORY_SANDBOX_MEMORY`, 5g), CPU (`FACTORY_SANDBOX_CPUS`, 3) e
processos. Um sandbox parado remove o proxy, a rede e as regras, e um novo sandbox varre o que um processo
morto deixou para trás.

O que muda em relação à Vercel, sem esconder:

- o isolamento é de container, que divide o kernel do host, e não de microVM. É a mesma máquina onde estão
  os segredos da fábrica, mas o container não monta nada do host;
- não salva o disco para retomar depois, então uma execução que faz pergunta falha. Use com repositórios
  em que o agente nunca pergunta (`askQuestions` desligado);
- `bwrap` não funciona lá dentro, porque liberar isso exigiria `SYS_ADMIN`, que anula o isolamento. Testes que
  dependem de `bwrap` ficam fora do gate desses repositórios.

A imagem (`ops/sandbox`) é construída na primeira vez, e o teste `docker-sandbox.e2e.test.ts` roda
containers de verdade: a lista de domínios, a injeção do cabeçalho (conferida por um servidor local que
ecoa o que recebeu), o HTTPS pelo proxy e a limpeza.

### No E2B

`FACTORY_SANDBOX=e2b` roda cada sandbox no E2B, com `E2B_API_KEY` no `.env.local`. A imagem é a mesma
do Docker (`ops/sandbox/Dockerfile`), publicada como template `aifactory-sandbox:<versão>` por
`node --env-file=.env.local scripts/build-e2b-template.mts`. Quem muda o Dockerfile roda o script de novo
e sobe a versão em `E2B_TEMPLATE` (`src/server/factory/e2b-template.ts`).

O E2B aplica a lista de domínios (`allowOut`, com todo o resto negado) e anexa os cabeçalhos de cada regra
no proxy de saída dele, fora do sandbox. A renovação do token do GitHub troca as regras com o sandbox
rodando (`updateNetwork`). O E2B não aplica as linhas `ENV` do Dockerfile, então o adapter passa as
variáveis na criação, entre elas `NODE_EXTRA_CA_CERTS`, sem a qual o Node recusa o certificado do proxy.

O plano gratuito para um sandbox depois de uma hora, e a execução se planeja para isso: cada passe do
agente cabe na sessão em que começa, e o primeiro fica com 35 minutos (60 menos 15 dos checks e 10 da
revisão). Quando um retrabalho não cabe no que sobra da sessão, mas cabe nos 90 minutos da execução, o
`Run` salva o disco num snapshot, restaura numa sessão nova com as mesmas regras de rede e o mesmo token
renovado, apaga o snapshot e continua. O histórico da task mostra a sessão nova no estágio `sandbox`. O
limite de 90 minutos, as tentativas e o custo continuam valendo para a execução inteira, e um provedor que
não sabe salvar o disco recusa o passe como antes. `E2B_MAX_SESSION_MS` aumenta o limite num plano que
permita mais. Um sandbox restaurado de um snapshot apaga
o snapshot quando para, porque o E2B recusa apagar um snapshot em uso. O teste
`e2b-sandbox.e2e.test.ts` roda contra o E2B de verdade (`npm run test:e2e`).

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
- Prazos: sandbox 50 minutos, agente 25 minutos, cada check 10 minutos. O job renova o lock a cada
  40 segundos (`extendLease`), então um worker que morre libera a task em minutos.
- Um agente que já entregou o resultado do turno e foi morto pelo prazo conta como terminado. Um comando
  que ele deixou em segundo plano mantém o Claude Code vivo depois da última palavra, e antes a fábrica
  descartava esse trabalho pronto (a task 287 terminou às 11:25 e foi morta às 11:32). Os checks e o
  revisor continuam julgando o que ele fez.
- O sandbox sempre é parado, inclusive quando o run falha ou o lock expira.

## Evidência e portão

Depois do push, a fábrica confere que o checkout é exatamente o commit enviado e que a árvore está
limpa, e apaga o que o git ignora (`git clean -fdx`): os checks julgam o commit, não o `node_modules` ou o
build que o agente deixou. Em seguida roda cada check com `cd <repo> && <comando>` e grava na tabela `evidence`: nome,
comando, SHA, código de saída real, fim da saída e duração. Um check que falha sem estourar o tempo roda
mais uma vez no mesmo commit, porque um teste sensível a carga que passa na segunda vez não é culpa da
mudança e custaria uma tentativa ao agente. As duas execuções ficam na evidência, e o portão lê a última.
O check que estoura o tempo não roda de novo. Ao voltar para o construtor, só vão os checks cuja última
execução falhou.

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

**Fatos do diff.** Algumas coisas que um agente pode entortar e um revisor pode deixar passar são
checadas sem modelo e valem como achados que impedem a aprovação:

- o script `test` do `package.json` mudou entre a base e o commit (os checks passariam a rodar outra
  coisa), ou o diff toca `.github/`: achado `blocker`;
- um arquivo de teste foi apagado: achado `major`.

- numa issue com label `bug`, um teste que já existia na base perdeu casos ou asserções, ou ganhou um
  `.skip`, `.only`, `.todo`, `xit`, `@pytest.mark.skip` ou `t.Skip`: achado `blocker`. Fora de uma
  correção de bug, o mesmo achado é `major`. Quando o texto da issue cita o arquivo ou o caso removido,
  ele vira `minor` e a decisão fica com o revisor, porque a remoção pode ser o que a issue pede. Um caso
  que muda de arquivo com o mesmo nome não conta como perda. Um caso renomeado no próprio arquivo também
  não: cada nome novo no arquivo, que nenhum arquivo do diff perdeu, cobre um nome que o arquivo perdeu.
  Se o arquivo não perde asserção, a renomeação vira só um achado `minor` para o revisor conferir o título
  novo. Dois casos que saem e um que entra contam como um caso removido.

**Plano antes do código.** Numa task nova, antes de editar, o construtor recebe a issue e as regras do
build e escreve um plano em JSON: os arquivos que vai mudar e por quê, a ordem, os riscos, a prova
(testes ou comandos) e o que fica fora do escopo. Nesse turno ele não muda arquivo nem faz pergunta; o
que ele mudar mesmo assim é descartado. Um plano ilegível ganha uma segunda chance, e sem plano a task
falha em `plan`. O turno tem teto de 15 minutos. O build continua a mesma sessão, com a instrução de
seguir o plano e de explicar no resumo final qualquer arquivo fora dele. O plano vai no corpo do PR, na
seção "Plan" da task no painel e no prompt do revisor, junto com a lista dos arquivos do diff que o plano
não cita (calculada sem modelo; lockfiles ficam de fora). O revisor trata cada um como achado, salvo
motivo que a issue sustente, e a fábrica registra cada um como achado `minor`. Quando uma checagem da
fábrica falhou num commit anterior da task e passa no commit em revisão, o prompt do revisor diz qual
checagem, a linha do erro e os arquivos adicionados entre os dois commits: arquivo que a checagem exigiu
(um changeset para um pacote publicado, por exemplo) é legítimo, e esses arquivos não entram na lista de fora do
plano. A exceção é o changeset vazio, que não nomeia pacote nenhum: nenhuma checagem pede um, então ele continua
na lista de fora do plano. Uma task retomada
(resposta a uma pergunta, mudanças pedidas, checks obrigatórios que devolveram o trabalho) usa o último
plano gravado. Não há aprovação humana do plano: quem confere é o revisor, contra o diff
([ADR 0009](adr/0009-plano-antes-do-codigo-e-testes-que-nao-enfraquecem.md)).

**Tentativas.** São no máximo 3, contadas juntas para checks e review.

| Situação                                            | O que acontece                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Checks falham, há tentativa e o agente sabe retomar | Volta à mesma sessão do construtor com a saída que falhou                                    |
| Checks falham, sem tentativa ou sem como retomar    | `failed` em `verify`, sem PR, com o número de tentativas                                     |
| Revisor pede mudanças, há tentativa                 | Volta à mesma sessão com os achados                                                          |
| Revisor pede mudanças na 3ª tentativa               | `handoff`: PR em rascunho (título `[needs a person]`) e comentário na issue com o que sobrou |
| Veredito inválido, ou revisor que falha             | `handoff` na hora: não há o que devolver ao construtor                                       |
| Retrabalho que não muda nada                        | `failed` em `push`: revisar o mesmo commit de novo não adiantaria                            |
| Primeira passada sem mudança, checks e revisor ok   | `done` sem PR: a issue é fechada com a evidência                                             |
| Primeira passada sem mudança, algo não confirma     | `failed` em `verify` ou `review`, com o motivo e o que o construtor disse                    |
| Cota do revisor esgotada                            | `failed` em `review` com `quota: true`                                                       |

**Issue que o código já resolve.** Quando o construtor não muda nada numa issue nova e diz que o código já
faz o que ela pede, a fábrica trata isso como uma alegação. Os checks rodam no commit de onde o run partiu
(sem check run no GitHub, porque o commit não é da fábrica), e o revisor recebe a issue e o que o
construtor disse, com a instrução de conferir no código e nos testes, sem confiar no texto. Se os dois
confirmam, a fábrica comenta na issue o commit, os checks que passaram, a conclusão do revisor e o que o
construtor encontrou, fecha a issue como concluída e marca a task `done`, sem PR (`resolved_sha` na
task). No painel ela aparece na coluna "Already resolved", e não em Delivered, que guarda só o que
espera uma release; também não entra na caixa de entrada. Ela vai para `released` quando a branch de
release passa a conter o commit em que foi resolvida (ver "Task resolvida sem mudança" em Release). Se os checks falham, a issue fica aberta e a task vai para uma pessoa, com o motivo. Se o revisor aponta algo
faltando e o construtor tem sessão para retomar, a revisão volta uma vez à sessão dele, com a instrução de
fazer a mudança construindo sobre o que existe (e dizer o que assumiu) e de não mudar nada só quando faltar
algo de fora do repositório. Uma mudança feita aí segue o caminho normal (push, checks, review, PR); nenhuma
mudança leva a task para uma pessoa, com o que o agente disse depois da revisão.

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

## Entrega: workspace, develop e main

Todo repositório que a fábrica atende tem três branches, e cada uma tem um dono e um propósito. Isto é o
padrão da fábrica, para qualquer repositório:

| Branch                   | O que é                      | Quem move                                                                |
| ------------------------ | ---------------------------- | ------------------------------------------------------------------------ |
| `workspace`              | A integração, sem governança | A fábrica, quando o trabalho passa nos checks e o review aprova          |
| `develop`                | A pré-release                | A fábrica, a cada integração                                             |
| `main` (a branch padrão) | A release                    | Só uma promoção de `develop`: um humano, ou um agente se o modo permitir |

**Integração.** O agente parte de `workspace` e o PR é aberto contra ela. Quando os checks passam e o
review aprova, **a fábrica mesmo faz o merge** (squash), sem pedir a ninguém: os checks e o review são a
decisão. O merge é fixado ao SHA que foi verificado e revisado, então um push que caia entre olhar e
mergear faz o GitHub recusar em vez de juntar o que ninguém viu. Se o GitHub recusar o merge (um conflito,
uma branch protegida), a task não falha: o motivo fica no estágio `done` (`integrationError`). Um conflito com a base volta a
rodar sozinho (veja o reinício automático acima); qualquer outra recusa deixa o PR aberto para uma
pessoa. Trabalho entregue a uma pessoa (`handoff`) nunca é mergeado pela fábrica.

**Integração que espera o CI do repositório.** Antes de mergear, a fábrica lê o que a branch de integração
exige (`GET /repos/{r}/branches/{branch}` e as regras de `GET /repos/{r}/rules/branches/{branch}`). Se ela
exige status checks, a fábrica não mergeia depois só dos checks dela: liga o auto-merge do PR (merge commit,
com `expectedHeadOid` igual ao SHA verificado), grava esse SHA em `task.awaiting_ci_sha` e termina a
execução. A task fica `done`, o painel mostra "waiting for CI", e nada de pré-release ainda. Se o GitHub
recusar o auto-merge porque o PR já está `clean` (os checks obrigatórios passaram antes de a fábrica chegar
aí), não há o que esperar: a fábrica mergeia na hora, fixada ao SHA verificado, pelo mesmo caminho de um
repositório sem checks obrigatórios. Qualquer outra recusa faz a execução falhar com uma mensagem dizendo o
que configurar.

**PR que ainda é o rascunho de um handoff.** Quando uma pessoa pede mudanças numa task em `handoff` e a
execução nova é aprovada, o PR aberto é o mesmo rascunho, com o título `[needs a person] ...`. O GitHub não
mergeia rascunho, nem direto nem por auto-merge. Antes de integrar, nos dois caminhos, a fábrica marca o PR
como pronto para revisão e devolve o título sem o prefixo (uma chamada GraphQL,
`markPullRequestReadyForReview` com `updatePullRequest`; a API REST não tira um PR de rascunho). Um PR que
não é rascunho não recebe chamada nenhuma. Se mesmo assim o GitHub recusar o auto-merge dizendo que o PR é
rascunho, a fábrica marca como pronto e pede o auto-merge mais uma vez; uma segunda recusa falha a execução.

O cron `integrate-after-ci` olha essas tasks a cada dois minutos:

- O GitHub mergeou o SHA verificado: a fábrica grava `merged_sha` e faz o mesmo que depois de um merge
  direto, com o mesmo código: avança `develop` (ou abre o PR para ela), cria a pré-release ali e aplica o
  modo de release. O evento `done` novo leva `integratedBy: auto-merge`.
- Um check obrigatório falhou: a fábrica desliga o auto-merge, para que o commit novo do agente não entre
  antes de ser verificado, e manda o trabalho de volta ao agente, na mesma branch. O feedback nomeia cada
  check, com o link e a evidência que a fábrica leu no servidor com o token do repositório, porque o
  sandbox não abre o link: as linhas de erro do log de um job do Actions, ou as anotações e o resumo de
  outro check (o mesmo `readEvidence` do `watch-promotions`). Se o check obrigatório é um job agregador
  cujo log só diz que uma dependência não passou, a nota também traz os outros checks que falharam no
  mesmo commit, marcados como não obrigatórios, com link e linhas de erro; um que não diz mais do que o
  agregador fica de fora. Um commit status, que não tem check run,
  leva o fim do que reportou. Se o GitHub não entrega a evidência, a nota diz isso, o motivo vai para o
  log do cron e o trabalho volta mesmo assim. Conta como execução automática: depois de 3, vai para uma
  pessoa com a lista dos checks.
- O PR conflita com a base: recomeça sobre a base nova, como no conflito de um merge direto.
- Um push depois da verificação, um PR fechado sem merge, um merge de outro commit, o auto-merge
  desligado por alguém, ou um check obrigatório que não reporta em 6 horas (um check que só roda em push
  nunca aparece num PR): vai para uma pessoa (`handoff`), com um comentário na issue. A fábrica nunca
  deixa mergear outro commit além do verificado.
- Checks ainda rodando: espera.

Para esse caminho funcionar, o repositório precisa de "Allow auto-merge" e "Allow merge commits" ligados,
e os checks exigidos têm de rodar em pull requests contra a branch de integração.

**Pré-release.** Logo depois de integrar, a fábrica avança `develop` até o commit integrado e cria uma tag
`pre/<issue>-<sha7>` sobre ele, marcada como pré-release no GitHub. Nas notas vão os checks, o veredito do
review, as tentativas, o custo e o que o agente disse. Se o GitHub recusar o avanço de `develop` (uma branch
protegida que só aceita PR), a task continua integrada e a tag fica sobre o commit de `workspace`
(`developError` no estágio `done`). Nesse caso a fábrica abre, ou reaproveita, um PR de `workspace` para
`develop` (`developPullRequest`) e **só o abre**: quem o mergeia é quem as regras da branch pedirem. É um
PR só, e as integrações seguintes entram nele. Checks vermelhos não geram entrega, porque não há o que entregar.

**Release.** É a promoção de `develop` para a branch padrão: abre (ou reaproveita) um PR `develop → main` e
o mergeia, e publica uma release de verdade com a versão seguinte à maior tag `vX.Y.Z` do repositório
(`v0.1.0` quando não há nenhuma; tags de pacote e pré-releases como `v2.0.0-rc.1` não contam), e `patch`,
`minor` ou `major` escolhe o que sobe. Como é a promoção da branch, **tudo o que está em `develop`
vai junto** com o item pedido. Quem a faz:

- um humano, pelo painel. O clique vale como a aprovação, e o painel pede confirmação;
- um agente, quando o modo permite. `FACTORY_RELEASE_MODE` é `manual` (padrão: só humanos), `trial` (a
  fábrica registra que "um agente teria liberado", sem liberar) ou `auto` (a fábrica libera um commit com
  checks verdes e review aprovado). Trabalho entregue a uma pessoa nunca é liberado sozinho.
  No modo `auto` a liberação não espera aprovação no painel (decisão do dono): valem só as recusas
  abaixo.

`release()` recusa, dizendo por quê, quando:

- a task não está concluída, ou já foi liberada, ou outra liberação está em curso;
- o trabalho não foi integrado (o PR dele ainda espera merge em `workspace`, então não está em `develop`);
- não há pré-release, ou os checks não estão verdes;
- o PR `develop → main` não pôde ser aberto (por exemplo, `develop` não tem nada que `main` já não tenha),
  está fechado ou é um rascunho.

O merge é fixado ao commit que a fábrica viu em `develop`. Com a release criada, toda task cujo trabalho
está no commit promovido (a do release e toda task `done` integrada antes dela, conferido pela API de
comparação) ganha uma entrega `release` com a tag, vai para `released`, recebe na issue o comentário
"Available in `<tag>` (<url da release>)" e tem a issue fechada. É o mesmo código do cron
`publish-changesets` (`factory/ship.ts`). Uma issue que o GitHub não deixa comentar ou fechar não desfaz o
release: o motivo fica no estágio `released` da task (`issueError`) e na resposta (`issueErrors`). Se o merge
acontece mas a release não pôde ser criada, só a task do release fica `released`, com o erro registrado,
porque o merge não se desfaz.

**Task resolvida sem mudança.** Uma task `done` com `resolved_sha` e sem `merged_sha` não tem nada que uma
tag carregue, e a issue dela já foi fechada quando foi resolvida. Ela vai para `released` quando o commit em
que foi resolvida está na branch de release (a que o dono escolheu, ou a branch padrão), conferido pela API
de comparação. Isso acontece em dois momentos. Toda release que termina (a da própria fábrica ou uma
publicação de changesets, pelo mesmo `shipContained`) confere as tasks resolvidas do repositório contra o
commit promovido. E o cron `catch-up`, a cada 5 minutos, confere até 25 delas contra a ponta da branch de
release, continuando de onde a passada anterior parou e recomeçando do início ao chegar ao fim, o que pega
as que já estavam lá antes de existir essa regra. O estágio `released` registra `releaseBranch`,
`resolvedSha` e quem moveu (`actor`; `factory` no cron, e na release também o `mergeSha` promovido). Não há
entrega `release` nem tag, nenhum comentário na issue, e uma task cujo commit ainda não está na branch de
release fica onde está. Uma comparação que o GitHub recusa vira log e a passada seguinte tenta de novo.

**Release que espera o CI da branch de release.** Um PR `develop → main` aberto há um segundo ainda não tem
os checks que a `main` exige, e o GitHub recusa o merge (`405 ... required status checks have not
succeeded`). Por isso, quando a branch de release exige status checks, o `release()` não mergeia: liga o
auto-merge do PR, fixado ao head que viu, e grava uma linha em `release_wait` com o PR, o head, a branch, o
`bump`, quem decidiu e se o repositório usa changesets. A task continua `done`, a resposta traz
`awaitingChecks`, e a página da task diz que o release espera os checks e esconde o botão de release.
Só um release por repositório espera de cada vez, porque todos usariam o mesmo PR; um segundo pedido é
recusado com o link do PR que espera. Se o GitHub recusar o auto-merge porque o PR já está `clean`, a linha
de `release_wait` é apagada e o release mergeia na hora, fixado ao mesmo head, como sem checks
obrigatórios. Qualquer outra recusa faz o release ser recusado com o motivo.

O mesmo cron `integrate-after-ci` olha esses releases a cada dois minutos:

- O GitHub mergeou o head fixado: a fábrica termina o release com o mesmo código do merge direto (a tag e a
  release, ou a `publication` de um repositório com changesets, gravada só agora que a promoção está na
  branch de release), cria a vigília do merge e move a task para `released`.
- Um check obrigatório falhou, `develop` recebeu um push depois do pedido, o PR conflita, foi fechado, o
  auto-merge foi desligado, ou um check não reporta em 6 horas: o release é recusado, com o motivo na
  `release_wait` e na página da task, e o auto-merge é desligado quando ainda estava ligado. Um release
  recusado nunca é tentado de novo sozinho: uma pessoa olha o PR e pede de novo. Se quem decidiu era um
  agente, a recusa também vira uma decisão `would_release`.
- Checks ainda rodando: espera.

**A branch de release.** É a branch padrão do repositório, a não ser que o dono nomeie outra em "Branch a
release lands on". Um repositório cuja branch padrão é `develop` (os gateways do theokit) precisa nomear a
sua (`main`), porque `develop` é onde vai a pré-release e a fábrica se recusa a tratar a mesma branch como
pré-release e como release. As branches que faltam são criadas a partir da branch de release, e a promoção
abre o PR `develop → <branch de release>`.

**Repositório que publica com changesets.** Quando `develop` tem `.changeset/config.json` (os quatro
repositórios do theokit), a versão não é da fábrica: vem dos arquivos `.changeset/*.md`, e quem publica no
npm e cria as tags (`@theokit/ui@1.13.0`) é o workflow de release do próprio repositório, ao mergear o PR
"Version Packages" que ele abre a partir de `changeset-release/main`. Nesse caso o `release()`:

- um changeset só conta como esperando quando a API de comparação entre a branch de release e `develop` o
  lista como adicionado desde a base comum das duas (`.changeset/*.md`, menos o README) e ele nomeia pelo
  menos um pacote no front matter. Um changeset que um release anterior consumiu na branch de release, e que
  `develop` ainda guarda porque ninguém fez o back-merge, não conta (o theokit-plugins depois do Version
  Packages #250). Um changeset vazio também não conta: ele não versiona nada, e o workflow de release falha
  com "this release would publish nothing" (o theokit em 2026-11-13, com doze deles);
- quando nenhum changeset está esperando, lê na mesma comparação os arquivos que
  `develop` muda desde a branch de release e liga cada um aos pacotes em que está (todo `package.json` de
  `develop` acima dele, a raiz incluída). Se algum desses pacotes é publicado pelo changesets (tem nome, não
  é `private` e não está no `ignore` do `.changeset/config.json`), recusa e diz o nome do pacote, porque ele
  não seria publicado. Se nenhum é (o `theoclaw`, ignorado no theokit, ou arquivos fora de pacote), o
  release é o da própria fábrica: tag, release, tasks liberadas e issues fechadas, como num repositório
  sem changesets, porque nenhum changeset pode existir para esses pacotes;
- com um changeset esperando, promove `develop` para a branch de release como sempre, mas não cria tag nem
  release próprios;
- grava uma `publication` esperando, e a task que pediu o release fica `released` (promovida). Quando a
  branch de release exige checks, isso acontece só depois que o GitHub mergeia a promoção (veja acima).

O cron `publish-changesets` olha cada `publication` esperando, a cada minuto. Ele acha o PR "Version
Packages" e o mergeia quando os checks dele estão verdes, fixado ao commit que viu, em nome de quem decidiu o
release. Checks vermelhos, pendentes ou ausentes, rascunho ou PR fechado: ele espera e registra o motivo na
`publication`. O workflow cria as releases um pacote por vez, então o cron só segue quando existe uma release
para cada pacote publicado cuja versão o merge do "Version Packages" mudou (lido do `package.json` de cada
pacote no commit do merge e no primeiro pai dele); enquanto falta alguma, ele espera e registra qual. Passados
30 minutos do merge, segue com as releases que existem e registra no `detail` da `publication` o pacote que
ficou sem release, para nunca esperar para sempre. Depois que o workflow publica, ele lê as releases novas
do GitHub, grava uma entrega `release` com cada tag, e cada task cujo trabalho está no commit promovido (a
do release e toda task `done` integrada antes dela, conferido pela API de comparação) vai para `released`,
ganha o comentário "Available in <tags>" na issue e tem a issue fechada. Uma issue que não fecha fica
registrada na task e no `detail` da `publication`, e a publicação segue.

Há workflows de release que fazem o versionamento, empurram `changeset-release/<release>` e param, porque a
organização não deixa o Actions abrir pull request (o `release.yml` do usetheokit/theokit). Quando não há PR
"Version Packages" aberto ou mergeado depois da promoção e essa branch existe, está à frente da branch de release
e tem o commit da ponta mais novo que a promoção, a fábrica abre ela mesma o PR "Version Packages" a partir dela
(título "Version Packages", corpo citando o commit promovido), e a `publication` continua esperando; na passada
seguinte o PR é mergeado como qualquer outro. Uma branch com commit anterior à promoção é de um release antigo e
é ignorada. Enquanto uma branch dessas espera, a `publication` nunca é encerrada pelo caminho abaixo.

Se o workflow de release roda no commit promovido e não abre o PR "Version Packages" (porque não havia
changeset para aplicar), nada é publicado, e a `publication` esperaria para sempre. Por isso, passados 10
minutos da promoção, quando ainda não há PR "Version Packages" aberto ou mergeado depois dela, o cron lê os
checks do commit promovido (a API de checks, a mesma permissão que a fábrica já tem; a de workflow runs pediria
a permissão Actions):

- algum check ainda roda, ou nenhum reportou: espera, e diz isso na `publication`;
- algum check falhou: a `publication` fica `failed`, e o motivo vai para a task, onde o painel o mostra
  ("merged by …, but the release could not be created: …");
- todos terminaram sem falha: o run acabou e não vai abrir o PR. A fábrica lê o que a promoção mudou (a
  comparação do commit promovido com o seu primeiro pai). Se mudou um pacote que o changesets publica, a
  `publication` fica `failed` com o nome do pacote, porque uma tag da fábrica não o publicaria. Se não, a
  promoção vira um release da própria fábrica, como no caso sem changeset acima: o patch depois da maior tag
  `vX.Y.Z`, as tasks contidas na promoção liberadas e as issues comentadas e fechadas. A tag é escolhida
  uma vez e gravada na `publication` antes de ser criada, então uma passada que falha depois e roda de novo
  cria a mesma tag, não a seguinte.

Depois do release, o workflow do repositório abre o back-merge: o PR da branch de release para a branch de
integração (`main → workspace`). Enquanto ele não entra, `workspace` fica com as versões de antes do release,
e um check que compara as duas coisas (o `check-changelog-current` do theokit) reprova todo PR da fábrica, que
então devolve trabalho já aprovado ao agente. Por isso o mesmo cron, a cada passada, procura em cada
repositório habilitado que já teve uma `publication` um PR aberto cuja head é a branch de release do próprio
repositório (nunca a de um fork) e cuja base é a branch de integração. Com os checks verdes, ele mergeia com
merge commit, fixado ao commit da head que viu. Checks vermelhos, pendentes ou ausentes, ou rascunho: o PR
fica aberto e a próxima passada tenta de novo. Esses são os dois únicos PRs que esse passo mergeia: o
"Version Packages" e o back-merge.

Nesses repositórios a verificação ganha um check a mais, `changeset`
(`node /tmp/factory-changeset-check.mjs origin/<branch de integração>`). É um script que a fábrica grava no
sandbox antes de cada rodada de checks (`factory/changeset-check.ts`) e que só precisa de node e git. Ele
compara o commit com a base comum da branch de integração e usa a mesma regra do release para dizer o que é
pacote publicado (tem nome, não é `"private": true` e não está no `ignore` do `.changeset/config.json`):

- mudar um pacote publicado sem que um changeset adicionado no trabalho o nomeie reprova, e a mensagem diz
  o pacote e os arquivos; o agente volta para escrever o changeset;
- mudar só pacotes privados, ignorados ou arquivos fora de pacote passa sem changeset. A mudança num app
  privado fica registrada no CHANGELOG do próprio app;
- adicionar um changeset vazio reprova, e a mensagem diz o arquivo e manda apagá-lo;
- se o script não consegue ler o intervalo ou o `.changeset/config.json`, sai com 2: não verificou nada, e
  isso não é aprovação.

O `changeset status` não servia para isso: ele conta pacote privado como mudança que pede changeset e aceita
um changeset vazio como resposta.

**A fábrica nunca mergeia em `main` por conta própria.** A branch de integração não pode ser a branch
padrão: a fábrica se recusa (ao habilitar o repositório e ao começar uma execução), porque integrar ali é
liberar, e liberar é a única coisa que pede uma decisão. As branches que faltam são criadas a partir da
branch padrão, ao habilitar o repositório e de novo no começo de cada execução e de cada plano. Uma branch
que já existe nunca é tocada.

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

## O vigia das promoções

Os PRs que levam o trabalho adiante (`workspace` → `develop`, `develop` → a branch de release e o Version
Packages `changeset-release/<release>`) também podem ficar vermelhos, e aí `develop` para e nada é lançado.
Um cron (`watch-promotions`) olha esses PRs abertos em cada repositório habilitado, a cada cinco minutos, e
trata cada check que falhou no commit de cabeça:

| O que ele vê                                            | O que acontece                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Um job do Actions falhou na primeira tentativa          | Roda de novo os jobs que falharam daquela run, uma vez só, e não abre nada ainda. |
| O job falhou de novo depois disso                       | Lê o log do job e guarda as linhas que dizem o que quebrou.                       |
| Um check que não é do Actions falhou (CodeQL, Sonar)    | Lê as anotações e o resumo do check, sem rodar de novo.                           |
| A mesma falha, com a issue dela aberta, num commit novo | Comenta na issue, em vez de abrir outra.                                          |
| A mesma falha, com a issue dela já fechada              | Abre uma issue nova: o conserto não se sustentou.                                 |

As linhas do log são escolhidas sem modelo: asserções, testes que falharam, erros de tipo e de lint (com o
arquivo), e o que ferramentas como o knip listam. Um job que só diz que outros falharam (o resumo do CI) é
deixado de lado quando outro check diz o motivo. A falha é identificada pelo check e por essas linhas, sem os
valores que um teste inventa a cada execução, e a tabela `promotion_finding` liga cada uma à sua issue.

A issue sai com o label `factory`, então um agente a pega como qualquer outra. A exceção é um scanner de
segredos (TruffleHog, gitleaks): ele lê todos os commits da promoção, inclusive os que já estão no histórico,
que nunca é reescrito, e nenhuma mudança no código o faz passar. Essa issue sai sem o label, para uma pessoa
decidir.

Cada passada abre no máximo `FACTORY_PROMOTION_ISSUES_PER_PASS` issues novas por repositório (três, se não
for definido; zero desliga a abertura e mantém as reexecuções), para que um pipeline quebrado não inunde o
tracker. O resto fica para a próxima passada. Comentários não contam nesse limite. Nada aqui faz merge.

O diagnóstico não passa por um assistente no processo do servidor. O log é texto que veio de fora, e um agente
lendo esse texto onde estão as credenciais da fábrica seria uma porta aberta. Quem diagnostica é o agente
que pega a issue, dentro da sandbox, com o repositório e os comandos do projeto à mão.

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

**Indicadores e faixas de controle.** O cron `measure` roda de hora em hora e lê o que a fábrica já grava
(eventos de estágio, evidência, reviews e o vigia da `main`). Com isso calcula oito indicadores por
repositório e um conjunto para a fábrica inteira (`*` no banco, "All repositories" no painel). Cada run de
uma task começa num `intake` e só conta quando termina (`done`, `failed` ou `handoff`). Uma run que só
esperou outra issue fechar não conta.

| Indicador                 | O que mede                                                                                | Piora quando |
| ------------------------- | ----------------------------------------------------------------------------------------- | ------------ |
| `first_pass_checks`       | Se todas as checagens da primeira verificação da run passaram                             | cai          |
| `rework_rounds`           | Quantos retrabalhos a run teve                                                            | sobe         |
| `first_review_approval`   | Se o primeiro review da run aprovou                                                       | cai          |
| `minutes_to_first_review` | Minutos do início da run até o primeiro review                                            | sobe         |
| `minutes_to_delivery`     | Minutos do início da run até o `done`                                                     | sobe         |
| `cost_per_delivery`       | Custo de uma run entregue                                                                 | sobe         |
| `change_failure`          | Se a entrega voltou: nova run, `failed` ou `handoff` depois do `done`, ou `main` vermelha | sobe         |
| `hours_to_release`        | Horas da criação da task até a primeira release                                           | sobe         |

Os valores viram um ponto por dia (a média do dia, guardada em `metric_point`), e só quando o dia tem
observações suficientes: três, ou uma para `hours_to_release`. A faixa de cada série é a média e o desvio dos
pontos dos últimos 30 dias, sem os 8 mais recentes. Sobre esses 8 rodam as regras de Western Electric, sempre
no sentido em que o indicador piora. Melhorar demais não dispara nada. Sem 7 pontos de base, ou com desvio
zero, a série fica "no baseline yet". A detecção é só aritmética, sem modelo.

| Regra                         | Quando dispara                     | O que acontece                |
| ----------------------------- | ---------------------------------- | ----------------------------- |
| `four_of_five_beyond_1_sigma` | 4 dos últimos 5 pontos além de 1σ  | Só registra                   |
| `two_of_three_beyond_2_sigma` | 2 dos últimos 3 além de 2σ         | Registra e mostra no painel   |
| `eight_on_one_side`           | Os últimos 8 do lado ruim da média | Registra e mostra no painel   |
| `beyond_3_sigma`              | O último ponto além de 3σ          | Registra, mostra e abre issue |

As faixas e os níveis ficam em `src/server/metrics/config.ts`, versionados. Cada regra quebrada num dia vira
uma linha em `metric_signal`, uma vez só. A issue vai para `paulohenriquevn/aifactory`, com a tabela dos
pontos, e só uma por indicador e repositório a cada 30 dias. Quando o mesmo dia já abriu issue num
repositório, a série da fábrica inteira não abre outra. Se o GitHub recusa, o erro fica na linha e a passada
seguinte tenta de novo. A página Health mostra o último dia de cada indicador, a base e o estado da faixa, e
os sinais dos últimos 14 dias que mostram ou abrem issue.

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

## Avaliação dos agentes

Os testes de unidade usam agentes falsos, então não dizem se uma mudança de prompt, de harness, de modelo ou
da imagem do sandbox deixou os agentes piores. Para isso existe uma suíte de casos reais, rodada pelos agentes
de verdade (ADR 0008).

- **Os casos** estão em `evals/cases.json`: 30 tarefas que a fábrica entregou, em seis repositórios, metade
  bug e metade feature. Cada um tem a issue, o commit de partida e as checagens que aceitaram o trabalho.
  `pnpm evals:cases` os escreve de novo a partir do banco e do GitHub, sem mudar nada em nenhum dos dois.
- **Um caso roda como uma tarefa**: sandbox, plano do construtor, construtor, checagens, guardas do diff,
  revisor e até três tentativas, com os agentes e modelos escolhidos no painel. O construtor não pode perguntar nada. Nada sai
  do sandbox: o GitHub é alcançável sem credencial, então o clone funciona e um push não tem como passar. O
  caso passa quando as checagens passam, o revisor aprova e nenhuma guarda bloqueia.
- **`pnpm evals`** roda os cinco casos marcados como rápidos (`EVALS_SET=all` roda todos, `EVALS_CASES` escolhe
  pelo id) e compara com `evals/baseline.json`. Cada rodada fica em `.evals/`. `EVALS_BASELINE=1` grava a
  rodada como a nova baseline. Nenhum caso começa depois que o gasto chega a `EVALS_BUDGET_USD` (padrão
  US$ 15).
- **No deploy**, `scripts/deploy.sh` chama `pnpm evals:check` antes do build. Se nenhum arquivo da
  configuração dos agentes mudou desde o commit da baseline, e o agente, o modelo e o esforço de cada papel
  são os mesmos, a checagem não roda nada. Senão, roda os casos rápidos, e o deploy para sem build e sem
  restart quando a taxa de aprovação cai mais de 20 pontos (um caso de cinco) ou o custo médio por caso sobe
  mais de 25%.

A baseline de 2026-11-11 passou cinco de cinco casos, com custo médio de US$ 0,35 por caso nos agentes, e
levou 32 minutos. Somando o sandbox, a rodada custou US$ 1,98.

## O painel

Uma interface local para ver e conduzir a fábrica. Abre em `http://localhost:3000`.

**A casca.** Um menu lateral e duas abas no topo, Chat e Work. O menu tem o botão de novo chat, os
lugares da fábrica (Quadro, Planos, Repositórios, Caixa de entrada, Saúde, Agentes, Configuração, com a contagem
do que espera ou está errado), as conversas fixadas e as recentes, e o menu da conta. Ele recolhe, e a
escolha fica no navegador. `/` é um chat novo, `/chat/<id>` reabre uma conversa e `/work` é o quadro. Os
rótulos da casca estão em português; as páginas de Work ainda estão em inglês.

**O chat.** Uma conversa com um assistente que conhece a fábrica. Ele lê o estado por ferramentas
(`factory_status`, `list_tasks`, `task_detail`, `backlog_progress`) e responde com o que leu, não de
memória. Três ferramentas mudam algo e pedem a sua aprovação antes, num cartão: `retry_task`,
`request_changes` e `start_job` (abre uma issue e começa). Um hook (`onlyTools`) impede qualquer outra
ferramenta, porque o agente roda no servidor, onde estão as credenciais da fábrica.

Dois agentes respondem, e o seletor no campo de mensagem escolhe entre eles:

| Modelo     | Agente                 | Credencial                                                                                               |
| ---------- | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| OpenRouter | `agents/chat.ts`       | `OPENROUTER_API_KEY`; o modelo vem de `FACTORY_CHAT_MODEL` (padrão `openrouter/google/gemini-2.5-flash`) |
| ChatGPT    | `agents/chat-codex.ts` | a assinatura do ChatGPT, pelo login de dispositivo do TheoKit; modelo em `FACTORY_CHAT_CODEX_MODEL`      |

O login do ChatGPT é feito no próprio chat: ao escolher o modelo sem estar conectado, aparece um cartão
com o endereço e o código, e a página percebe sozinha quando você termina. A credencial fica em
`~/.theokit/auth.json` e é renovada pelo TheoKit. Ela é separada do login do Codex que a fábrica usa para
construir (`~/.codex-factory-N`), porque um refresh token rotaciona e dois usuários do mesmo login se
invalidariam. A cota da assinatura, porém, é a mesma.

As conversas ficam no Postgres (`chat` e `chat_message`). Uma conversa nova só é criada quando a primeira
resposta termina, e a página vai para o endereço dela. Como o agente não guarda sessão entre mensagens, o
histórico viaja dentro da mensagem (as últimas 20, cortadas) e a tela mostra só o que você escreveu.

**Um guia para cada página.** Em Quadro, Planos, Repositórios, Caixa de entrada, Saúde, Agentes e Configuração, o
botão "Guia" no alto da página abre, ao lado dela, um especialista daquela página: o Guia do Quadro, de
Planos, de Repositórios, da Caixa de entrada, da Saúde, dos Agentes e da Configuração. O chat não tem guia, porque é o
assistente geral. A página não sai do lugar: o painel divide a largura com ela (e cobre a página só em
telas estreitas), então o dono vê o que está sendo explicado ou mudado.

Cada guia tem três coisas, e é isso que o diferencia de um chat solto:

- **Sabe onde o dono está.** Toda mensagem leva a página e o item aberto (a tarefa de `?task=7`, o plano
  de `/plans/3`), então "esta tarefa" quer dizer a que está na tela.
- **Responde sobre a situação do dono.** O manual de cada página (`agents/prompts/guides.ts`) usa os nomes
  que a tela escreve ("Will retry itself", "Approve this commit"), e o guia consulta os dados antes de
  responder, em vez de explicar o conceito de forma geral.
- **Muda o sistema só com o OK, e mostra o que muda.** Quando propõe uma mudança, aparece um cartão em
  português com os botões Aprovar e Recusar. Numa configuração de repositório o cartão mostra "antes →
  depois" (e "nada muda" quando já está assim). Ao terminar, a página atrás atualiza na hora.

Ao abrir o painel pela primeira vez numa página, aparece o que a página faz e sugestões, separadas em
"Entender" e "Fazer"; as que pedem as palavras do dono vão para a caixa, em vez de serem enviadas. Uma
bolinha no botão some depois da primeira vez. A chamada de uma ferramenta não aparece como um cartão com
dados crus: vira uma linha ("Consultou: as tarefas", "Fez: começou uma tarefa de novo").

| Guia          | Lê                                                       | Muda (com aprovação)                                            |
| ------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| Quadro        | estado, tarefas por coluna, caixa de entrada, uma tarefa | repetir, devolver com nota, aprovar o commit, abrir um job      |
| Planos        | planos e seus itens, repositórios                        | começar um plano, criar as issues dele                          |
| Repositórios  | repositórios e arquivos de build do projeto              | configurações e ativação de um repositório                      |
| Caixa entrada | o que espera uma pessoa, uma tarefa                      | aprovar o commit, devolver com nota, repetir                    |
| Saúde         | custo e achados do supervisor, uma tarefa                | resolver um achado, marcar a `main` vermelha como vista         |
| Agentes       | o catálogo de agentes e o texto de cada instrução        | qual agente de código constrói, planeja e revisa                |
| Configuração  | o que falta para a fábrica funcionar                     | nada: guia passo a passo (chaves e contas são feitas pelo dono) |

Nenhum guia faz release nem merge na `main`: o release é um botão do dono na tarefa. Nenhum aceita chave
ou senha na conversa. Cada guia só tem as ferramentas da sua página (`onlyTools`), e as conversas dos guias
não são gravadas: ficam na memória da página enquanto ela está aberta. Como o chat, cada guia roda no
OpenRouter (`FACTORY_GUIDE_MODEL`, padrão `openrouter/openai/gpt-4.1-mini`) ou na assinatura do ChatGPT,
pelo seletor do campo de mensagem. O modelo importa: um modelo mais barato (`gemini-2.5-flash`) respondia
pela descrição da página em vez de consultar os dados.

**A página Agentes.** Mostra todos os agentes da fábrica, um de cada vez, e o texto exato das instruções
que cada um recebe. A lista tem dois grupos: os que constroem o código, num sandbox (o **Construtor**,
o **Revisor** e o **Planejador**), e os que conversam com você, no servidor (o assistente do chat, um
guia por página e os dois assistentes de texto). Para cada agente a página diz o que ele faz, quando
entra em ação, o modelo ou o agente de código por trás dele (como está configurado agora, e com qual
variável se muda), o que ele pode chamar (cada ferramenta marcada como "só lê", "muda algo, pede seu OK"
ou "age só dentro do sandbox") e as instruções, em abas quando há mais de uma (o Construtor tem cinco:
a primeira tentativa, sem ninguém para responder perguntas, com um pedido de mudanças seu, o retrabalho e
a continuação depois de uma resposta). O contexto da fábrica, que o framework acrescenta a toda mensagem
dos agentes do painel, aparece dobrado dentro de cada um deles. Dá para buscar por nome, ferramenta ou
qualquer palavra de uma instrução, com o trecho achado destacado, e copiar cada instrução.

**Trocar o agente de código, o modelo e o esforço pela interface.** No Construtor, no Planejador e no Revisor
há um seletor com os agentes que a fábrica sabe rodar (`claude-code` e `codex`), e ao lado dele o **Modelo**
e o **Esforço**. A escolha fica no banco (tabela `setting`),
é lida no começo de cada execução e vale para as próximas **sem reiniciar nada**; as execuções em andamento
terminam com o agente antigo. O Planejador e o Revisor podem seguir o Construtor ("O mesmo do Construtor"),
que é o padrão; escolher um revisor diferente dá uma segunda opinião de verdade. Sem escolha, vale o que o
ambiente diz (`FACTORY_HARNESS`, `FACTORY_PLANNER`, `FACTORY_REVIEWER`) e, sem isso, `claude-code`. Um agente
sem credencial aparece como "indisponível", com o que falta, e não pode ser escolhido, porque uma escolha
que quebra toda execução é pior do que nenhuma. Um repositório com agente próprio (campo "Builder" ou
"Reviewer" em Repositórios) ignora esta escolha, e o seletor lista quais são. Os modelos oferecidos são os do agente escolhido e mudam com ele: para o `codex`, a lista que a própria CLI
guarda para a sua conta (`models_cache.json`, só os que ela mostra, cada um com os níveis de esforço que
aceita); para o `claude-code`, os apelidos que a CLI documenta (`sonnet`, `opus`, `fable`) e os níveis
`low` a `max`. Sem escolha, o agente usa o próprio padrão, que sempre funciona. Um modelo vale para o agente
para o qual foi escolhido (fica guardado como `codex:gpt-6.1-sol`): se o agente mudar, ou uma issue pedir o
outro por label, ele não é entregue ao agente errado. O Planejador e o Revisor usam o modelo e o esforço do
Construtor enquanto não tiverem os seus, desde que seja o mesmo agente. O servidor só aceita o que o agente
oferece (um modelo de um não vale para o outro, um esforço que o modelo não aceita é recusado), e o nome
vai para a linha de comando só se for um nome simples, sem nada que um shell leia: `--model` e `--effort`
no Claude Code, `-m` e `-c model_reasoning_effort` no Codex, inclusive ao retomar uma sessão. O Guia dos
Agentes faz a mesma troca, com o seu OK.

**O modelo dos agentes do painel não se troca pela tela.** O chat, os guias e os dois assistentes de texto
têm o modelo fixado quando o servidor sobe: o TheoKit exige que um arquivo de `agents/` entregue o agente
pronto, não uma função que o monte a cada pedido (testado: devolve erro 500). Por isso o modelo deles segue
nas variáveis `FACTORY_CHAT_MODEL`, `FACTORY_CHAT_CODEX_MODEL`, `FACTORY_GUIDE_MODEL` e
`FACTORY_ASSIST_MODEL`, e só vale depois de reiniciar o painel. A página diz isso em cada um. A conta do Claude Code (assinatura ou chave de API) continua sendo definida no
ambiente (`FACTORY_CLAUDE_AUTH`), porque envolve um segredo.

Nada ali é uma cópia: o catálogo (`factory/agent-catalog.ts`, servido em `GET /api/panel/agents`) monta a
tela do código que roda. Os prompts do Construtor, do Revisor e do Planejador são os que as próprias
funções devolvem, com marcadores ‹assim› no lugar dos dados de cada tarefa (o texto da issue, a branch).
Os dos agentes do painel são as instruções que eles usam. Os modelos são os configurados. Um teste confere
que os arquivos citados existem, para a página não apontar para o nada. As instruções só se leem: mudar
uma é mudar o código, no arquivo que ela indica.

**O que o painel mostra, ao vivo:**

- O quadro: uma coluna por situação (na fila, trabalhando, esperando você, vai tentar sozinha, entregue,
  precisa de uma pessoa), com o custo e o número de tentativas de cada task. Uma falha por cota do agente
  ou por problema de ambiente (rede, GitHub, sandbox, reinício) cai em "Will retry itself", porque a
  fábrica a repete sozinha quando passa. Só a falha do próprio trabalho fica em "Needs a person". Um PR
  que a fábrica já integrou aparece como "integrated", e um que espera os checks obrigatórios do
  repositório para o GitHub mergear aparece como "waiting for CI".
- A caixa de entrada: só o que espera uma pessoa, do mais antigo ao mais novo. É uma pergunta do
  agente, um PR que ninguém aprovou, um trabalho entregue depois de três tentativas ou uma execução
  que falhou (com "sem cota" dito como tal).
- O detalhe da task: a linha do tempo de estágios, o que os agentes fizeram, a evidência (comando, SHA,
  código de saída e a saída), os reviews com os achados, as perguntas e respostas e as decisões tomadas.

**O que os agentes fizeram.** Enquanto o construtor e o revisor trabalham, cada passo deles aparece no
detalhe da task: o que disseram, cada ferramenta que chamaram (com o que ela devolveu, dobrado dentro do
cartão) e o custo no fim. O Claude Code roda com `--output-format stream-json --verbose` e o Codex com
`exec --json`; a fábrica lê a saída linha a linha (`executeStreaming` no sandbox Docker), traduz cada linha
para um passo (`factory/transcript.ts`) e grava na tabela `agent_event`, em ordem, contando através das
rodadas da task. O resultado da execução continua saindo da última linha, então custo e estágio não mudam.
Antes de gravar, cada passo passa por um filtro que troca os formatos de token conhecidos (`ghs_`, `ghp_`,
`github_pat_`, `sk-ant-`, `sk-proj-`, `vcp_`) por `[redacted]` e é cortado em 8 KB. Os passos ficam 30
dias; o cron `prune-transcripts` apaga os mais velhos, uma vez por dia. O `SandboxBackend` do TheoKit só
devolve a saída no fim (usetheokit/theokit-sdk#883), por isso a leitura em fluxo é do provedor Docker; num
provedor sem ela, a execução roda como antes e a task fica sem passos.

**Tempo real.** O servidor manda um evento (SSE, `/api/panel/stream`) a cada mudança de estágio e a cada
passo de um agente, e a página recarrega só o que mudou. Os passos vão pela mesma conexão, porque o
navegador aceita só seis por endereço; o histórico vem de `/api/panel/tasks/<id>/transcript?after=<n>`,
500 por vez, e a página escuta o stream antes de pedir a primeira página, para não perder um passo gravado
entre as duas. Um relógio lento cobre o que o evento não traz, como o custo que cresce
enquanto o agente trabalha, e uma conexão que caiu.

**Ações.** Todas passam pelo servidor, que confere o estágio da task de novo, então uma página velha não
consegue fazer o que a task já não permite.

| Ação                  | Quando                                                        | O que faz                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aprovar               | task com PR (`done`, `handoff`)                               | Grava a aprovação **presa ao commit** em que o PR está. Se a branch andar, a aprovação não cobre o commit novo.                                                                                                                                                                                                                                                       |
| Pedir mudanças        | task com PR, com um texto                                     | Uma nova execução parte da branch que o agente já enviou, com o texto no prompt, e passa de novo por checks e review. Se a branch não existe mais no GitHub (task resolvida sem mudança, ou branch apagada por um "Tentar de novo"), a execução parte da branch de integração, como a primeira, com o mesmo texto no prompt, e a task deixa de contar como resolvida. |
| Tentar de novo        | task `failed` ou `handoff`, ou `done` com o PR nunca mergeado | Apaga a branch (o que fecha o PR) e recomeça do zero, sobre a base atual. É o caminho para um PR que o GitHub recusou por conflito.                                                                                                                                                                                                                                   |
| Marcar como resolvida | task `failed` ou `handoff`, com um texto                      | Para o que uma pessoa resolveu por outro caminho (à mão, ou dividindo a issue em outras já entregues). O texto diz onde. A task vai para "Already resolved", marcada como resolvida no commit em que a branch de integração está.                                                                                                                                     |

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

## Do zero ao primeiro PR, pelo painel

Tudo o que o dono precisa fazer acontece no painel (`http://localhost:3000`) e nas páginas do GitHub que
ele abre. Nenhum comando.

1. **Setup.** A página lista o que falta: a GitHub App, o webhook, os eventos que a App assina, o
   segredo do webhook, o sandbox, ao menos um agente (Claude Code ou Codex) e um repositório
   habilitado. Cada linha diz o que está errado e leva à página que conserta. Nunca mostra um segredo, só se ele existe e o que o paga.
2. **Instalar a App e dar acesso aos repositórios.** O botão "Install on GitHub" (em Repositories e no
   Setup) abre a página de instalação da App no GitHub, numa aba nova. Lá o dono escolhe a conta ou a
   organização e os repositórios, e o painel, que passa a perguntar ao GitHub a cada poucos segundos,
   percebe sozinho quando a instalação aparece e avisa. A permissão é do GitHub, não nossa. Em
   "Repository permissions", a App precisa de leitura e escrita em Contents, Pull requests, Issues,
   Checks e Workflows. O token de cada execução pede exatamente essas cinco, e sem Workflows o GitHub
   recusa o push de qualquer mudança em `.github/workflows`. Ao ganhar uma permissão, a App pede
   aprovação em cada instalação, e enquanto alguma não aceitar, o token daquela conta não é emitido. A App precisa
   ser pública para ser instalada fora da conta que a criou (uma organização, por exemplo). Para o GitHub
   devolver o dono ao painel ao terminar, preencha o "Setup URL" da App com
   `http://localhost:3000/repositories` e marque "Redirect on update"; sem isso o dono volta ao painel por conta própria, e a página percebe o mesmo.
3. **Habilitar.** Alcançar um repositório não é licença para trabalhar nele: a App está instalada em
   todos os da conta, e uma issue com a label `factory` num repositório não habilitado é gravada e
   ignorada (`repository_disabled`). Habilitar é o clique em Enable na página Repositories. Só quem a
   App alcança pode ser habilitado.
4. **Ajustar por projeto.** Para cada repositório habilitado: os checks (um por linha, `nome: comando`,
   vazio roda `npm test`), os domínios extras que o sandbox pode alcançar (o GitHub, o agente e o
   registro do npm já estão abertos; um projeto Python pede `pypi.org` e `files.pythonhosted.org`), a
   branch de onde o trabalho parte, o agente que constrói e o que revisa, e até onde vai o release. Isso vale para toda execução daquele
   repositório. Uma label `harness:` ou `reviewer:` na issue ainda vence o padrão do repositório.

   **A receita do projeto.** Um projeto pode dizer o que precisa num arquivo `.factory/setup.json`, com o
   comando de instalação, os checks e os domínios que as ferramentas dele alcançam:

   ```json
   {
     "install": "pip install -e .",
     "checks": [{ "name": "test", "command": "pytest" }],
     "egress": ["pypi.org", "files.pythonhosted.org"]
   }
   ```

   A fábrica lê o arquivo pela API do GitHub, na branch padrão, antes de existir sandbox, então o agente
   não amplia a própria saída editando o arquivo na branch dele. A precedência é o painel, depois a
   receita, depois o padrão: os checks da receita valem quando o painel não define nenhum, e a instalação
   roda como o primeiro check. Um domínio da receita só chega ao firewall depois de aprovado: a página
   Repositories mostra a receita embaixo dos ajustes, marca cada domínio como aberto ou esperando você, e
   diz o que a próxima execução passaria a alcançar antes de você aprovar. Só um domínio que a receita da
   branch padrão pede naquele momento pode ser aprovado. Uma receita que não é JSON, tem um campo
   desconhecido ou um domínio inválido faz a execução falhar com o motivo, que a página também mostra.

   **A branch de integração.** Por padrão é `workspace` (veja "Entrega"): o agente parte dali, o assistente
   de setup lê os arquivos dali, o planejador lê o repositório dali, e o PR é aberto contra ela. Um projeto
   que integra em outra branch preenche "Branch the work starts from". Vazio volta a `workspace`. O nome é
   validado (sem `-` no começo, sem `..`), e a branch de integração não pode ser a branch padrão do
   repositório. Se `workspace` e `develop` não existem, a fábrica as cria ao habilitar.

   **O doctor do repositório.** Habilitar um repositório roda o doctor nele, e
   `GET /api/panel/repositories/<dono>/<nome>/doctor` roda de novo a qualquer momento. Ele examina o
   repositório antes que uma task falhe e devolve um item por diagnóstico, cada um com o estado (`ok`,
   `warn`, `blocked` ou `unknown`), a causa, o reparo, o link de onde o reparo é feito e se a fábrica
   consegue fazê-lo sozinha (`canRepair`):

   | Item              | O que acusa                                                                                             |
   | ----------------- | ------------------------------------------------------------------------------------------------------- |
   | `issues_disabled` | Issues desligadas no repositório (um fork nasce assim)                                                  |
   | `app_access`      | a App não alcança o repositório, ou a instalação não aceitou uma permissão que a fábrica pede           |
   | `app_events`      | a App não assina um evento que a fábrica lê                                                             |
   | `branches`        | falta `workspace` ou `develop` (a fábrica cria)                                                         |
   | `label`           | falta a label `factory` (a fábrica cria)                                                                |
   | `auto_merge`      | a branch de integração exige checks e o repositório não permite auto-merge ou merge commits             |
   | `ci_silent`       | um check exigido não reportou em nenhum dos últimos commits da branch nem dos últimos PRs para ela      |
   | `checks_parity`   | um check exigido não tem check da fábrica com o mesmo nome                                              |
   | `publish_mode`    | como o repositório publica: `changesets`, `tag` ou `none`; em `tag`, se o `package.json` bate com a tag |
   | `recipe`          | a receita não pode ser usada, ou tem domínios esperando aprovação                                       |
   | `sandbox`         | o provedor de sandbox recusou a última execução (sem crédito, chave recusada)                           |

   O que o doctor não conseguiu ler vira `unknown`, com o que ele tentou e o que o GitHub respondeu, e
   nunca `ok`. Um item `blocked` não impede habilitar: o relatório volta na resposta e fica em
   `repository.doctor`, com a hora. `POST .../doctor/repair` com `{ "item": "branches" }` ou
   `{ "item": "label" }` faz o reparo e devolve o relatório novo; qualquer outro item é recusado com o
   motivo, porque a App não tem permissão para mudar ajustes do repositório nem para ligar um workflow.
   Por essa mesma razão o `ci_silent` é lido dos check runs dos commits recentes, e não da API do Actions.
   Com nenhum PR para olhar ele só avisa (`warn`), já que um workflow que roda só em PR também pareceria
   mudo. Em `checks_parity`, um check da fábrica responde por um check exigido quando todas as palavras do
   nome dele estão no nome exigido (`lint` responde por `CI / Lint (node 22)`). O `publish_mode` fica
   também em `repository.publish_mode`. O painel ainda não mostra o relatório: por enquanto são as duas
   rotas e a resposta do Enable.

   **Checks provados.** `POST /api/panel/repositories/<dono>/<nome>/checks/prove` com
   `{ "checks": [{ "name": "test", "command": "npm test" }] }` prova os checks propostos antes de salvar
   qualquer um. A rota grava a proposta em `repository.checks_proof` com o estado `proving`, enfileira o
   job `prove-checks` na mesma transação e responde na hora. O job sobe um sandbox isolado com o egress de
   uma execução, menos os agentes (GitHub com o token no firewall, o registro do npm, os domínios do
   repositório e os da receita que o dono aprovou), clona a ponta da branch de integração e roda os checks
   em ordem, todos no mesmo sandbox, que é parado no fim mesmo quando um check estoura. Cada check termina
   em um de três estados, com a duração e o fim da saída:

   | Estado     | O que significa                                                    | É salvo? |
   | ---------- | ------------------------------------------------------------------ | -------- |
   | `passed`   | saiu com 0 dentro do limite                                        | sim      |
   | `failed`   | saiu com erro na base; a saída volta para a proposta ser corrigida | não      |
   | `too_slow` | ainda rodava no limite de um check (15 minutos por padrão)         | não      |

   Os que passaram viram os checks do repositório, com o commit em que passaram em
   `repository.checks_proven_sha` e o resultado de cada um em `repository.checks_proven`. Quando nenhum
   passa, os checks salvos ficam como estavam. Depois de salvar, o doctor examina o repositório de novo,
   para o `checks_parity` do relatório guardado falar dos checks novos. `GET` na mesma rota devolve a
   última prova (`proving`, `done` ou `failed` com o motivo, quando o sandbox ou o clone falhou); uma prova
   que continua `proving` depois de 100 minutos aparece como `failed`, porque o job que a rodava morreu.
   Uma prova pedida enquanto outra roda a substitui, e o resultado da antiga é descartado.

   O formulário de ajustes continua salvando o que o dono digita, sem provar nada. A resposta do
   `PUT /api/panel/repositories/<dono>/<nome>` traz `unprovenChecks`, com os nomes dos checks salvos que
   nenhuma prova rodou, e a listagem traz o mesmo campo, `checksProvenSha` e `checksProof` por repositório.
   Um check deixado como estava mantém a prova; um digitado ou alterado (nome ou comando) a perde. O painel
   ainda não mostra nada disso: por enquanto são as rotas, que a tela de onboarding vai chamar.

5. **Planejar.** Em Plans, o dono escolhe o repositório e escreve o objetivo. Um agente lê o repositório
   num sandbox (sem escrever nada) e devolve até dez issues independentes, cada uma com critérios de
   aceite. O dono edita os títulos e as descrições, tira ou reordena itens e decide: "Create issues"
   cria as issues sob um milestone do GitHub sem a label, e "Create issues and start" já põe a label
   `factory`, o que começa o trabalho. Uma issue criada sem a label pode ser iniciada depois, com
   "Start this one".
6. **Abrir um job avulso.** O botão "New job" do quadro abre uma issue (com a label, se "Start now"
   estiver marcado). A task nasce pelo webhook da própria issue, o mesmo caminho de qualquer outra.
7. **Acompanhar e entregar.** O quadro, a caixa de entrada e o detalhe de cada task seguem como antes:
   o dono aprova, pede mudanças e faz o release.

As issues de um plano devem ser independentes porque as que rodam ao mesmo tempo não enxergam umas às
outras: cada uma parte de `workspace` como ela está quando começa, e uma que dependa de outra ainda não
integrada vai conflitar. Uma que começa depois da integração da anterior já a enxerga. O agente que planeja recebe essa regra no prompt, e o dono
revisa antes de criar. Um plano que falha (o agente não terminou ou a cota acabou) diz o motivo na
própria página, e nada é criado no GitHub até o dono pedir.

O GitHub Projects não é usado. Uma App de GitHub não alcança um Project de uma conta pessoal (só os de
uma organização, com outra permissão), e o quadro do painel já mostra o estado de cada trabalho.

## O assistente sob cada caixa de texto

A premissa é que o dono não precisa ser programador: ele diz o que quer, com as palavras dele, e a
fábrica escreve o que ela precisa. Sob **toda** caixa de texto do painel há um botão que chama o
assistente da fábrica:

| Caixa                               | O que o assistente faz                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| O objetivo de um plano              | Transforma "quero um site onde meus clientes marcam hora" num objetivo claro, com o que o site deve ter. |
| A descrição de um job               | Escreve o título e o corpo da issue, terminando em "Done when:" com coisas que dá para conferir.         |
| Cada issue de um plano              | Reescreve a descrição para a issue se sustentar sozinha, sem mudar o sentido.                            |
| Pedir mudanças num PR               | Transforma "ficou estranho com número negativo" numa instrução precisa para o agente que constrói.       |
| Checks e domínios de um repositório | Lê como o projeto é construído e testado e preenche os dois campos.                                      |

O assistente responde na língua em que o dono escreveu, nunca faz pergunta (escolhe o mais sensato e diz
nas notas o que supôs), e **nada muda até o dono apertar "Use this"**. Dá para pedir outra versão em
palavras ("mais curto", "sem a parte do e-mail") ou dispensar.

**Como é feito.** São dois agentes do TheoKit, um arquivo cada: `assist` (escreve, não lê nada) e
`assist-setup` (o único que lê um repositório, e só os arquivos que dizem como ele é construído e
testado: `package.json`, `pyproject.toml`, `requirements*.txt`, `Makefile`, o README, os workflows do CI;
código-fonte e segredos são recusados, porque o que ele lê vai para o provedor do modelo). O que a fábrica
é (o fluxo, o que faz um bom pedido, o que o sandbox tem) está em `.theokit/THEO.md`, que o framework
junta a toda conversa. A resposta volta pela ferramenta `propose`, e a página lê os argumentos dela.

**Limites de segurança.** Só o dono conversa com o assistente (a política de cada agente é a mesma das
rotas do painel). O SDK dá a todo agente ferramentas próprias (um shell, acesso a arquivos), e o
assistente roda dentro do processo do servidor, que guarda as credenciais da fábrica: por isso um gancho
`pre_tool_call` (`hooks/only-tools.ts`) recusa qualquer ferramenta que não esteja na lista de cada
agente. Verificado ao vivo: um pedido para rodar `touch` por um shell não criou o arquivo. Um texto
vindo do repositório é dado, nunca instrução.

**Modelo e custo.** O assistente chama o provedor direto, com a chave da própria fábrica
(`ANTHROPIC_API_KEY`), porque o token de uma assinatura serve a um agente de código num sandbox e não a
isto. Cada ajuda custa em torno de um centavo (uns 3 mil tokens de entrada e 350 de saída no objetivo de
teste). `FACTORY_ASSIST_MODEL` troca o modelo (`anthropic/…`, `openrouter/…` ou `openai/…`, com a chave do
provedor). Sem a chave, o resto da fábrica funciona e a página Setup avisa na linha "Writing assistant".

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

**Trocar de conta (a assinatura bateu o limite, ou você quer outra).** O caminho mais curto é o painel. Na
página Setup, abaixo da linha do Claude, "Entrar com outra conta" roda `claude setup-token` no servidor, num
diretório temporário só dele (o `~/.claude` do dono fica intocado), e mostra o link de login. Abra o link num
navegador logado na conta que quer usar, copie o código que a página mostra e cole no painel. A fábrica testa
o token com uma chamada mínima e só grava se a conta responder, em `.secrets/claude-oauth-token` (modo 600;
`FACTORY_CLAUDE_TOKEN_FILE` muda o caminho). O token nunca volta para a página. Cada execução lê esse
arquivo, e ele vale por cima do `.env.local`, então a conta nova entra na próxima tarefa sem reiniciar
nada. Em seguida, "Refazer as tarefas que esperavam a conta" recomeça as da coluna "Will retry itself". O
link expira em 10 minutos.

O alimentador do backlog não refaz task nenhuma: espera o horário que o painel informa (`retryAt`) e deixa
a fábrica rodar de novo. Numa parada por cota, segura todos os itens até esse horário, porque um item novo
pararia no mesmo limite. Guarda essa pausa na memória, mas a encerra sozinho quando um arquivo de
credencial muda (o token do painel, o `.env.local` ou o login do Codex da fábrica), em até 15 segundos.

Pelo terminal, use `scripts/claude-login.sh`. Em outro terminal largo, entre na conta que quer usar e rode
`claude setup-token` (abra o link num navegador logado nessa conta e cole o código de volta). Depois rode o
script e cole o token quando ele pedir. Ele:

1. recusa o que não parece um token (o código que a página mostra não é o token);
2. **testa o token de verdade** com uma chamada mínima e não grava se a conta recusar ou já estiver no
   limite, dizendo o motivo;
3. grava em `.env.local` (modo 600, sem mostrar o token e sem passar pelo histórico do shell), trocando só a
   linha do token, e põe `FACTORY_CLAUDE_AUTH=subscription` se não houver escolha;
4. reinicia o servidor e os workers (o token é lido na subida); com tarefas trabalhando, o reinício
   espera cada uma terminar, como no deploy;
5. refaz as tarefas que estavam esperando a conta antiga (`scripts/retry-waiting.mjs`, as da coluna "Will
   retry itself") e religa o alimentador, que guarda a pausa de cota na memória e por isso é reiniciado.

Se o painel já tinha salvo um token, o script apaga esse arquivo depois de gravar o novo, porque o do painel
vale por cima do `.env.local` e a fábrica continuaria na conta antiga.

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
fica em `~/.codex-factory-1` por padrão (`FACTORY_CODEX_HOME` muda a pasta), no arquivo
`factory-auth.json`, que é o store de credenciais do TheoKit.

O login é feito pelo painel. Na página Setup, abaixo da linha do Codex, "Conectar o Codex" (ou "Entrar
com outra conta", quando já há uma) inicia o login por dispositivo do TheoKit: o painel mostra um
endereço da OpenAI e um código curto, o dono abre o endereço na conta do ChatGPT que quer usar e digita
o código, e a página percebe sozinha quando ele terminar. Antes de guardar o login, o servidor faz uma
pergunta pequena ao `codex exec` com ele, numa pasta temporária e sem o token de renovação; uma conta no
limite de uso é recusada ali, com a data em que o limite acaba. A página mostra o e-mail e o plano da
conta em uso, lidos do ID token, e nunca recebe um token. Quem já tinha feito
`CODEX_HOME=~/.codex-factory-1 codex login --device-auth` não precisa repetir: na primeira leitura a
fábrica copia esse `auth.json` para o store e deixa o original como está.

O token de renovação rotaciona. Se o Codex do uso diário e a fábrica compartilharem o mesmo login, o
primeiro que renovar invalida o outro, por isso a fábrica tem um login só dela. O access token dura 10
dias. A fábrica o renova no host quando faltam menos de 2 dias, para que ele não vença no meio de uma
execução. A renovação é a do `AuthProvider` do TheoKit, com `refreshBeforeMs` de 2 dias. Ela e a troca de conta
pelo painel passam pelo mesmo lock entre processos (o do TheoKit, com `proper-lockfile`) e releem o
arquivo dentro dele, então o servidor e o worker nunca gastam o mesmo token de renovação duas vezes, e
uma renovação nunca grava a conta antiga por cima da nova. Se a renovação for recusada, a task diz
para conectar o Codex de novo pela página Setup. Cada execução simultânea do Codex por assinatura
precisa do seu login (`~/.codex-factory-2` e assim por diante); o Claude por token não tem essa
restrição. A OpenAI recomenda não usar login de assinatura em repositório público.

## Alimentando a fábrica com um backlog

`scripts/backlog-feed.mjs` lê o `BACKLOG.md` do squad que veio antes da fábrica e transforma cada item
aberto (`approved`, `planned`, `triaged`, `raw`) numa issue que se sustenta sozinha: o que fazer, por que
agora, onde, as condições de "pronto" com as emendas e o que o sandbox não consegue provar. O item vai para
o repositório certo (`theokit`, `theokit-sdk` ou `theokit-gateways`), respeitando `blocked_by`: um item só
começa quando o que o bloqueia foi integrado, e se o bloqueio falhou o item não começa e o relatório diz
atrás de quem ele ficou. Itens que mudam um workflow do GitHub são pulados, porque a App não tem essa
permissão.

```bash
node scripts/backlog-feed.mjs --dry-run --limit 12     # a ordem, sem criar nada
node scripts/backlog-feed.mjs --concurrency 1          # alimenta e espera cada item terminar
```

O estado fica em `.backlog-feed/state.json` e a execução pode ser parada e retomada. O resultado de cada
item é `integrated` (mergeado em `workspace`), `pr-open` (o PR ficou para uma pessoa), `handoff`, `failed` ou
`not-started`. Uma parada por cota do agente faz todo o resto esperar até a hora de reset, ou até um arquivo de
credencial mudar, e repete a tarefa.
Uma falha de ambiente (sandbox, rede) é repetida uma vez.

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

## Base de conhecimento

A base de conhecimento é um repositório git seu, escolhido na página Setup (o repositório e, se quiser, a
branch das regras). A decisão está na [ADR 0006](adr/0006-base-de-conhecimento-do-usuario.md). As duas
branches são bundles do [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format)
0.2 ([ADR 0007](adr/0007-base-de-conhecimento-em-okf.md)), descritos em `templates/knowledge/README.md`.
Sem repositório escolhido, os agentes trabalham só com o código e a issue, como antes.

```text
branch sua (padrão ou a escolhida)          branch factory-memory (só a fábrica escreve)
  index.md          okf_version e conteúdo    index.md   um item por projeto
  knowledge/global/ regras (type: Rule)       memory/projects/<owner>/<repo>/index.md
  knowledge/projects/<owner>/<repo>/          memory/projects/<owner>/<repo>/log.md
                                              memory/projects/<owner>/<repo>/<nota>.md
```

- `knowledge/` são regras: os agentes as seguem como seguem o `AGENTS.md`, e elas só mudam por PR que você
  aprova. `memory/` são notas que a fábrica observou, `type: Observation` sem `verified` (nível de
  confiança "não verificado" no OKF), com a issue e o commit de origem em `sources`: dicas para conferir,
  nunca instruções.
- O repositório da base nunca é um projeto da fábrica. O painel recusa habilitá-lo em Repositórios e
  recusa escolher como base um repositório habilitado. Como projeto, uma issue nele faria um agente
  reescrever as regras que ele mesmo segue, e a fábrica integraria essa mudança sem que você aprovasse
  o PR.
- O cron `knowledge-sync` roda a cada minuto no processo principal. Ele busca as duas branches para um
  espelho bare em `.state/knowledge/<owner>/<repo>.git` (ou em `FACTORY_KNOWLEDGE_DIR`) e grava as notas
  pendentes como um commit em `factory-memory`, sempre por fast-forward. É o único lugar que busca ou
  envia algo.
- Todo agente lê a base do mesmo jeito. No sandbox (construtor, revisor e planejador), a fábrica copia
  para `/tmp/knowledge` o README, as regras globais e as do projeto e as notas do projeto, mais um
  `index.md` na raiz que lista tudo e diz nos títulos os commits e o peso de cada parte. Ela faz isso antes do agente começar e de novo a
  cada minuto em que a base muda. O sandbox nunca busca nada e não tem credencial da base, e um projeto
  não vê a pasta de outro. Cada cópia fica em `knowledge_delivery`, e o estágio `build` guarda os commits
  da primeira. No painel, todo assistente tem `knowledge_search` e `knowledge_read`, que leem o espelho.
- As notas vêm de duas fontes: as linhas `LEARNED:` que o construtor deixa no resumo final (até cinco) e
  o veredito de um run que não encontrou nada a mudar numa issue. A mesma nota num projeto é guardada uma
  vez, e o índice deixa de listar uma nota quando passa o `stale_after` dela, 180 dias depois de escrita. Para que uma nota vire regra,
  copie o texto dela para `knowledge/` por PR.
- Uma fatia leva só texto (`.md`, `.txt`, `.json`, `.yaml`), até 128 KiB por arquivo e 1 MiB no total, e o
  `index.md` da raiz diz o que ficou de fora.
- Um repositório fora do OKF continua sendo lido: o OKF manda o leitor tolerar front matter ausente. O
  Setup lista o que não conforma, conferido uma vez por commit das regras, e oferece "Propor a
  estrutura", que abre um PR da branch `factory-knowledge-setup` acrescentando o que falta sem mudar
  nenhuma linha já escrita. Se uma busca
  falhar, o Setup mostra o erro e os agentes continuam lendo o último commit bom.

## Configuração

Tudo vem do ambiente, lido quando um job começa, não na subida do servidor. O servidor sobe e
responde `/api/health` mesmo sem as credenciais.

| Variável                                              | Para quê                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| `DATABASE_URL`                                        | Postgres do estado e da fila de jobs                       |
| `GITHUB_WEBHOOK_SECRET`                               | verifica a assinatura do webhook                           |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`                    | identidade do GitHub App                                   |
| `GITHUB_APP_BOT_USER_ID`                              | id do usuário `<slug>[bot]`, que vai no e-mail dos commits |
| `GITHUB_APP_PRIVATE_KEY_PATH`                         | chave privada do App (arquivo em `.secrets/`)              |
| `ANTHROPIC_API_KEY` ou `CLAUDE_CODE_OAUTH_TOKEN`      | credencial do Claude Code                                  |
| `FACTORY_CLAUDE_AUTH`                                 | `api-key` ou `subscription`, quando as duas existem        |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Vercel Sandbox, sem a validade de 12 horas do OIDC         |
| `VERCEL_OIDC_TOKEN`                                   | alternativa de desenvolvimento, de `vercel env pull`       |
| `OPENROUTER_API_KEY`, `FACTORY_CHAT_MODEL`            | o assistente do chat no OpenRouter                         |
| `FACTORY_CHAT_CODEX_MODEL`                            | o modelo do assistente na assinatura do ChatGPT            |
| `FACTORY_GUIDE_MODEL`                                 | o modelo dos guias de página (padrão gpt-4.1-mini)         |
| `FACTORY_JOBS=off`                                    | sobe uma prévia do painel sem pegar jobs da fila           |
| `FACTORY_KNOWLEDGE_DIR`                               | onde fica o espelho da base (padrão `.state/knowledge`)    |

`.env.local` e `.secrets/` ficam fora do git, com modo 600.

## Operando

1. Suba o Postgres (`docker compose up -d`) e instale os serviços (`scripts/install-services.sh`).
   Eles sobem sozinhos no boot, sem login, e voltam se caírem. O worker de jobs roda no mesmo processo
   do servidor.
2. O túnel do Cloudflare expõe só o webhook e o health check (README, "Exposição pública").
3. Para publicar uma mudança, `scripts/deploy.sh`: compila e reinicia o servidor, os workers e o
   alimentador que estiverem rodando, sem tocar no túnel e sem ligar um alimentador parado.
   Reiniciar não interrompe as execuções em andamento: o systemd sinaliza só o processo do TheoKit
   (`KillMode=mixed`), que para de pegar jobs, espera a execução em que está (até 52 minutos,
   `src/server/factory/drain.ts`, via `jobs.worker.shutdownTimeoutMs`) e sai. Os comandos do agente
   continuam rodando enquanto isso. Por isso um deploy com tarefas trabalhando demora o tempo da mais
   longa delas, e o painel segue respondendo nesse meio-tempo. Mudou uma unit em `ops/systemd/`? Rode
   `scripts/install-services.sh` antes, para o systemd ler a versão nova.
4. Ponha a label `factory` numa issue de um repositório onde o App está instalado.
5. Acompanhe os estágios:

   ```sql
   select stage, at, left(detail::text, 200) from stage_event where task_id = 1 order by id;
   select name, sha, passed, exit_code from evidence where task_id = 1;
   ```

6. Para testar sem esperar um webhook: `pnpm test:e2e` usa um agente roteirizado contra os serviços
   reais, e `FACTORY_LIVE=1 pnpm test:e2e -t "real agent"` usa o Claude Code de verdade (centavos).
   Com as duas credenciais no `.env.local`, o teste usa a assinatura; para testar a chave, acrescente `FACTORY_CLAUDE_AUTH=api-key`.

### Serviços, backup e webhooks perdidos

Três unidades `systemd --user` (`ops/systemd/`, instaladas por `scripts/install-services.sh`):
`aifactory.service` (servidor, que espera o Postgres, aplica as migrations e serve o build),
`aifactory-tunnel.service` (o `cloudflared`) e `aifactory-backup.timer` (backup diário às 03:30). O
`linger` fica ligado, então tudo sobe no boot sem abrir uma sessão. O Postgres usa `restart:
unless-stopped`, com os dados num volume nomeado (`aifactory_pgdata`) e a porta ligada só a
`127.0.0.1`. Logs: `journalctl --user -u aifactory`.

**Backup.** `node scripts/backup.mjs` faz o `pg_dump` dentro do contêiner, grava em
`~/backups/aifactory/` com modo 600, confere que o arquivo pode ser lido e apaga os de mais de 14 dias
(pela data no nome). `node scripts/backup.mjs --check` restaura o mais recente num banco descartável e
compara as contagens de `task`, `evidence`, `stage_event`, `ingress`, `question` e `decision` com as
medidas logo antes e logo depois do dump (as tabelas só crescem, então a contagem restaurada tem de
ficar entre as duas).

**Webhook perdido.** O cron `catch-up` (a cada 5 minutos) lê o log de entregas da App no GitHub e pede de
novo as que falharam, enquanto o servidor ou o túnel estavam fora. Uma entrega é deixada em paz se alguma
tentativa dela foi aceita, se a fábrica já a gravou ou se já foi pedida três vezes. O GitHub guarda três
dias. Os ids de entrega passam do que um número do JavaScript guarda sem arredondar, então são lidos
como texto. A mesma passada move para `released` as tasks resolvidas sem mudança cujo commit já está na
branch de release (ver "Task resolvida sem mudança").

### Memória e quantas execuções ao mesmo tempo

Cada execução é um sandbox com limite de memória (`FACTORY_SANDBOX_MEMORY`, 5g). O número de execuções
simultâneas é o número de processos que tiram jobs da fila: o servidor e cada `aifactory-worker@N`
ligado. A conta tem de fechar com a RAM da máquina: **execuções × limite + o que a máquina já usa**. Com
3 execuções de 4g numa máquina de 15 GB que já usava uns 3 GB, dois sandboxes foram mortos pelo kernel
(`OOMKilled`) construindo o theokit (dois `tsup` de 2,2 GB cada) e a máquina chegou a 8,5 GB de swap.
Por isso o padrão são 2 execuções de 5g. Uma execução morta por memória aparece como
`codex failed: killed (most likely out of memory), exit 137` ou `out of memory: the sandbox hit its
memory limit`, e é tratada como falha do ambiente (a fábrica repete sozinha), não do trabalho.

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
- A GitHub App ainda é criada por um comando (`scripts/github-app-setup.mjs`), uma vez. Instalar e escolher
  os repositórios é pelo GitHub, e habilitar e configurar é pelo painel.
- O planejador só lê o repositório que a App alcança e devolve texto: ele não vê issues antigas, PRs nem o
  histórico, só o código de `workspace` (a branch de integração).
- O Postgres reinicia sozinho se o processo dele morrer, mas o reinício no boot depende do Docker estar
  habilitado (está) e não foi exercitado com um reboot de verdade.
- O vigia só olha o commit de merge de cada release, não a `main` inteira.
- O painel é local e tem um dono só, com um token.
- A resposta é lida por sondagem a cada minuto, não por evento.
- O supervisor só reporta; não corrige nada sozinho.
- Uma aprovação do revisor não é prova de que o código está certo. A evidência continua sendo os checks.
- A sessão do Vercel Sandbox no plano Hobby termina em 45 minutos.
- A base de conhecimento ainda não tem curador: nenhuma nota é deduplicada por sentido nem proposta como
  regra sozinha. Só a mesma nota, palavra por palavra, é guardada uma vez.
