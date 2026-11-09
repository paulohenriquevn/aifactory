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
   merge do PR em workspace, preso ao SHA verificado (a fábrica, sem pedir a ninguém)
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

| Estágio    | O que acontece                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `intake`   | O webhook criou a task. Uma issue tem no máximo uma task, mesmo que a label saia e volte.                         |
| `sandbox`  | Pede um token do GitHub App só para este repositório, lê a issue, cria o sandbox e clona o repositório.           |
| `build`    | O agente roda no sandbox, na branch `factory/<n>`, com o texto da issue como tarefa.                              |
| `push`     | Confere que houve mudança, faz o commit com a identidade do App e envia a branch (até três tentativas).           |
| `verify`   | Roda os checks exigidos (`npm test` por padrão) no commit enviado e grava cada resultado em `evidence`.           |
| `review`   | Um revisor independente lê o diff e dá um veredito, gravado em `review`. A fábrica soma fatos do diff.            |
| `waiting`  | O agente perguntou algo. A pergunta foi para a issue, o sandbox foi salvo e a task espera uma resposta.           |
| `pr`       | Se o portão abriu, cria o check run `aifactory/verify`, abre o PR contra `workspace`, mergeia e avança `develop`. |
| `done`     | Guarda o SHA, a URL do PR, a pré-release, o número de tentativas e o custo total (construtor e revisor).          |
| `released` | `develop` foi promovida para `main` e a release publicada, por um humano ou pelo veredito de um agente.           |
| `handoff`  | Sem aprovação e sem tentativas: abriu um PR em rascunho e comentou na issue. Uma pessoa assume daqui.             |
| `failed`   | Qualquer falha. O detalhe traz `failedAt` (o estágio) e `error` (o motivo).                                       |

Depois de um retrabalho, a task volta a `build` e repete `push`, `verify` e `review`: o histórico mostra cada tentativa.

O job `run-task` não tenta de novo sozinho (`maxAttempts: 1`): repetir gastaria o orçamento do
agente na mesma issue. Uma task que falha pelo próprio trabalho fica em `failed` para uma pessoa olhar.

A falha que passa sozinha volta a rodar pelo cron `retry-due`, a cada 5 minutos e no máximo 3 tasks por
passada, a que espera há mais tempo primeiro:

- Parada por cota: roda 1 minuto depois do instante em que a cota volta. A fábrica grava esse instante
  (`resumesAt`, em UTC) no momento da falha, a partir do horário que o agente escreveu e do fuso que ele
  usou; sem horário legível, espera 1 hora. Repete quantas vezes for preciso, porque esperar é o que
  resolve.
- Falha de ambiente (rede, GitHub, sandbox, reinício): espera 5, 10 e 20 minutos, e para depois da
  terceira vez. Aí vai para "Needs a person".
- Agente que usou todo o tempo da execução (25 minutos) não volta sozinho, mesmo que o texto diga "timed
  out": nada em volta falhou, e uma nova execução pararia no mesmo ponto gastando a mesma cota. Vai para
  "Needs a person", que divide a issue ou dá mais tempo. O timeout de um comando do ambiente (clone,
  instalação) continua sendo falha de ambiente.

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
| Primeira passada sem mudança, checks e revisor ok   | `done` sem PR: a issue é fechada com a evidência                                             |
| Primeira passada sem mudança, algo não confirma     | `failed` em `verify` ou `review`, com o motivo e o que o construtor disse                    |
| Cota do revisor esgotada                            | `failed` em `review` com `quota: true`                                                       |

**Issue que o código já resolve.** Quando o construtor não muda nada numa issue nova e diz que o código já
faz o que ela pede, a fábrica trata isso como uma alegação. Os checks rodam no commit de onde o run partiu
(sem check run no GitHub, porque o commit não é da fábrica), e o revisor recebe a issue e o que o
construtor disse, com a instrução de conferir no código e nos testes, sem confiar no texto. Se os dois
confirmam, a fábrica comenta na issue o commit, os checks que passaram, a conclusão do revisor e o que o
construtor encontrou, fecha a issue como concluída e marca a task `done`, sem PR (`resolved_sha` na
task). No painel ela aparece em Delivered como "already resolved" e não entra na caixa de entrada. Se os
checks falham, a issue fica aberta e a task vai para uma pessoa, com o motivo. Se o revisor aponta algo
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
uma branch protegida), a task não falha: o PR fica aberto para uma pessoa e o motivo fica no estágio
`done` (`integrationError`). Trabalho entregue a uma pessoa (`handoff`) nunca é mergeado pela fábrica.

**Pré-release.** Logo depois de integrar, a fábrica avança `develop` até o commit integrado e cria uma tag
`pre/<issue>-<sha7>` sobre ele, marcada como pré-release no GitHub. Nas notas vão os checks, o veredito do
review, as tentativas, o custo e o que o agente disse. Se o GitHub recusar o avanço de `develop` (uma branch
protegida que só aceita PR), a task continua integrada e a tag fica sobre o commit de `workspace`
(`developError` no estágio `done`). Nesse caso a fábrica abre, ou reaproveita, um PR de `workspace` para
`develop` (`developPullRequest`) e **só o abre**: quem o mergeia é quem as regras da branch pedirem. É um
PR só, e as integrações seguintes entram nele. Checks vermelhos não geram entrega, porque não há o que entregar.

**Release.** É a promoção de `develop` para a branch padrão: abre (ou reaproveita) um PR `develop → main` e
o mergeia, e publica uma release de verdade com a versão seguinte à da última (`v0.1.0` na primeira, e
`patch`, `minor` ou `major` escolhe o que sobe). Como é a promoção da branch, **tudo o que está em `develop`
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

O merge é fixado ao commit que a fábrica viu em `develop`. Se o merge acontece mas a release não pôde ser
criada, a task fica `released` com o erro registrado, porque o merge não se desfaz.

**A branch de release.** É a branch padrão do repositório, a não ser que o dono nomeie outra em "Branch a
release lands on". Um repositório cuja branch padrão é `develop` (os gateways do theokit) precisa nomear a
sua (`main`), porque `develop` é onde vai a pré-release e a fábrica se recusa a tratar a mesma branch como
pré-release e como release. As branches que faltam são criadas a partir da branch de release, e a promoção
abre o PR `develop → <branch de release>`.

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
  que a fábrica já integrou aparece como "integrated".
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

| Ação                  | Quando                                   | O que faz                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Aprovar               | task com PR (`done`, `handoff`)          | Grava a aprovação **presa ao commit** em que o PR está. Se a branch andar, a aprovação não cobre o commit novo.                                                                                                          |
| Pedir mudanças        | task com PR, com um texto                | Uma nova execução parte da branch que o agente já enviou, com o texto no prompt, e passa de novo por checks e review.                                                                                                    |
| Tentar de novo        | task `failed` ou `handoff`               | Apaga a branch (o que fecha o PR) e recomeça do zero.                                                                                                                                                                    |
| Marcar como resolvida | task `failed` ou `handoff`, com um texto | Para o que uma pessoa resolveu por outro caminho (à mão, ou dividindo a issue em outras já entregues). O texto diz onde. A task vai para Delivered, marcada como resolvida no commit em que a branch de integração está. |

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

1. **Setup.** A página lista o que falta: a GitHub App, o webhook, o segredo do webhook, o sandbox, ao
   menos um agente (Claude Code ou Codex) e um repositório habilitado. Cada linha diz o que está
   errado e leva à página que conserta. Nunca mostra um segredo, só se ele existe e o que o paga.
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

| Variável                                              | Para quê                                                |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `DATABASE_URL`                                        | Postgres do estado e da fila de jobs                    |
| `GITHUB_WEBHOOK_SECRET`                               | verifica a assinatura do webhook                        |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`                    | identidade do GitHub App                                |
| `GITHUB_APP_PRIVATE_KEY_PATH`                         | chave privada do App (arquivo em `.secrets/`)           |
| `ANTHROPIC_API_KEY` ou `CLAUDE_CODE_OAUTH_TOKEN`      | credencial do Claude Code                               |
| `FACTORY_CLAUDE_AUTH`                                 | `api-key` ou `subscription`, quando as duas existem     |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Vercel Sandbox, sem a validade de 12 horas do OIDC      |
| `VERCEL_OIDC_TOKEN`                                   | alternativa de desenvolvimento, de `vercel env pull`    |
| `OPENROUTER_API_KEY`, `FACTORY_CHAT_MODEL`            | o assistente do chat no OpenRouter                      |
| `FACTORY_CHAT_CODEX_MODEL`                            | o modelo do assistente na assinatura do ChatGPT         |
| `FACTORY_GUIDE_MODEL`                                 | o modelo dos guias de página (padrão gpt-4.1-mini)      |
| `FACTORY_JOBS=off`                                    | sobe uma prévia do painel sem pegar jobs da fila        |
| `FACTORY_KNOWLEDGE_DIR`                               | onde fica o espelho da base (padrão `.state/knowledge`) |

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
como texto.

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
