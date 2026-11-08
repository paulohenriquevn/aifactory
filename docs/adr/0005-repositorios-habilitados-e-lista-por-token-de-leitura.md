# ADR 0005: repositórios habilitados e a lista por um token só de leitura

Status: aceita (2026-11-04)

## Contexto

A GitHub App está instalada em todos os repositórios da conta (ADR 0004). Com isso, qualquer issue com a
label `factory` em qualquer um deles criava uma task e gastava dinheiro. Para o dono usar a fábrica por
uma interface, o painel também precisa listar o que a App alcança, e o ADR 0004 diz que o único token que
a fábrica pede é o de um repositório.

## Decisão

1. Alcançar um repositório não é licença. Uma issue só vira task num repositório que o dono habilitou no
   painel (`repository.enabled`). Nos outros, a entrega é gravada em `ingress` com o código
   `repository_disabled` e nenhuma task nasce. O nome é comparado sem diferenciar maiúsculas, como o
   GitHub faz.
2. Listar os repositórios que a App alcança é a única exceção à regra de que um token nomeia um
   repositório. `installationRepositories()` pede um token de instalação sem a lista de repositórios, mas
   com a permissão `metadata: read` e nenhuma outra. Esse token só lê nomes, visibilidade e branch
   padrão, não é guardado e nunca escreve. A lista é guardada por 15 segundos, porque é lida página a
   página.
3. Só um repositório que a App alcança pode ser habilitado, então a lista também é o limite do que a
   fábrica pode apontar.
4. Os ajustes por projeto (checks, domínios extras do sandbox, agentes, modo de release) vêm do painel e
   do banco, nunca de um arquivo do repositório. Um arquivo da branch do agente deixaria o agente
   ampliar a própria saída de rede.

## Consequências

- Um repositório novo na conta não faz nada até o dono habilitá-lo. Quem esperava que "a App está
  instalada" bastasse precisa de um clique a mais, e a página Setup diz isso.
- O token de leitura vê os 100 ou mais repositórios da conta por um instante. Ele não escreve, e a
  permissão `metadata: read` já faz parte da App.
- Domínios extras são ampliação de saída de rede, então são decisão do dono, num campo do painel, e não
  de um agente.
