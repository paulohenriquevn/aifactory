# ADR 0007: a base de conhecimento é um bundle do Open Knowledge Format

Status: aceita (2026-11-07). Substitui, na [ADR 0006](0006-base-de-conhecimento-do-usuario.md), a decisão
sobre o formato (`aifactory-knowledge/1`). O resto da ADR 0006 continua valendo.

## Contexto

A ADR 0006 criou um formato próprio para a base: `MEMORY.md` com `format: aifactory-knowledge/1` no front
matter, um `INDEX.md` por projeto e notas com campos que só a fábrica entendia (`kind`, `date`,
`expires`). Nenhuma outra ferramenta lia esse formato, e a fábrica recusava um repositório sem `MEMORY.md`.

Em junho de 2026 o Google publicou o [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format)
(OKF), uma especificação aberta (Apache-2.0) para conhecimento lido por agentes e por pessoas. A versão
0.2 (lida no commit `ad30107`, de 2026-08-21) é uma pasta de markdown com front matter YAML. O único campo
obrigatório é `type`, `index.md` e `log.md` são nomes reservados, e há campos para o que uma base escrita
por agentes precisa:

- procedência (`sources`);
- quem escreveu e quem conferiu (`generated`, `verified`, com `human:<id>` para pessoas);
- níveis de confiança derivados (não verificado, confirmado por máquina, revisado por pessoa);
- ciclo de vida (`status`, `stale_after`).

O Knowledge Catalog do Google lê OKF, e a especificação traz um visualizador e bundles de exemplo.

## Decisão

- **As duas branches são bundles OKF 0.2.** A branch de regras do usuário tem um `index.md` na raiz com
  `okf_version: "0.2"`. A `factory-memory` também: um `index.md` na raiz com um item por projeto e, em
  cada `memory/projects/<owner>/<repo>/`, um `index.md` com as notas ainda válidas e um `log.md` com
  quando cada uma foi escrita.
- **Uma regra é `type: Rule`.** O lugar continua decidindo o peso: um arquivo em `knowledge/`, na branch
  do usuário, é instrução.
- **Uma nota é `type: Observation`**, com `status: draft`, sem `verified` (nível de confiança "não
  verificado"), `generated.by: aifactory/<versão>`, `stale_after` 180 dias depois e, em `sources`, a issue
  e o commit de onde veio. O que a fábrica precisa a mais fica numa chave própria, `aifactory`, como a
  especificação permite.
- **Produtor rígido, leitor tolerante**, como pede a seção 11 da especificação:
  - a fábrica só escreve arquivos conformes;
  - ela lê qualquer pasta de markdown, e um repositório sem `index.md` ou com arquivos sem front matter
    continua sendo entregue aos agentes;
  - o que não conforma aparece no Setup, conferido uma vez por commit das regras;
  - "Propor a estrutura" abre um PR que acrescenta o front matter que falta sem mudar nenhuma linha
    escrita pelo usuário, e lista o que só uma pessoa pode corrigir.
- **A fatia de cada run também é um bundle.** O `index.md` na raiz de `/tmp/knowledge` lista as regras e as
  notas, com os commits e o peso de cada parte nos títulos. Ele substitui o `GUIDE.md`.
- **O front matter é lido e escrito com a biblioteca `yaml`** (2.9.1, ISC). O OKF usa mapas e listas, e o
  `frontmatterValue` do TheoKit lê só valores simples, de propósito. Texto vindo de um agente só chega
  ao front matter pela biblioteca, que o escapa.

## Alternativas consideradas

- **Manter o `aifactory-knowledge/1`.** Sem custo, mas a base continuaria legível só pela fábrica.
- **Acrescentar campos OKF ao formato próprio.** Seriam dois contratos para manter, e a base ainda não
  seria um bundle OKF.

## Consequências

- Uma nota que vira regra tem um caminho no próprio padrão: um PR que a copia para `knowledge/` ou que
  acrescenta `verified` com um `human:<id>`. O curador que propõe isso ainda não existe.
- A especificação é nova, e a 0.2 já quebrou dois campos da 0.1 (`timestamp` e `# Citations`). Como a
  fábrica não recusa o que não entende e grava `okf_version`, uma versão nova da especificação muda o
  que ela escreve, não o que ela consegue ler. Uma 0.3 pede rever esta ADR.
- A migração do único repositório em uso (`usetheokit/knowledge`) foi um PR no repositório e a reescrita
  da `factory-memory`, que só tinha duas notas.
