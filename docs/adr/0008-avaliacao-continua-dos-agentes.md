# ADR 0008: os agentes são avaliados contra tarefas que a fábrica já entregou

Status: aceita (2026-11-11). Issue: #35.

## Contexto

O que a fábrica entrega depende de arquivos que mudam com frequência: os prompts do construtor e do revisor,
o harness de cada agente, o modelo e o esforço escolhidos no painel, as guardas do diff e a imagem do
sandbox. Até aqui, uma mudança nesses arquivos passava pelos testes de unidade, que usam agentes falsos, e ia
para produção. Se ela piorasse os agentes, o sinal só aparecia dias depois, em tarefas reais que falhavam ou
custavam mais, e ninguém sabia qual mudança tinha causado aquilo.

A fábrica já tem o que uma avaliação precisa. Cada tarefa entregue está no banco com o repositório, a
issue, o commit de que partiu, as checagens que a aceitaram, o custo e a duração. E o caminho de uma tarefa
(sandbox, construtor, checagens, guardas, revisor, retrabalho) é código que pode rodar sem empurrar nada.

## Alternativas

1. **Não ter suíte.** Custo zero, mas a regressão é descoberta em produção, misturada com tudo o que mudou
   desde o último deploy. Foi o que tivemos até agora.
2. **Um benchmark público (SWE-bench e parecidos).** Mede outra coisa: repositórios Python de terceiros,
   critérios que não são os nossos e nenhum dos nossos prompts de verificação. Cada caso custa tanto quanto
   um nosso, e o resultado não diz se a fábrica piorou nos repositórios em que trabalha.
3. **Rodar em sombra, em produção.** Cada tarefa real roda duas vezes, com a configuração atual e com a
   nova. Dobra o custo de toda tarefa, e só compara depois do deploy, que é tarde.
4. **Um juiz de modelo que lê o diff.** Mais barato que rodar as checagens, mas troca a evidência por uma
   opinião, e a fábrica não aceita trabalho só pela palavra de um agente (ADR 0001).
5. **Uma suíte nossa, feita de tarefas entregues, rodada pelo caminho da própria fábrica.** Escolhida.

## Decisão

- **Os casos vêm do banco.** `pnpm evals:cases` lê as tarefas entregues cuja última execução foi direto,
  sem retomada depois de uma pergunta (a resposta que a pessoa deu não pode ser dada de novo), e escreve
  `evals/cases.json`. Cada caso tem a issue como ela está hoje, o repositório, o commit de partida (o pai do
  primeiro commit que a fábrica empurrou) e as checagens que aceitaram o trabalho. A seleção alterna entre
  repositórios, deixa de fora execuções de mais de 35 minutos e execuções sem custo registrado, e marca
  como "rápidos" os casos mais curtos de cada repositório, também em alternância.
- **Um caso roda como uma tarefa.** O runner (`src/server/evals/run-case.ts`) usa os mesmos prompts,
  agentes, checagens, guardas e revisor da fábrica, com até três tentativas. Diferenças: o construtor não
  pode fazer perguntas, e um caso que pergunta falha. Nada sai do sandbox. O GitHub fica liberado na
  allowlist sem credencial, então o clone de um repositório público funciona e um push não tem como
  passar. O runner não chama push, não abre pull request e não grava estágio. Um teste confere que nenhum
  comando contém `push` ou `gh`.
- **Passou** quer dizer o mesmo que antes do merge na fábrica: as checagens passaram, o revisor aprovou e
  nenhuma guarda do diff bloqueou. O resultado não é comparado com o diff que a pessoa aceitou na época.
- **O que se mede**, por caso: passou ou não, o motivo, o custo informado pelos agentes, a duração, as
  tentativas e as rodadas de revisão. O sandbox entra no custo pela duração, ao preço do E2B para o tamanho
  da fábrica (4 vCPUs e 8 GiB, US$ 0,33 por hora, segundo a tabela de 2026-11-11).
- **A baseline fica versionada** em `evals/baseline.json`: o commit, a configuração dos agentes por
  repositório (agente, modelo e esforço de cada papel) e o resultado de cada caso. As rodadas ficam em
  `.evals/`, fora do git.
- **O portão roda no deploy.** `scripts/deploy.sh` chama `pnpm evals:check` antes do build. A checagem só
  roda casos quando algum arquivo da configuração dos agentes mudou desde o commit da baseline (a lista está
  em `src/server/evals/cases.ts`, mais tudo sob `src/server/agents/`), ou quando o agente, o modelo ou o
  esforço de algum papel não é mais o da baseline. Se nada mudou, não roda nada e não custa nada. Se
  mudou, roda os casos rápidos e compara só os casos que as duas rodadas têm em comum. O deploy para, sem
  build e sem restart, quando:
  - a taxa de aprovação cai mais de 20 pontos percentuais. Com 5 casos, um caso vale 20 pontos, então
    um caso que deixa de passar (um modelo erra por acaso) não bloqueia, e dois bloqueiam;
  - o custo médio por caso sobe mais de 25%.
- **Não roda no CI do GitHub.** Lá não estão o banco, as credenciais dos agentes nem a chave do E2B, e
  levá-las para um runner do GitHub é exatamente o que a fábrica evita. A máquina do deploy já tem tudo.
- **Teto de gasto.** Antes de começar cada caso, o runner soma o que os casos terminados custaram. Ao
  chegar em `EVALS_BUDGET_USD` (padrão US$ 15), não começa mais nenhum e lista os que ficaram de fora. Um
  caso que já está rodando termina, então o total pode passar do teto pelo custo dos casos em andamento
  (até `EVALS_CONCURRENCY`, padrão 2).

## Custo

A baseline foi medida em 2026-11-11, no commit `6385b0a`, com o construtor Claude Code (modelo padrão) e o
revisor Claude Code (Sonnet, esforço médio), como estava escolhido no painel:

| Caso                                      | Resultado | Custo dos agentes | Duração  | Tentativas |
| ----------------------------------------- | --------- | ----------------- | -------- | ---------- |
| `usetheokit/theokit-plugins#235`          | aprovado  | US$ 0,57          | 6,7 min  | 1          |
| `paulohenriquevn/aifactory-playground#61` | aprovado  | US$ 0,09          | 0,4 min  | 1          |
| `usetheokit/theokit-gateways#348`         | aprovado  | US$ 0,65          | 24,9 min | 2          |
| `usetheokit/theokit-sdk#975`              | aprovado  | US$ 0,33          | 10,9 min | 1          |
| `usetheokit/theokit#1685`                 | aprovado  | US$ 0,10          | 2,8 min  | 1          |

Cinco de cinco passaram. A rodada levou 32 minutos de relógio, dois casos por vez, e custou US$ 1,98: US$ 1,73
dos agentes e US$ 0,25 de sandbox. O custo dos agentes é o que o Claude Code informa (`total_cost_usd`), que
é o preço equivalente na API. Numa assinatura, ele mede consumo, não cobrança. Uma primeira tentativa, que
parou porque o runner ainda não aplicava a escolha do painel, custou US$ 0,01.

Então um deploy que muda a configuração dos agentes custa por volta de US$ 2 e meia hora a mais. O teto
padrão de US$ 15 cobre a suíte rápida com folga. Os 30 casos custariam por volta de US$ 12 se cada um
custasse o mesmo que os rápidos (US$ 0,40), mas os rápidos são justamente os mais curtos de cada
repositório, e a suíte inteira ainda não rodou.

## Consequências

- Uma mudança de prompt, harness, modelo ou imagem do sandbox passa a ter custo e tempo no deploy: os
  casos rápidos rodam em paralelo, dois a dois. Uma mudança em qualquer outro arquivo não muda nada.
- O resultado de um caso varia entre rodadas, porque os modelos não são determinísticos. Cinco casos
  detectam uma piora grande, não uma de poucos pontos. Para uma decisão fina (trocar de modelo, por
  exemplo), `EVALS_SET=all pnpm evals` roda os 30 casos.
- Quando um agente não informa custo (o Codex, que roda pela assinatura), o custo daquele papel conta como
  zero, e o portão de custo só enxerga o outro papel e o sandbox.
- A issue é lida como está hoje. Se alguém a editou depois da entrega, o caso pede outra coisa.
- Uma melhoria real muda a baseline. Ela é regravada com `EVALS_BASELINE=1 pnpm evals`, num commit que
  diz por quê.
