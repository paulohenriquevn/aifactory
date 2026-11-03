# ADR 0001: arquitetura da fábrica

Status: aceita (2026-10-30)

## Contexto

A aifactory transforma issues do GitHub em pull requests verificadas. Quem escreve o código é um
agente de programação, e um agente que certifica o próprio trabalho não serve como evidência.
O projeto também é dogfooding do TheoKit, framework do mesmo autor.

## Decisão

- Fonte: GitHub Issues primeiro. Linear entra depois, por um adapter.
- Executor: um CLI externo atrás de uma interface `CodingHarness`. Claude Code headless vem
  primeiro, Codex depois.
- Isolamento: um `SandboxProvider` na nuvem. Sem isolamento a execução é recusada, e ambiente
  e acesso de saída usam allowlists (ver [ADR 0003](0003-sandbox.md)).
- Fluxo: webhook com assinatura e deduplicação por delivery ID, depois PostgreSQL
  (ingress e task), política de transição, jobs persistidos, execução no sandbox, checks
  executados pela fábrica no SHA, review independente e somente leitura no mesmo SHA, PR a partir
  do SHA aprovado, política de merge (`off`, `trial` ou `auto`) e vigia pós-merge que abre PR de
  revert se a `main` quebrar.
- Princípios: o agente não certifica o próprio trabalho, a fábrica executa os checks.
  Evidência, review e merge se referem ao SHA correspondente. Toda decisão vai para o audit log.
- TheoKit: a dependência vem do npm publicado, sem link para um checkout local. Antes de
  adicionar uma biblioteca ou um mecanismo próprio, verifica-se o que o framework já oferece. Uma
  lacuna vira issue no repositório do TheoKit antes de qualquer contorno, e o contorno cita a
  issue.
- Commits: nunca incluem coautoria.

## Consequências

- O estado de cada execução mora no PostgreSQL, e o painel lê dele.
- A conexão com o banco usa o `StorageManager` do TheoKit, e as filas usam o backend de jobs do
  framework.
- A interação entre `.approval(...)` nas ferramentas com efeito externo e o modo de merge `auto`
  precisa ser definida antes do M6.
