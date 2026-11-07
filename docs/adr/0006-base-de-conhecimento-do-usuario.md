# ADR 0006: a base de conhecimento é um repositório do usuário, lido por todos os agentes

Status: aceita (2026-11-06). Substitui a [ADR 0002](0002-base-de-conhecimento.md). O formato
(`aifactory-knowledge/1`) foi substituído pelo Open Knowledge Format na
[ADR 0007](0007-base-de-conhecimento-em-okf.md).

## Contexto

A ADR 0002 previa duas bases da própria fábrica: um repositório global (`factory-global`) e um por
projeto (`<projeto>-knowledge`), criados a partir de um template. Nada disso chegou a ser construído. Até
aqui, um agente sabia o que estava no prompt fixo, no `AGENTS.md` do projeto e no texto da issue, e
nenhum run deixava algo para o seguinte. Isso aparecia no quadro: 13 tasks falharam com o agente dizendo
que a issue já estava resolvida, e cada run redescobriu isso do zero.

A fábrica é um produto que outra pessoa instala. A base pertence a quem usa, e cada agente da fábrica
lia, ou deixava de ler, a seu modo.

## Decisão

- **Um repositório só, escolhido pelo usuário** na página Setup (`owner/repo` e, se quiser, a branch das
  regras). A fábrica não tem repositório de conhecimento próprio. Sem escolha, tudo funciona como antes.
- **Formato `aifactory-knowledge/1`**, um contrato público descrito em `templates/knowledge/README.md`:
  `MEMORY.md` com o formato no front matter, `knowledge/global/` e `knowledge/projects/<owner>/<repo>/`.
  Quando o repositório não está no formato, a fábrica propõe a estrutura por pull request e não escreve
  na branch do usuário.
- **Duas camadas com pesos diferentes.** `knowledge/`, na branch do usuário, são regras e valem como
  instrução; só mudam por PR que o usuário aprova. `memory/`, na branch `factory-memory`, são notas que a
  fábrica observou; servem de referência e nunca de instrução. Só a fábrica escreve `factory-memory`.
- **Um fetch por minuto, no host.** O cron `knowledge-sync` mantém um espelho bare em `.state/knowledge`
  (ou `FACTORY_KNOWLEDGE_DIR`) e grava as notas pendentes como um commit em `factory-memory`, só por
  fast-forward. Roda só no processo principal e em série, então há um escritor só.
- **O mesmo acesso para todos os agentes**, como parte do que um agente é:
  - no sandbox (builder, revisor e planner), a fábrica copia para `/tmp/knowledge` a parte global e a do
    projeto, antes do agente começar e de novo a cada minuto em que a base muda. O sandbox não busca nada
    e não recebe credencial da base, e um projeto não vê a pasta de outro. Cada cópia fica registrada em
    `knowledge_delivery` com os commits, e o estágio `build` guarda o pin inicial;
  - no painel, todo assistente é construído por `buildAssistant`, que dá a ele `knowledge_search` e
    `knowledge_read` sobre o espelho;
  - os prompts dizem o mesmo texto (`knowledge/prompt.ts`). Um teste (`every-agent.test.ts`) falha se um
    agente novo nascer sem a base.
- **De onde vêm as notas:** as linhas `LEARNED:` que o builder deixa no resumo final (até cinco, curtas) e
  o veredito de um run que não encontrou nada a mudar numa issue. A mesma nota num projeto é guardada uma
  vez, e uma nota deixa de ser listada 180 dias depois de escrita.

## Consequências

- Uma regra nova vale em até um minuto, inclusive num run em andamento. O preço é que um run longo pode
  ler versões diferentes da base; o registro de cada entrega mantém isso auditável.
- O dono revisa o que vira regra: uma nota só vira instrução quando alguém a copia para `knowledge/` por
  PR.
- Texto de nota vem de agente e de issue, então pode carregar uma tentativa de prompt injection. Por isso
  a camada `memory/` é dita referência em todo prompt e fica numa branch separada.
- O curador que deduplicaria notas e proporia promovê-las a regra ainda não existe.
