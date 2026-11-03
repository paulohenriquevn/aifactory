# TheoKit 0.76.1 — conclusão das pendências da fábrica

Verificação em 2026-10-31. Este registro cobre o lote encontrado ao construir a
aifactory, não todas as issues do ecossistema TheoKit.

## Publicação

- [PR de versão #1058](https://github.com/usetheokit/theokit/pull/1058), mergeado
  em `main` no commit `523d521a207a29fe3b94d5dddcb5ce469007529c`.
- [Workflow Release](https://github.com/usetheokit/theokit/actions/runs/41218024280)
  concluído com sucesso.
- [theokit@0.76.1](https://github.com/usetheokit/theokit/releases/tag/theokit%400.76.1)
  e [create-theokit@3.0.21](https://github.com/usetheokit/theokit/releases/tag/create-theokit%403.0.21)
  publicados no GitHub e confirmados no npm. A 0.76.1 tem atestado de proveniência.
- Ambas as tags são anotadas e apontam para commits presentes em `main`.
- Sincronização com `workspace` concluída no commit `759cab3d`, preservando o
  trabalho em andamento. O [PR #1059](https://github.com/usetheokit/theokit/pull/1059)
  sincronizou as versões com `develop`, com todos os checks verdes, no merge
  `82923fb9c6866e8fda49431988b3ab8c13af676d`.

## Validação dos pacotes publicados

As verificações usaram um consumidor novo, sem links para o workspace do
framework, com Node 22, `pg@8.23.1`, `db0@0.3.4` e PostgreSQL 17 real.

| Issue                                                      | Evidência                                                                                                                                                                                                                                       | Resultado            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| [#1031](https://github.com/usetheokit/theokit/issues/1031) | Os 11 geradores escreveram sob `web`, `backend` e `backend/agents`, conforme a configuração. O agente inclui policy provisória; config inválida recusa sem criar arquivos                                                                       | Verificada e fechada |
| [#1038](https://github.com/usetheokit/theokit/issues/1038) | Resource sem `db/index` recusa com caminho e exemplo do driver, tanto em SQLite quanto PostgreSQL, sem alterar schema ou criar rotas                                                                                                            | Verificada e fechada |
| [#1037](https://github.com/usetheokit/theokit/issues/1037) | Backend de jobs e lock de cron registram `57P01`, sobrevivem e reconectam. Listener do usuário é preservado. Duas réplicas reais de `theokit start` sobreviveram ao encerramento de conexões ociosas, responderam 200 e processaram um novo job | Verificada e fechada |
| [#1051](https://github.com/usetheokit/theokit/issues/1051) | Encerrar a conexão do db0 produz aviso estruturado com nome do banco e `57P01`; o processo continua vivo                                                                                                                                        | Verificada e fechada |

O scaffold `--bare` de `create-theokit@3.0.21` instala a versão corrigida, passa
typecheck e seu teste de página. O build do consumidor com job PostgreSQL também
passou.

A limitação do db0 permanece explícita: o cliente encerrado não reconecta;
consultas seguintes rejeitam até reiniciar. Para reconexão, usar o pool de
`usePostgres`. A #1051 tratava da queda do processo.

As 19 issues anteriores do framework (#1008–#1025 e #1029) e as cinco de
ORM/plugins (`theokit-di` #75/#76; `theokit-plugins` #225/#226/#231) já estavam
fechadas, conforme conferência no GitHub.

## Observação adicional

A auditoria npm do scaffold apontou advisories nas dependências de Vitest 3 e
tinypool. `npm explain` mostrou Vitest como dependência de desenvolvimento e peer
opcional de `@theokit/sdk-tools`. Essa observação é separada das quatro correções
acima; este registro não declara a árvore de dependências livre de advisories.

## Retomada da aifactory

A publicação remove a pendência de release do framework. A fábrica ainda precisa
atualizar sua dependência e integrar storage/jobs pelo TheoKit, conforme o M0 do
[plano](PLAN.md). Nenhum código de execução da fábrica foi alterado nesta entrega.
