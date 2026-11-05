# Plano da aifactory

Plano recuperado em 2026-10-31 da sessão de arquitetura iniciada em 2026-10-30.
Este documento reúne as decisões acordadas, os marcos propostos e o ponto de
retomada. Relatos de releases externas não equivalem a uma verificação atual.

## Objetivo

Transformar issues do GitHub em pull requests verificadas, usando agentes de
programação em sandboxes na nuvem. A ferramenta é pessoal, open source e
single-tenant, com suporte a vários projetos.

## Decisões acordadas

- GitHub Issues é a fonte inicial; Linear entra depois por adapter.
- O executor é um CLI externo atrás de uma interface `CodingHarness`. Claude Code e
  Codex são suportados desde o início; o desenho deve aceitar outros assistentes de
  código sem mexer no orquestrador (seção "Agentes de código e autenticação").
- Cada agente paga com uma chave de API ou com a assinatura do dono (Paulo aceitou o
  risco em 2026-11-04). Em qualquer dos modos o segredo fica com a fábrica e o
  firewall do sandbox o injeta; só um fallback documentado coloca um token dentro.
- O isolamento é fornecido por um `SandboxProvider` na nuvem. Sem isolamento, a
  execução é recusada; ambiente e acesso de saída usam allowlists.
- A dependência do TheoKit vem do npm publicado, sem link para o checkout local.
- Usar o máximo possível do TheoKit: verificar funcionalidades e pacotes do
  framework antes de adicionar bibliotecas ou mecanismos próprios. Lacunas devem
  ser registradas no framework antes de adotar um contorno documentado.
- A fábrica entrega por **pré-release**: é ela que faz a entrega, e pode gerar uma pré-release sempre,
  sem pedir licença a ninguém (decisão do Paulo em 2026-11-04). Uma pré-release é uma tag, marcada
  como pré-release no GitHub, sobre o commit com a evidência que o sustenta, e não mexe na branch
  padrão. A **release** (o merge e a versão final) é a promoção desse trabalho e é gerada por agentes
  ou por humanos, nunca como efeito colateral da entrega.
- Commits nunca incluem coautoria.

## Arquitetura planejada

```text
GitHub: issue com label factory
  → webhook TheoKit: assinatura + deduplicação por delivery ID
  → PostgreSQL: ingress → task
  → política de transição: aceita ou recusa com código e motivo
  → jobs persistidos: idempotência, lease, backoff e limite de concorrência
  → SandboxProvider → CodingHarness
  → estágios reportados pelo MCP da fábrica
  → fábrica executa checks no SHA e registra evidências + check run
  → review independente, somente leitura, no mesmo SHA
  → PR a partir do SHA aprovado
  → política de merge: off / trial / auto
  → vigia pós-merge → PR de revert se a main quebrar

Painel TheoKit: board, timeline, custos, evidências e inbox
```

Princípios:

- O agente não certifica o próprio trabalho: a fábrica executa os checks.
- Evidência, review e merge devem se referir ao SHA correspondente.
- Toda decisão deve ser registrada no audit log.
- Ausência de isolamento impede a execução.

## Marcos e critérios de aceite

Os marcos abaixo recuperam a proposta da sessão; os estados refletem o código
local inspecionado em 2026-11-03.

| Marco | Entrega                                                        | Critério de aceite                                                                                                                                                                                   | Estado       |
| ----- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| M0    | Fundação: TheoKit, PostgreSQL, Drizzle, CI, branch `workspace` | CI executa `theokit check` e testes, com resultado verde                                                                                                                                             | Concluído    |
| M1    | Ingestão                                                       | Uma issue com label `factory` gera exatamente uma task em `intake`; repetir o delivery não duplica                                                                                                   | Concluído    |
| M2    | Execução                                                       | Uma task de repositório de teste envia a branch `factory/<n>` e registra os estágios em ordem em `stage_event`                                                                                       | Concluído    |
| M3    | Evidência + PR                                                 | PR só abre com evidência verde no head SHA; teste demonstra que uma declaração do agente sem evidência não abre PR                                                                                   | Concluído    |
| M3b   | Vários agentes de código                                       | Claude Code e Codex rodam a mesma task pelo mesmo `CodingHarness`, por chave ou assinatura, com o segredo fora do sandbox; trocar o agente é configuração                                            | Concluído    |
| M4a   | Review independente + rodadas                                  | Checks vermelhos ou review que pede mudanças devolvem o trabalho à mesma sessão do agente; após três tentativas, PR em rascunho e comentário na issue; um PR só abre com evidência verde e aprovação | Concluído    |
| M4b   | `waiting`                                                      | Pergunta do agente vira comentário na issue e a resposta de uma pessoa retoma a mesma sessão, num sandbox restaurado de snapshot                                                                     | Concluído    |
| M5    | Painel + inbox                                                 | Board, timeline, custo e evidência em tempo real via SSE; aprovar, pedir mudanças e tentar novamente pelo painel (local, com um dono)                                                                | Concluído    |
| M6a   | Pré-release e release                                          | A fábrica gera uma pré-release para todo commit com checks verdes que chegou a um PR; um humano (painel) ou um agente (modo `auto`) promove a release, com o merge preso ao SHA entregue             | Concluído    |
| M6b   | Vigia da `main`                                                | Depois de um release, uma `main` vermelha gera um PR de revert (nunca um merge sozinho)                                                                                                              | Concluído    |
| M7    | Saúde e qualidade                                              | Custo por execução, achados tipados do supervisor como `stalled` e `orphaned`, gates CRAP, duplicação e mutação                                                                                      | Concluído    |
| M8    | Operação contínua                                              | A fábrica volta sozinha depois de um reboot, recupera webhooks perdidos e tem backup restaurável do banco                                                                                            | Concluído    |
| M9    | Painel com os componentes do TheoKit UI                        | O painel usa `@usetheo/ui` e `@theokit/ui`, com quadro e lista, painel lateral e tela cheia                                                                                                          | Concluído    |
| M10   | Repositórios e configurações                                   | Só repositórios habilitados geram task; agentes, checks, domínios e release por repositório; primeiro projeto real                                                                                   | Não iniciado |
| M11   | Novo job pelo painel                                           | O painel abre a issue com a label e a task nasce pelo caminho normal do webhook                                                                                                                      | Não iniciado |
| M12   | Transcrição ao vivo                                            | O painel mostra o que o agente faz enquanto faz, e o transcript fica gravado                                                                                                                         | Não iniciado |
| M13   | Conversa com os agentes                                        | O Paulo escreve para a instância que está implementando, ou para uma que parou, pelo painel                                                                                                          | Não iniciado |
| M14   | Painel acessível de fora                                       | O painel abre fora desta máquina, atrás de um acesso próprio, sem abrir o resto                                                                                                                      | Não iniciado |

As aprovações de ferramentas com efeitos externos seguem a convenção do
`AGENTS.md`. A interação com o modo `auto` ficou definida pelo conceito de pré-release: o que a
fábrica faz sem licença (a pré-release) não mexe na branch padrão, e o que mexe (o release) só começa
por um humano ou por um veredito de agente no modo `auto`, que é opt-in e vem desligado.

## Próximos marcos: operação, repositórios, painel e conversa

Pedido do Paulo em 2026-11-04, depois de comparar o painel com o do `marshal-factory`: um painel mais
completo, feito com os componentes do TheoKit UI, e a possibilidade de **conversar com os agentes pelo
sistema**, por exemplo com a instância que está implementando. Os marcos M8 a M14 cobrem isso, mais o que
faltava para usar a fábrica de verdade (rodar sempre ligada, vários repositórios).

### O que já se sabe (observado em 2026-11-04)

- A GitHub App `aifactory-paulohenriquevn` tem o webhook ativo em `factory.aquim.ai`, evento `issues`, e
  está instalada em todos os repositórios da conta. Qualquer repositório da conta já entrega eventos; o
  webhook por repositório do playground é redundante (a regra de uma task por issue impede a segunda).
  Isso corrige o que o README dizia sobre configurar um webhook por repositório.
- Não existe lista de repositórios habilitados. Hoje a label `factory` em qualquer repositório da conta
  cria uma task e gasta dinheiro. Só quem tem permissão de triagem consegue rotular, mas o M10 fecha isso.
- O agente roda como `claude -p --output-format json` ou `codex exec`, por um `execute` que bloqueia até o
  fim. A fábrica só vê o resultado final: nada do que o agente faz no meio é visível nem alcançável.
- O Vercel Sandbox aceita comando destacado (`detached`), leitura dos logs em fluxo e escrita no stdin do
  processo. O `SandboxBackend` do TheoKit expõe só `execute` e `uploadFile`. Isso é uma lacuna do
  framework: vira issue em `usetheokit/theokit` antes do contorno, e o contorno é uma capacidade opcional
  do `IsolatedSandbox`, como já é o `snapshot`.
- O Claude Code tem `--input-format stream-json`, `--output-format stream-json`,
  `--include-partial-messages`, `--replay-user-messages`, `--resume` e `--fork-session`. O Codex tem
  `codex exec --json`, `codex exec resume` e `app-server` (experimental). Nenhum foi exercitado dentro do
  sandbox ainda: são os spikes S1 a S3 abaixo.

### Ordem

M8 e M9 são independentes e podem andar juntos. M10 e M11 usam o M9, para não escrever as páginas novas
duas vezes. M12 precede M13, porque conversar com uma instância exige ver o que ela faz e ter um canal
até o processo. M14 vem por último de propósito: com a conversa, o painel passa a poder mandar agentes
com shell trabalharem, e o acesso de fora só abre depois de esse poder estar testado.

### M8: operação contínua

Serviços `systemd --user` para o servidor e para o `cloudflared`, `linger` ligado para subirem sem
login, e o Postgres com `restart: unless-stopped`. Isso muda a máquina do Paulo, então começa só com o OK
dele (ainda não dado).

Webhook perdido: um cron lê as entregas da App (`GET /app/hook/deliveries`) e reentrega as que falharam
enquanto a fábrica estava fora (`POST .../attempts`). Backup: `pg_dump` diário em `~/backups/aifactory/`,
modo 600, guardando os últimos 14.

Critérios de aceite:

- Depois de reiniciar a máquina sem abrir sessão, `GET https://factory.aquim.ai/api/health` responde 200 sem
  nenhuma ação manual.
- Com o servidor parado, rotular uma issue e subir o servidor cria a task, uma só, sem nova ação.
- Restaurar o dump mais recente num banco vazio devolve o mesmo `count(*)` de `task`, `evidence` e
  `stage_event` que o banco de origem (um script de restauração roda isso).
- Um dump de mais de 14 dias é removido, e um mais novo não.

### M9: painel com os componentes do TheoKit UI

`@usetheo/ui` traz a estrutura (shell, navegação, tabela, diálogo, abas, aviso, estado vazio) e
`@theokit/ui` traz as peças de agente (`RunStatusPill`, `AgentTimeline`, `ApprovalCard`, `ChatThread`,
`ChatComposer`). Hoje o `@theokit/ui` só está instalado porque o Tailwind do TheoKit depende dele: nenhuma
tela usa um componente. O M9 troca o Tailwind escrito à mão pelos componentes, com o tema da biblioteca, e
acrescenta o que o painel do `marshal-factory` tem de útil: quadro ou lista, painel lateral da task com
tela cheia e filtro por repositório (o filtro só ganha opções no M10).

Critérios de aceite:

- Os testes de interface de hoje passam sem mudar uma asserção de comportamento.
- Alternar para a lista mostra as mesmas tasks do quadro, e a escolha continua depois de recarregar.
- Abrir uma task com `?full=1` mostra o detalhe em tela cheia, e Esc volta ao quadro.
- Os pares de cor que o painel escreve à mão passam em 4,5 de contraste (3 para texto sobre um controle
  preenchido), nos modos claro e escuro. A auditoria da própria biblioteca não cobre esses pares
  (`muted-foreground` sobre o cartão, `destructive`, links), então o teste mede os que o painel usa.

### M10: repositórios e configurações

Tabela `repository` com o nome completo (único), se está habilitado (começa desabilitado), nome de
exibição, agente construtor e revisor padrão, modo de release, checks, domínios extras de saída e tempos
limite. Uma entrega de repositório desabilitado é gravada em `ingress` com o código `repository_disabled`
e não cria task.

Receita `.factory/setup.json`, com o comando de instalação, os checks e os domínios de saída que o projeto
pede. Ela é lida **da branch padrão**, nunca da branch do agente, para o agente não ampliar a própria saída
editando o arquivo. Os domínios da receita só valem depois de aprovados no painel, que mostra a diferença
em relação ao que já estava liberado. A precedência é: painel, depois receita, depois o padrão de hoje
(`npm test`, `github.com`, `registry.npmjs.org` e o domínio do agente). As labels `harness:` e `reviewer:`
continuam vencendo o padrão do repositório, que vence o global.

Para listar os repositórios que a App alcança, o painel precisa de um token de instalação sem a restrição
de repositório. Isso afrouxa a regra de que `installationToken(repo)` sempre nomeia um repositório. A saída
é uma função separada, `installationRepositories()`, que pede um token só com `metadata: read`, usado só
para listar e nunca para escrever, e um ADR curto que registra a exceção.

Páginas: Repositories (lista, detalhe, habilitar, agentes, release, checks e domínios) e Settings (padrões
globais, o modo de cada credencial dos agentes e quando o token do Codex vence).

Critérios de aceite:

- Rotular uma issue num repositório desabilitado não cria task, e a entrega aparece em `ingress` com
  `repository_disabled`.
- Habilitar o repositório no painel e rotular de novo cria uma task, uma só.
- Uma receita que pede um domínio novo roda sem acesso a ele até a aprovação, e com acesso depois (teste ao
  vivo contra um domínio de teste).
- Mudar `.factory/setup.json` na branch do agente não muda os domínios do sandbox daquela execução.
- Dois repositórios, um em `manual` e outro em `auto`, respeitam cada um o seu modo na mesma hora.
- O Paulo escolhe um projeto dele, com testes, e uma issue real vira PR com checks verdes. O resultado e
  tudo o que falhar nessa execução entram neste plano.
- O webhook do repositório do playground é removido, e o README descreve o webhook da App.

### M11: novo job pelo painel

Formulário com repositório (só os habilitados), título, descrição e, opcionalmente, agente e revisor. O
painel abre a issue pela App (a permissão `issues: write` já existe), com a label `factory` e as labels
`harness:` e `reviewer:` quando escolhidas. A task nasce pelo webhook da própria issue, o mesmo caminho de
qualquer outra, e não por um atalho. Imagens ficam de fora até alguém precisar delas.

Critérios de aceite:

- Enviar o formulário cria uma issue com a label e uma task, e a task vem do webhook, não do painel.
- Se a API do GitHub recusar, o formulário mostra o motivo e nenhuma task fica criada.
- Um repositório desabilitado não aparece na lista do formulário.
- O corpo da issue diz que foi aberta pelo painel.

### M12: transcrição ao vivo

É a base da conversa: o painel passa a mostrar o que o agente faz enquanto faz, e a fábrica ganha um canal
até o processo do agente.

Spike S1, antes de qualquer código: no Vercel Sandbox, rodar o Claude Code em comando destacado com
`--output-format stream-json --verbose`, ler os logs em fluxo do lado da fábrica e provar que os eventos
chegam antes de o processo terminar, em ordem, com o `session_id` já no primeiro. O mesmo para
`codex exec --json`. Se algum dos dois não entrega, o desenho muda e este marco é reescrito antes de
seguir.

Entrega: a capacidade opcional `spawn` no `IsolatedSandbox` (comando destacado com leitura de logs em
fluxo, escrita no stdin, espera e interrupção), implementada no adapter da Vercel, mais uma issue no
TheoKit pedindo isso no `SandboxBackend`. O `CodingHarness` passa a aceitar um `onEvent`, e cada harness
traduz o seu fluxo para um `AgentEvent` nosso: mensagem do agente, uso de ferramenta (nome e entrada
resumida), resultado da ferramenta (truncado), custo parcial e erro. A tabela `agent_event` guarda a
sequência (task, execução, ordem, tipo, conteúdo truncado, hora) e o SSE do painel a repassa. O resultado
final continua saindo do evento de resultado, então o custo e o estado da task não mudam.

O sandbox não guarda segredos (o firewall injeta as credenciais), mas a saída de um comando pode ter um.
O transcript passa por um filtro que troca os formatos de token conhecidos (`ghs_`, `sk-ant-`, `sk-proj-`,
`vcp_`) antes de gravar e antes de exibir.

Critérios de aceite:

- Numa execução real, o painel mostra o primeiro evento do agente antes de o agente terminar (o teste ao
  vivo compara a hora do primeiro evento exibido com a do fim da execução).
- Reabrir a task depois do fim mostra a mesma sequência de eventos que foi vista ao vivo.
- Os testes de integração de hoje passam sem mudar uma asserção, com o mesmo custo e o mesmo estágio final.
- Um token plantado na saída de um comando do agente de teste não aparece em `agent_event` nem na resposta
  do painel.
- O SSE de uma task com mais de 5 mil eventos entrega só os novos depois da primeira carga (teste com
  eventos gerados).

### M13: conversa com os agentes

O Paulo escreve para um agente pelo painel. Há dois casos, e eles têm mecânicas diferentes.

**Falar com a instância que está trabalhando.** A mensagem chega ao processo do builder (ou do reviewer)
enquanto ele roda. Há três caminhos, e o spike S2 escolhe, no sandbox real, com Claude e com Codex:

- Pelo stdin, com `--input-format stream-json`: o Claude Code enfileira a mensagem e a trata na virada
  seguinte, sem perder o passo em andamento.
- Por uma caixa de correio em arquivo, lida por um hook (`PostToolUse` ou `UserPromptSubmit`) que injeta o
  conteúdo no contexto: não precisa de stdin, mas depende de hooks dentro do sandbox.
- Interromper e retomar: a fábrica mata o processo e roda `--resume` com a mensagem. Sempre funciona, mas
  perde o passo em andamento.

O padrão previsto é o stdin onde existir, e interromper e retomar como alternativa e como o botão
Interromper. Não verificado: o `codex exec` aceitar entrada depois de iniciado. O `app-server` é
experimental. Para o Codex o mais provável é interromper e retomar, e então a interface diz que a mensagem
interrompe o passo atual. O resultado do S2 vai para um ADR.

**Falar com uma instância que parou** (`waiting`, `handoff`, `done` ou `failed`). A fábrica retoma a mesma
sessão com a mensagem. O obstáculo é que o sandbox já parou e a sessão do CLI estava dentro dele. A saída é
copiar o arquivo da sessão para o banco (`agent_session`) no fim de cada execução, e restaurá-lo num
sandbox novo, clonado da branch, antes do `resume`. Um snapshot por task, a alternativa, pesa uns 820 MB e
já estourou o plano Hobby uma vez; só o `waiting` continua usando snapshot. O spike S3 prova que o
`claude --resume <id>` num sandbox novo com o arquivo restaurado continua a conversa, e faz o mesmo para
`codex exec resume <id>` com a pasta de sessões do Codex.

**Dois modos de mensagem**, escolhidos no compositor:

- Perguntar: o agente responde e não altera o repositório. Previsto: Claude com `--permission-mode plan`
  e Codex com `--sandbox read-only`. Não verificado que isso impeça toda escrita; o S2 testa e, se não
  impedir, a garantia vira uma checagem do SHA da branch depois da resposta.
- Orientar: o agente pode mudar o código, e qualquer mudança segue o caminho normal: commit, push, checks,
  revisão e PR. Numa task `done` ou `handoff`, a mensagem a leva de volta a `build` com um evento
  `conversa`, e o laço de hoje assume daí. Uma mensagem do dono não gasta uma das três tentativas do laço:
  abre uma rodada própria.

**Regras que não mudam com a conversa:**

- Uma mensagem nunca pula o portão. Tudo o que muda o repositório passa por verificação e revisão no commit
  novo, e a conversa não aprova nada.
- Só o dono escreve, pelo painel e com o cabeçalho `X-Theo-Action`. Cada mensagem fica gravada
  (`agent_message`: autor, hora, texto, modo e entrega: pendente, entregue ou falhou).
- Uma instância tem um escritor por vez. Duas mensagens seguidas entram em fila e são entregues em ordem,
  e a segunda não abre outro processo na mesma sessão.
- O custo da conversa entra na task e em `agent_run`, marcado como conversa, e aparece em Health.
- O texto do dono chega ao agente por arquivo ou stdin, nunca por um shell, como o texto de uma issue.
- Uma mensagem não amplia a saída do sandbox nem o tempo da execução.

**Interface.** O detalhe da task ganha uma aba Conversa, com `ChatThread` e `ChatComposer` do
`@theokit/ui`: mostra o transcript do M12 com as mensagens do Paulo no meio, o estado da instância
(trabalhando, parada, esperando você), o botão Interromper, o seletor Perguntar ou Orientar, e uma aba
para o builder e outra para o reviewer. A pergunta de uma task em `waiting` pode ser respondida no mesmo
compositor, além de pelo comentário na issue; a primeira resposta vence.

Critérios de aceite:

- Com o Claude real trabalhando, uma mensagem pelo painel pedindo um nome diferente de função aparece no
  transcript como entregue, e o commit final exporta o nome pedido (teste ao vivo com uma instrução que o
  arquivo prova).
- "Perguntar" a uma task em `done` traz uma resposta no transcript, e o SHA da branch no GitHub é o mesmo
  antes e depois.
- "Orientar" numa task em `done` gera um commit novo, que passa pelos checks e pela revisão, atualiza o PR e
  devolve a task a `done`.
- Duas mensagens enviadas ao mesmo tempo são entregues em ordem, e um agente de teste que registra
  concorrência nunca tem dois processos na mesma sessão.
- Uma mensagem para uma instância sem cota fica `falhou` com o motivo visível, e não some.
- Um pedido sem sessão do dono recebe 401 e nada é entregue.
- O custo de uma conversa aparece em Health, separado do build e da revisão.
- A sessão restaurada num sandbox novo responde sobre algo dito antes da restauração (S3).

### M14: painel acessível de fora

Reverte, com ADR, a decisão de que o painel nunca passa pelo túnel. A opção recomendada é um segundo
hostname, por exemplo `panel.factory.aquim.ai`, atrás do Cloudflare Access (login por e-mail, com uma
política de um só e-mail), apontando para o mesmo servidor. Hoje a restrição é do túnel, que deixa passar
só o webhook e o health check. Com dois hostnames ela passa a ser também do servidor: o hostname público
serve `/api/webhooks/github` e `/api/health` e mais nada, e o do painel exige o JWT do Access
(`Cf-Access-Jwt-Assertion`) verificado contra as chaves da equipe. O painel mantém a sessão própria
(`FACTORY_PANEL_TOKEN`) e o cabeçalho anti-CSRF, e o Access é a primeira camada. A alternativa é o
Tailscale, sem host público nenhum; fica para o Paulo escolher.

Critérios de aceite:

- Sem o login do Access, `GET https://panel.factory.aquim.ai/api/panel/inbox` não chega ao servidor.
- Chegando ao servidor sem o JWT do Access (pedido forjado direto no túnel), o painel responde 403.
- `https://factory.aquim.ai/api/panel/inbox` responde 404 ou 403, e o webhook com assinatura válida
  continua respondendo 200.
- O Paulo abre o painel no celular, fora da rede de casa, e vê a Inbox.

### Decisões do Paulo

Em 2026-11-04 o Paulo aceitou todas as recomendações: o OK para os serviços `systemd --user` (M8), o
Cloudflare Access para o acesso de fora (M14), sem imagens no Novo job por enquanto (M11), 30 dias de
retenção do transcript com o conteúdo de cada evento limitado a 8 KB (M12), e uma mensagem "Orientar" que
não gasta uma das três tentativas (M13). Ficou para fazer M8 e M9 juntos, depois o M10.

### Fora desta rodada

Notificações no Slack, a aba Machines e o runner local do `marshal-factory` (a fábrica não tem runner
local), sandboxes na Modal, a fonte Linear e mais de um dono no painel.

## Agentes de código e autenticação

Estado em 2026-11-04: o contrato `CodingHarness` (`egress`, `prepare`, `run`, `resume`, com
`sessionId` e sinal de cota no resultado) está implementado, com o Claude Code e o Codex como
harnesses e um registro que escolhe o agente por label `harness:<nome>`, `FACTORY_HARNESS` ou o
padrão. O Claude Code roda do início ao fim por chave de API e por assinatura. O Codex instala,
autentica pelo firewall e lê a parada por cota. Em 2026-11-04, com crédito na conta e o login dedicado
`~/.codex-factory-1`, o Codex completou uma issue de ponta a ponta (construiu, revisou, PR #39 e
pré-release), e as duas combinações de agentes funcionaram: Claude Code construindo com revisão do
Codex (PR #40) e Codex construindo com revisão do Claude Code (PR #41). A renovação do token foi
exercitada contra a OpenAI: o refresh token girou, o `auth.json` foi regravado com modo 600 e o
`~/.codex` do Paulo não mudou. Um terceiro agente deve custar um arquivo.

**Contrato do harness.** `CodingHarness` hoje só tem `run`. Para suportar vários agentes e o
`waiting` do M4, cada harness passa a declarar:

- `egress(credential)`: as regras de firewall que assinam as chamadas do agente (Claude: `x-api-key`
  ou `Authorization: Bearer`; Codex: o mesmo mecanismo contra a API da OpenAI).
- as variáveis de ambiente com placeholder, para que o CLI se comporte como logado sem receber o
  segredo.
- `run` e `resume(sessionId)`: o resultado devolve o `sessionId`, o custo e um sinal de limite de
  cota atingido, que é espera e não falha.
- um nome registrado. O harness de uma task vem de configuração, de um label da issue (como
  `harness:codex`) ou do padrão, e o reviewer do M4 pode usar um agente diferente do builder.

**Claude Code.** Chave de API ou token de `claude setup-token`, sempre pelo firewall. Verificado em
2026-11-04 com um token real: o CLI envia o bearer, o firewall o substitui e o sandbox só tem
o placeholder. A fábrica completa (issue, agente, push, checks, PR) rodou por assinatura, com
custo equivalente de US$ 0,04. O token vem de `claude setup-token`, que mostra na página do
navegador um código `código#estado` para colar de volta no terminal; só então imprime o token
`sk-ant-oat01-`. Não há necessidade do fallback com o token dentro do sandbox.

**Snapshots do Vercel Sandbox.** O SDK cria sandboxes persistentes por padrão e tira um snapshot
de cerca de 1 GB a cada `stop()`. Vinte execuções (16,8 GB) esgotaram o armazenamento do plano
Hobby, e todo `create` passou a falhar com 402 até os snapshots serem apagados. O adapter agora
cria com `persistent: false`, e o M4 deve tirar um snapshot explícito, com validade curta, só
quando uma task entrar em `waiting`.

**Codex.** `codex exec` sem interface. Com chave (`OPENAI_API_KEY`) o caminho é o mesmo do
Claude: placeholder no ambiente e firewall assinando. Com login do ChatGPT é mais difícil: o
`auth.json` tem token de renovação que rotaciona, e copiar o login do Paulo para um sandbox pode
invalidar o dele. O marshal-factory resolve com um login dedicado por sandbox simultâneo
(`CODEX_HOME` separado, "slots"). A fábrica deve fazer o mesmo, e talvez renovar o token no host
e assinar pelo firewall. A OpenAI recomenda não usar login de assinatura em repositório público.
Spike de 2026-11-04 em um sandbox real, com egress só para `registry.npmjs.org` e `chatgpt.com`:
o `codex` 0.166 instalou por npm e aceitou um `auth.json` de placeholder (id_token e access_token
com a assinatura trocada, refresh_token falso). O firewall assinou `Authorization: Bearer` e o
servidor respondeu com a mensagem de limite de uso da conta e a hora da liberação, o que só
acontece com a conta autenticada. O access token dura 10 dias e o de renovação pode ficar só no
host. A conexão por WebSocket falha com "Attack attempt detected" (o cabeçalho não é injetado no
upgrade) e o Codex cai para HTTPS depois de cinco tentativas; desligar o WebSocket na configuração
evita a demora. Uma execução completa não foi possível, porque a conta estava sem cota até
2026-11-05 11:48. Isso confirma que o sinal de limite atingido precisa virar espera. O login
usado foi copiado de `~/.codex`; um login dedicado em `~/.codex-factory-1` evita que o Codex do
Paulo e a fábrica invalidem o token um do outro quando um deles o renovar.

**Assinatura: limites e termos.** O uso do binário oficial `claude -p` com a assinatura do
próprio dono, nos próprios repositórios, está dentro dos termos lidos em 2026-11-04. Uma fábrica
ligada o dia todo cai numa zona cinzenta de volume, e a Anthropic recomenda chave de API para
qualquer coisa compartilhada. As regras mudaram várias vezes em 2026 e devem ser relidas antes
de depender delas. Efeitos para o código: "limite atingido" vira espera; o custo em dólar vira
valor equivalente e o painel o rotula assim.

**Assumir a sessão do agente.** O marshal-factory roda o T3 Code dentro do sandbox, e o botão
"Open in T3" gera um token de pareamento de 15 minutos para abrir a sessão no navegador e
conduzir o agente. O Vercel Sandbox permite isso: o SDK 3.9.1 tem `ports`, `domain(porta)`,
`snapshot` e `extendTimeout`. Não foi verificado se o T3 roda sem interface nesse sandbox, e a
regra "TheoKit primeiro" manda ver antes o que o framework já oferece. Quem tiver o link executa
código no sandbox, que não guarda segredos, então o link deve ser curto e de uso único. A sessão
no plano Hobby termina em 45 minutos. Fica depois do painel (M5), a menos que o Paulo peça antes.

**Ordem.** M3b (contrato, spike do Codex, spike da assinatura do Claude) antes do M4. O M4 usa
`resume` para a pergunta e a resposta. O "assumir ao vivo" vem depois do M5.

## Fora do escopo por enquanto, mas decidido que virá

- Vários repositórios com onboarding (M10) e rodar sempre ligado (M8): ver "Próximos marcos".
- Fonte Linear por adapter, depois do GitHub Issues.

## Base de conhecimento aprovada

```text
aifactory/                         código open source
  templates/knowledge/             template da base de conhecimento

factory-global                    repositório privado global
  MEMORY.md
  knowledge/                      regras e conhecimento curados
  memory/                         observações

<owner>/<projeto>-knowledge        repositório privado por projeto
  MEMORY.md
  knowledge/
  memory/
```

- Usar o formato Agent Memory Repo: `MEMORY.md` como índice, entradas com origem,
  data e links para documentos.
- Cada execução carrega a base global e a do projeto, presas a SHAs registrados.
- `knowledge/` tem autoridade de instrução e muda por PR aprovado pelo Paulo.
- `memory/` é referência observada, nunca instrução. O agente propõe via MCP;
  a fábrica valida e é a única escritora, serializando as escritas.
- Observações precisam de proveniência, escopo válido e referência à execução.
- Um curador deduplica, expira observações e propõe PRs promovendo lições para
  `knowledge/`; lições comuns podem ser propostas para a base global.
- O playbook base permanece no código da fábrica. `AGENTS.md` e a documentação do
  repositório de código continuam sendo contexto do projeto.
- O onboarding cria a base privada do projeto a partir do template; a execução
  recebe acesso somente às bases correspondentes.

## Sandbox: Vercel Sandbox aceito como primeiro adapter

O benchmark documental de 2026-10-30 recomendou o Vercel Sandbox, e o Paulo aceitou a escolha em
2026-11-03. O spike rodou no mesmo dia contra um projeto Hobby e verificou os cinco pontos
previstos: bloqueio de hosts fora da allowlist (incluindo DNS), segredo fora do sandbox,
streaming incremental de stdout, workspace preservado ao retomar e o que o estado `waiting`
precisa preservar. Os resultados estão na [ADR 0003](adr/0003-sandbox.md).

Uma chamada real do Claude Code dentro do sandbox, com a chave só no firewall, também
funcionou. O E2B segue como segundo adapter.

## Ponto de retomada

O M0 foi interrompido para corrigir problemas encontrados no TheoKit, seguindo a
decisão de aproveitar o framework em vez de contorná-lo na fábrica. Com as correções
publicadas e adotadas, ele foi concluído em 2026-11-03.

A sessão relatou publicação do TheoKit 0.76.0 e correções em ORM e plugins.
O lote seguinte (#1037, #1031, #1038 e #1051 de `usetheokit/theokit`) foi concluído
em 2026-10-31: `theokit@0.76.1` e `create-theokit@3.0.21` foram publicados,
verificados como consumidor contra PostgreSQL real e as quatro issues foram
fechadas com evidências. Veja o [registro da release](THEOKIT-RELEASE-0.76.1.md).

Entre 2026-10-31 e 2026-11-03 a auditoria de prontidão do TheoKit abriu, corrigiu e verificou
no pacote publicado as issues #1069 a #1079, #1086, #1096, #1097, #1100 a #1102 e #1123. A
última versão é a `theokit@0.77.4`, que a fábrica adotou. Ficam fora da auditoria a
documentação do site (`website#26` e `website#27`) e o que depende de contas do Paulo: a chave
da Anthropic para o Claude Code headless e o acesso do GitHub à fábrica.

Estado local confirmado em 2026-11-03, com `theokit@0.77.4`:

- Scaffold React/TheoKit com página inicial e rotas de liveness e readiness.
- PostgreSQL local via Compose. O pool vem de `getStorageManager().usePostgres`, e o
  `theo.config.ts` monta o bloco `storage` a partir de `DATABASE_URL`.
- Tabelas `ingress` e `task` (migration `0000_ingest_and_task`) e o webhook
  `POST /api/webhooks/github`. Ainda não há agentes nem jobs. No servidor real (`theokit start`)
  contra o Postgres do Compose, uma entrega assinada criou uma task em `intake`, a mesma entrega
  respondeu `duplicate` e a assinatura inválida respondeu 401.
- Typecheck, lint, formatação, build e `theokit check` passam. Há 19 testes de unidade e 12 de
  integração, todos verdes contra o PostgreSQL do Compose.
- ADRs 0001 a 0004 em `docs/adr/`, e CI em `.github/workflows/ci.yml`.
- M2: `runTask` leva uma task a `factory/<n>` e registra os estágios em `stage_event`. Contra o
  GitHub, a Vercel e o Postgres reais, com um agente roteirizado no lugar do Claude (`pnpm
test:e2e`), a issue #1 do playground virou uma branch `factory/1` enviada. A task e o job
  `run-task` entram juntos, na mesma transação, e o worker do TheoKit executa o job. Pela URL
  pública `factory.aquim.ai`, a label `factory` na issue #1 do playground levou o fluxo real,
  webhook do GitHub incluído, de `intake` a `done` em 31 segundos, por US$ 0,06: `factory/1` foi
  enviada pelo GitHub App e os 6 testes dela passam fora do sandbox. Com o Claude Code
  de verdade (`FACTORY_LIVE=1 pnpm test:e2e -t "real agent"`), o mesmo fluxo implementou a issue #1 em
  46 segundos, por US$ 0,03, enviou `factory/1` e os testes do que ele enviou passaram fora do
  sandbox. Uma primeira tentativa falhou num erro interno do GitHub no push (`fatal error in
commit_refs`), que não se repetiu; o push agora tenta até três vezes.
- M3: depois do push, a fábrica roda os checks (`npm test` por padrão) no commit enviado, dentro
  do sandbox, e grava cada resultado em `evidence` com o SHA, o código de saída real e o fim da
  saída. Uma função pura, `gate`, só libera o PR quando cada check exigido passou no SHA enviado;
  resultado de outro SHA não conta, e a ausência de checks exigidos também fecha o portão. O
  resultado vira o check run `aifactory/verify` no commit, e o PR abre apontando para a issue,
  com a fala do agente dentro de um bloco recolhido. Um teste com um agente que diz "todos os
  testes passam" enquanto `npm test` sai com 1 mostra que nenhum PR abre. Contra o GitHub real,
  o agente roteirizado e o Claude Code de verdade (US$ 0,06) abriram o PR com check run verde.
  Limite conhecido: um agente pode editar o próprio script de teste. Quem pega isso é o review
  independente do M4.
- M4a: depois dos checks verdes, um revisor independente (uma sessão nova do mesmo agente, ou outro
  por `FACTORY_REVIEWER`) lê o diff e devolve um veredito em JSON, gravado em `review`. A fábrica
  soma fatos que não dependem de modelo: o script `test` do `package.json` mudou, o diff toca
  `.github/` ou apaga testes. Checks vermelhos e review que pede mudanças voltam à mesma sessão do
  construtor (`claude -p --resume`, `codex exec resume`), com a saída que falhou ou os achados, até
  três tentativas. Sem aprovação e sem tentativas, a fábrica abre um PR em rascunho, comenta na issue
  e a task termina em `handoff`. Contra os serviços reais: o Claude Code construiu, outro Claude Code
  revisou e aprovou (US$ 0,04 no total, PR #9), e, com um revisor roteirizado que pediu um teste
  específico, o Claude real retomou a mesma sessão, acrescentou o teste, houve o segundo commit, o
  segundo review aprovou e o PR #10 abriu. O revisor em outro agente (Codex) foi
  exercitado depois, no M3b.
- M4b: o agente que não pode seguir sem uma decisão termina a resposta com `QUESTION:`. A fábrica salva
  o disco do sandbox num snapshot, comenta a pergunta na issue, grava tudo o que uma retomada precisa
  em `question` e põe a task em `waiting`. Um cron (`poll-answers`, a cada minuto) lê os comentários
  novos, aceita só os de quem tem acesso de escrita (`OWNER`, `MEMBER`, `COLLABORATOR`) e enfileira
  `resume-task` na mesma transação que grava a resposta. A retomada restaura o snapshot, apaga-o e
  retoma a mesma sessão do agente com a resposta. Contra os serviços reais, o Claude Code recebeu uma
  issue que mandava perguntar antes de escrever, fez uma pergunta com quatro opções, o snapshot e a
  restauração rodaram na Vercel, a resposta veio de um comentário real do dono do repositório, e a
  mesma sessão implementou o pedido e abriu o PR #12. Um snapshot custa cerca de 800 MB, restaurá-lo
  levou menos de um segundo, e nenhum sobrou depois. O cron enfileira por um backend de jobs
  compartilhado, porque job e cron não têm `ctx.queue`
  ([usetheokit/theokit#1150](https://github.com/usetheokit/theokit/issues/1150)).
  Pelo caminho de produção, sem nada simulado (label `factory` numa issue nova, webhook, servidor
  real, Claude real, resposta de um comentário real e o cron real), a task perguntou em 24
  segundos, e depois da resposta terminou em 77 segundos com o PR #15, por US$ 0,18 (chave de API,
  revisão incluída).
- M5: um painel local (React, no próprio servidor) com quadro por situação, caixa de entrada,
  detalhe da task (linha do tempo, evidência, reviews, perguntas, decisões) e atualização por SSE a
  cada mudança de estágio, com o custo crescendo enquanto o agente trabalha. As ações são aprovar (preso
  ao commit), pedir mudanças (nova execução a partir da branch, com o texto no prompt) e tentar de novo
  (apaga a branch e recomeça). O dono entra com um token e recebe um cookie de sessão criptografado, com
  limite de tentativas; as rotas `/api/panel/*` recusam todo o resto, e o servidor escuta só em
  `127.0.0.1`, enquanto o túnel só expõe o webhook e o health check. Pelas rotas reais, com o Claude
  real: uma issue virou PR em 44 segundos, a aprovação foi gravada para aquele commit, "tentar de novo"
  numa task concluída foi recusado (409), e o pedido de mudança gerou um segundo commit por cima do
  primeiro, com checks e review de novo, e a aprovação antiga deixou de valer para o commit novo. Um
  pedido que não exigia mudança fez a task voltar a `done` com a resposta do agente na issue, em vez de
  falhar. Os testes que escrevem no banco passaram a usar `<nome>_test`, porque apagavam as tasks
  reais. O Tailwind só funciona com `@theokit/ui` instalado, que agora é dependência.
- M6a: a entrega virou pré-release. Para todo commit com checks verdes que chegou a um PR, aprovado ou
  entregue a uma pessoa, a fábrica cria uma tag `pre/<issue>-<sha7>`, marcada como pré-release, com os
  checks, o veredito do review, as tentativas e o custo nas notas. Isso não pede licença e não mexe na
  `main`; se o GitHub recusar, a task não falha e o motivo fica no estágio. A release é a promoção:
  `release()` recusa sem pré-release do commit, sem checks verdes, ou com um PR fechado, já mergeado,
  em rascunho ou que andou, e o merge é fixado ao SHA entregue, então um push no meio faz o GitHub
  recusar em vez de mergear o que ninguém viu. A versão é a seguinte à da última release (v0.1.0 na
  primeira). Quem promove é um humano, pelo painel (o clique vale como aprovação), ou um agente: o modo
  `FACTORY_RELEASE_MODE` é `manual` (padrão, só humanos), `trial` (registra o que um agente teria
  liberado) ou `auto` (libera um commit com checks verdes e review aprovado). Trabalho entregue a uma
  pessoa nunca é liberado sozinho. Pelo GitHub e pelo painel reais: uma issue virou PR em 47 segundos, a
  pré-release `pre/21-df799ca` apareceu apontando para o commit entregue com a `main` intacta, o release
  pelo painel mergeou, publicou `v0.1.0` como a última versão e levou a task a `released`, e um segundo
  clique foi recusado.
- M6b: todo release registra uma vigília sobre o commit de merge na `main`, e um cron (`watch-main`, a
  cada minuto) lê os check runs e os statuses desse commit. Falha vira vermelho na hora, sem esperar os
  outros checks; run cancelada ou ignorada não conta; sem nenhum check é "sem sinal", não verde. Verde
  encerra a vigília; passada a janela de 60 minutos sem veredito, ela termina como `silent`, dizendo se
  nenhum check reportou ou se ainda estavam rodando. Vermelho abre um PR de revert pela mutação
  `revertPullRequest` do GitHub (o PR sai com o corpo explicando o que quebrou) e **para aí**: nenhum
  caminho do código mergeia esse PR, e o teste falha se o vigia chamar um merge. A vigília passa por
  `reverting` enquanto o revert é aberto, para a caixa de entrada não dizer "nenhum revert" cedo demais,
  e só então vira `red`. Um revert que o GitHub recusa (conflito, por exemplo) fica registrado e a caixa
  de entrada avisa que não há revert. A pessoa dá o caso por tratado pelo painel. Pelo GitHub real: o
  release de uma task, um check run falho no commit de merge, e 25 segundos depois o PR de revert aberto
  pelo bot, com a `main` ainda no commit do release.
- M7, saúde: cada execução de um agente (build, retrabalho, retomada depois de uma resposta, review)
  vira uma linha em `agent_run`, com o agente, o papel, a tentativa, o custo, o tempo e o resultado, e
  uma execução que não voltou ou que bateu na cota fica registrada como tal. A página Health do painel
  mostra o custo nas últimas 24 horas, nos últimos 7 dias e no total, por agente e papel, e conta um
  agente que não informa custo (o Codex) como execuções, não como zero dólar. O supervisor (cron a cada
  5 minutos) abre achados tipados: `stalled` para uma run em estágio de trabalho sem evento há mais de
  45 minutos, e `orphaned` para uma task enfileirada sem job para rodá-la, uma resposta que ninguém
  retomou, um revert que nunca terminou de abrir e um snapshot que nenhuma pergunta espera. Ele só
  reporta; uma pessoa resolve cada achado pelo painel (começar de novo, retomar de novo, apagar o
  snapshot, mostrar o revert como vermelho), e uma checagem que não pôde rodar não resolve achados dela.
  Ao vivo: uma task parada e uma enfileirada sem job foram achadas no primeiro ciclo, um snapshot órfão
  de verdade na Vercel no ciclo seguinte (depois dos 5 minutos de tolerância), e os três foram resolvidos
  pelo painel, com o snapshot apagado no provedor.
- M7, qualidade: três gates no CI, num job `quality` ao lado do `check`. CRAP (complexidade ao
  quadrado vezes a parte não coberta ao cubo, mais a complexidade) por função, a partir da cobertura real
  e da complexidade ciclomática pela API do TypeScript: nenhuma função nova passa de 30, e as que já
  passam só podem diminuir. Hoje há uma, `execute` do `runTask`, com complexidade 66, registrada como
  dívida em `quality/crap-baseline.json`. Duplicação abaixo de 1% (hoje 0,15%, com o `jscpd`). Mutação com o
  Stryker sobre a lógica de decisão pura (portão de evidência, veredito do review, guardas do diff,
  classificação da `main`, resposta ao agente, versões, notas, formatação do painel), com piso de 90: a
  nota foi de 75,9 para 97,2 depois de escrever os testes que os sobreviventes pediam. Cada gate foi visto
  falhando de propósito (uma função complexa sem teste, um limite apertado e um piso alto).
- M7, a dívida paga: o `execute` virou a classe `Run` (`factory/run.ts`), com um método por etapa
  (abrir o sandbox, primeira passada, perguntar, retrabalhar, verificar, rever, entregar, promover,
  entregar a uma pessoa e o laço de tentativas), e o estado que muda durante a execução (custo, o que o
  agente disse, a sessão) mora nela, não em fechamentos soltos. Os tipos foram para `run-types.ts` e os
  erros e utilitários para `run-support.ts`; `run-task.ts` ficou com a API pública (`runTask`,
  `resumeTask`) e a casca de `execute`. A complexidade do `execute` foi de 66 para 6, a maior peça nova
  (`loop`) tem 11, e o baseline de CRAP ficou vazio. O comportamento não mudou: os 142 testes de
  integração, o e2e roteirizado e os testes ao vivo (Claude real, retrabalho com `--resume`, pergunta
  com snapshot e retomada) passaram sem alterar uma asserção.
- Decisões do dono em 2026-11-04: com as duas credenciais do Claude definidas, vale a assinatura
  (`FACTORY_CLAUDE_AUTH=api-key` escolhe a chave), e o modo `auto` de release não exige aprovação do
  commit no painel, só as recusas de `release()`.
- M8, operação contínua: o servidor e o túnel viraram unidades `systemd --user`
  (`ops/systemd/`, `scripts/install-services.sh`), com `linger` ligado, `Restart=always` e um
  `scripts/deploy.sh` que compila e reinicia só o servidor. O Postgres ganhou `restart: unless-stopped`,
  um volume nomeado (antes os dados estavam num volume anônimo, que um `compose down -v` apagaria) e a
  porta presa a `127.0.0.1` (antes ficava em todas as interfaces, com a senha de desenvolvimento). A
  migração dos dados passou por um dump e uma restauração, com as contagens conferidas, e o volume
  antigo ficou como rede de segurança. Backup diário (`scripts/backup.mjs`, 14 dias, modo 600) com
  verificação de restauração, vista falhando de propósito (uma contagem adulterada). O cron `catch-up`
  pede de novo os webhooks que o GitHub não conseguiu entregar. Ao vivo: com o servidor parado, a label
  foi posta numa issue, o servidor voltou, e o cron fez uma task, uma só, que chegou a `done` em 42
  segundos pelo servidor do systemd. O teste ao vivo achou um defeito que os testes não achavam: os ids
  de entrega do GitHub passam de 2^53, o JavaScript os arredondava e o GitHub respondia 404; hoje são
  lidos como texto, com um teste que usa um id grande de verdade. Matar o servidor e o túnel com
  `kill -9` os trouxe de volta, e o Postgres voltou depois de o processo dele morrer. Não foi feito um
  reboot de verdade da máquina: o `linger`, o Docker habilitado e as unidades habilitadas cobrem o
  caminho, mas ele não foi exercitado.
- M9, painel com os componentes do TheoKit UI: `@usetheo/ui` (estrutura: `Button`, `Badge`, `Card`,
  `Table`, `Sheet`, `Input`, `Textarea`, `EmptyState`) e `@theokit/ui` (`ThemeProvider`, `ThemeSwitcher`)
  no lugar do Tailwind escrito à mão, com os tokens do tema. Quadro ou lista (a escolha fica guardada),
  painel lateral da task (`?task=7`), tela cheia (`?task=7&full=1`, Esc volta ao quadro) e o endereço
  `/tasks/7` mantido. Um achado de contraste: o `text-primary` dos links dava 2,9 sobre o cartão no
  modo escuro e o `text-success` 3,5 no claro, então os links viraram `text-foreground` sublinhado, e um
  teste falha se um desses tons voltar como texto. Outro achado: cada recurso da página abria o seu
  próprio `EventSource`, e o navegador só aceita seis conexões por host, então hoje há uma conexão só,
  compartilhada. Ficou para o M10 o filtro por repositório (não há o que filtrar com um só). O
  `RunStatusPill` e o `AgentTimeline` não entraram: o primeiro trocaria o texto dos estágios que os
  testes e a pessoa já leem, e o segundo espera o transcript do M12.
- MVP, tudo pelo painel (2026-11-04, a pedido do Paulo: instalar por interfaces, dar acesso aos repositórios,
  criar planos e issues pelo próprio sistema). Entrou o essencial do M10 e do M11. Páginas novas: Setup (o
  que falta, com o link que conserta), Repositories (o que a App alcança, habilitar e ajustar checks,
  domínios, agentes e release por projeto), Plans (um agente lê o repositório e propõe até dez issues
  independentes, que o dono edita e cria sob um milestone, já iniciadas ou não) e o botão New job. Antes,
  rotular uma issue em qualquer repositório da conta gastava dinheiro: agora só vale em um habilitado
  (ADR 0005). Os ajustes por repositório são lidos por toda execução (checks no lugar do `npm test`,
  domínios extras no firewall, agentes e modo de release). Ao vivo, só pela interface (Chrome sem cabeça
  no painel): Setup, habilitar o playground, um plano de 2 issues por US$ 0,04, criar e iniciar, e em 80
  segundos dois PRs com pré-release; "New job" abriu a issue #48 sem a label e disse que esperava. O
  playground foi limpo depois. Dois achados pelo caminho: o TheoKit quebra o build com duas páginas de
  mesma pasta dinâmica (`tasks/[id]` e `plans/[id]`, usetheokit/theokit#1151; a pasta virou
  `[planId]`), e a lista de 120 repositórios levava 4,5 segundos, então ficou guardada por 15. O GitHub
  Projects ficou de fora: uma App não alcança o Project de uma conta pessoal. Falta do M10: a receita
  `.factory/setup.json` (hoje o dono ajusta no painel) e o primeiro projeto que não seja o playground.
- Primeira execução real sobre o backlog do theokit (2026-11-05). O item B-682 (servir uma lista de tools
  por MCP) virou a issue `usetheokit/theokit#1154`, escrita para se sustentar sozinha, e a fábrica a
  entregou: PR `#1155` contra `develop`, 4 arquivos (+278 −64), os 4 checks verdes (install, tests, types,
  lint), review independente aprovado na primeira rodada, pré-release `pre/1154-d8da4fa`, US$ 0,72 no
  total. A primeira tentativa falhou, e a causa não foi o código: o `build:packages` estourou a memória do
  sandbox da Vercel (`ERR_WORKER_OUT_OF_MEMORY`, Node 24), o `.d.ts` não foi gerado e o check de tipos
  caiu; a fábrica pediu retrabalho e o agente, com razão, não mudou nada. Com `NODE_OPTIONS=--max-old-space-size=3072`
  no check de instalação e um `retry`, passou. Três achados: (1) um check de instalação que falha por
  ambiente vira "retrabalho" que o agente não consegue fazer, e a tarefa falha sem dizer que o problema
  é o ambiente; (2) o tamanho do sandbox (`resources.vcpus`, 2 GB por vCPU) não é configurável pela
  fábrica; (3) o repositório tem o `promotion-gate` (workflow compartilhado da organização): `develop` só
  aceita PR vindo da branch `workspace`, então o PR da fábrica (`factory/1154`) falha esse check mesmo
  estando correto. A App não tem a permissão `workflows` e não deve ter: workflows ficam para uma pessoa.
  Decisão pendente do Paulo: a base do theokit deve ser `workspace` (onde o squad integra, e onde o
  código do TheoClaw existe) em vez de `develop`. O PR #1155 não foi mergeado nem retargetado.
- Branch de base por repositório (2026-11-05). Alimentar a fábrica com o backlog do theokit (a fábrica antiga, o
  squad) esbarrou numa limitação medida: a fábrica sempre parte da branch padrão e abre o PR contra ela,
  e o theokit integra em `develop` (a `main` só recebe release, e o `promotion-gate` roda nos PRs para
  `develop`). Cada repositório ganhou uma coluna `base_branch` (migration 0011), um campo na página
  Repositories, validação do nome, e a base vale para o clone, o PR, o leitor do assistente de setup e o
  plano. Vazio mantém o comportamento antigo. Testado: a execução parte de `develop` e abre contra ela, e
  sem a configuração parte de `HEAD` como antes. Os outros dois bloqueios do primeiro item (o clone limpo
  pede `pnpm build:packages`, e o teste do B-634 falha com `__dirname` num clone limpo) estão no registro
  da sessão e seguem abertos.
- Assistente de escrita (2026-11-04, a pedido do Paulo: em todos os textarea um agente que faça da
  fábrica um super agente especializado nela, com a premissa de que o dono não precisa ser programador).
  Sob toda caixa de texto do painel há um botão ("Help me say it", "Improve this" ou "Set this up for me")
  que chama um agente do TheoKit: `assist` escreve o objetivo de um plano, o job, cada issue e o pedido de
  mudanças, e `assist-setup` lê o projeto e preenche os checks e os domínios. O dono diz o que quer e o
  agente escreve o que a fábrica precisa, na língua do dono, sem fazer pergunta; nada muda até "Use this",
  e dá para pedir outra versão em palavras. O que a fábrica é vive em `.theokit/THEO.md`. Ao vivo, no
  Chrome do dono: "quero um site onde meus clientes marcam hora comigo" virou um objetivo com o que o site
  deve ter, em português; o setup do `usetheokit/theodot` leu o CI e devolveu os checks. Três achados que os
  testes não davam: (1) o SDK dá a todo agente um shell próprio, e o assistente roda no processo do
  servidor, então um gancho `pre_tool_call` recusa tudo fora da lista (um pedido de `touch` pelo shell não
  criou o arquivo); (2) o framework entrega a chamada de ferramenta como uma parte `dynamic-tool` com
  `toolName`, não como `tool-propose`, e a página não mostrava a sugestão até isso ser lido do fluxo real;
  (3) o menu não tinha o link do Setup, porque uma troca de texto no layout não casou e não avisou. O
  assistente usa a chave `ANTHROPIC_API_KEY` da fábrica (uma assinatura não serve a isto), custa cerca de
  um centavo por ajuda, e a página Setup mostra se está ligado. Um teste falha se uma caixa de texto ficar
  sem assistente.
- Readiness sem `DATABASE_URL`: o servidor sobe e `/api/ready` responde 503 com o motivo. Com
  uma URL que não é `postgres://`, o `theokit` recusa iniciar.

## Próximas ações para concluir M0

- [x] Confirmar a release publicada do TheoKit e a presença das correções necessárias.
- [x] Adotar o TheoKit corrigido (`^0.77.4`) e migrar a gestão do banco para o caminho
      suportado, com teste contra PostgreSQL real e proteção contra erro em conexão ociosa.
- [x] Resolver o contrato de `createPool`: o teste passou a exercitar o pool de `getPool()`.
- [x] Definir o comportamento de readiness para configuração inválida do banco.
- [x] Alinhar README e configuração com a fábrica.
- [x] Registrar ADRs da arquitetura, base de conhecimento e sandbox; a do sandbox foi
      aceita depois do spike.
- [x] Configurar o CI: formatação, `theokit check` (tipos, lint e scan), testes de unidade e de
      integração, e build.
- [x] Confirmar o CI verde no GitHub após o primeiro push (run 41696481251, todos os passos).
- [x] Iniciar M1 com persistência do ingress, task e deduplicação de deliveries.

## Origem

Recuperado da sessão Claude Code
`d6692f50-0656-450e-9cf5-814e9a4c7fb7`, nas conversas de 2026-10-30 e 2026-10-31,
e das memórias `aifactory-architecture-decisions.md` e
`prefer-theokit-everything.md`. Este documento mantém o plano acessível sem
depender dos arquivos pessoais da sessão.
