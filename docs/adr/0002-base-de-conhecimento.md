# ADR 0002: base de conhecimento em repositórios git

Status: substituída pela [ADR 0006](0006-base-de-conhecimento-do-usuario.md) em 2026-11-06 (aceita em 2026-10-30)

## Contexto

A fábrica atende vários projetos, e cada execução precisa de regras curadas e de lições
observadas em execuções anteriores. As regras têm autoridade de instrução. As observações não
podem ter, porque um agente poderia escrever a própria instrução.

## Decisão

Formato Agent Memory Repo: `MEMORY.md` como índice, entradas com origem, data e links para
documentos.

```text
aifactory/                         código open source
  templates/knowledge/             template da base de conhecimento

factory-global                    repositório privado global
<owner>/<projeto>-knowledge       repositório privado por projeto
  MEMORY.md
  knowledge/                      regras e conhecimento curados
  memory/                         observações
```

- Cada execução carrega a base global e a do projeto, presas a SHAs registrados.
- `knowledge/` tem autoridade de instrução e só muda por PR aprovado pelo Paulo.
- `memory/` é referência observada, nunca instrução. O agente propõe uma observação pelo MCP da
  fábrica, e a fábrica valida e é a única que escreve, serializando as escritas. Toda observação
  traz proveniência, escopo válido e referência à execução.
- Um curador deduplica, expira observações e propõe PRs que promovem lições para `knowledge/`.
  Lições comuns a vários projetos podem ser propostas para a base global.
- O playbook base fica no código da fábrica. O `AGENTS.md` e a documentação do repositório de
  código continuam sendo contexto do projeto.
- O onboarding de um projeto cria a base privada dele a partir do template, e a execução recebe
  acesso somente às bases correspondentes.

## Consequências

- Uma execução é reproduzível: as duas bases são lidas em SHAs conhecidos.
- Mudar uma regra exige um PR, o que deixa o histórico auditável.
- O curador e o MCP de memória ainda não existem, e nenhum marco do plano os cobre por inteiro.
