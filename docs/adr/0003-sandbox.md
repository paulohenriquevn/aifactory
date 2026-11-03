# ADR 0003: sandbox de execução

Status: aceita para o primeiro adapter (2026-11-03). Uma verificação continua aberta, descrita
no fim.

## Contexto

O agente executa código de terceiros e do próprio modelo. A execução precisa de isolamento, e a
fábrica recusa rodar sem ele. Um benchmark documental de 2026-10-30 comparou provedores sem
executar nada e recomendou o Vercel Sandbox, com E2B como alternativa.

## Decisão

Vercel Sandbox é o primeiro adapter de `SandboxProvider`. E2B fica como segundo adapter, atrás da
mesma interface.

A documentação lida em 2026-11-03 aponta o Vercel Sandbox como o provedor que reúne os critérios:

- Firecracker microVM, com a imagem padrão trazendo Node, Python e coding agents.
- Firewall de saída por domínio (SNI) e por CIDR, atualizável com o sandbox rodando.
- Injeção de credenciais no firewall (`transform` de headers, com filtro por método e path), de
  modo que o segredo nunca entra no sandbox.
- Persistência por padrão, com snapshots que expiram em 30 dias sem uso.
- O firewall completo está no plano Hobby desde 2026-08-05. O plano Pro não é necessário para
  começar.

Limites do Hobby: 5 horas de CPU ativa por mês, sessão de até 45 minutos, 4 vCPU e 8 GB, 10
sandboxes concorrentes. Ao estourar a cota a criação pausa e nada é cobrado. O Pro dá sessões de
24 horas e US$ 20 de crédito mensal.

## Resultados do spike

Rodado em 2026-11-03 contra um projeto Hobby (`aifactory-sandbox`), com os scripts de
`spikes/vercel-sandbox/`. Tudo abaixo foi observado.

| Critério                               | Resultado                                                                                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Bloqueio de hosts fora da allowlist | Com `allow: ['example.com']`, `example.com` respondeu 200. `api.github.com` não resolveu. IP literal e HTTP puro (porta 80) para o domínio permitido foram recusados. Uma consulta DNS crua a 8.8.8.8 ficou sem resposta. `deny-all` e a reabertura ao vivo funcionaram. |
| 2. Segredo fora do sandbox             | O header injetado chegou ao servidor com `curl` e com o `fetch` do Node. Ele não aparece no ambiente nem no disco do sandbox. Quando o cliente já envia o mesmo header, o firewall o sobrescreve e o servidor recebe só o valor real.                                    |
| 2b. Claude Code atrás do firewall      | O Claude Code 2.1.317, que já vem na imagem, chegou a `api.anthropic.com` e recebeu um HTTP 401 da API com uma chave falsa. O caminho de rede e a confiança no certificado do proxy funcionam.                                                                           |
| 3. Streaming de stdout                 | Cinco linhas, uma por segundo, chegaram em 1012, 1722, 2746, 3667 e 4690 ms. O stderr vem em fluxo separado.                                                                                                                                                             |
| 4. Workspace ao retomar                | Um arquivo gravado antes do `stop` estava lá após o resume. O diretório de trabalho é `/vercel`.                                                                                                                                                                         |
| 5. Estado `waiting`                    | Só o filesystem sobrevive. O resume cria uma VM nova (`boot_id` diferente) e um processo em segundo plano não sobrevive.                                                                                                                                                 |

Consequência do critério 5: ao retomar uma execução em `waiting`, a fábrica sobe o agente de novo
sobre o workspace preservado, retomando pela sessão gravada em disco. Ela não depende de processos
vivos.

## Verificação em aberto

Uma chamada real do Claude Code com a chave injetada pelo firewall ainda não foi feita, porque não
existe `ANTHROPIC_API_KEY` no ambiente de trabalho. O que já está provado cobre o caminho de rede e a
substituição do header. Falta ver a API aceitar a chave real quando o sandbox só conhece um
placeholder. Login por assinatura (OAuth) provavelmente não passa por esse mecanismo, e só a chave
de API foi considerada.

## Riscos conhecidos da documentação

- O filtro por domínio lê o SNI. HTTP puro não é filtrado por domínio, e um cliente malicioso pode
  tentar domain fronting. Preferir domínios estreitos, de uso único.
- Uma regra `*` deixa passar tráfego sem domínio detectável, como SSH.
- Uma lista de CIDR sem domínios deixa o DNS livre, o que serve de canal de exfiltração.
- A política da fábrica deve ser uma allowlist estrita de domínios, sem `*` e sem `subnets.allow`.
  O Claude Code e o clone do repositório vão pedir ao menos `api.anthropic.com`, `github.com` e o
  registro de pacotes do projeto.

## Consequências

- O spike deixa de bloquear o M2, salvo pela verificação em aberto acima.
- O token do sandbox é um token OIDC de 12 horas do projeto Vercel, obtido com `vercel env pull`.
  Fora da Vercel, a fábrica usa o ID do time, o ID do projeto e um token de acesso.
- O `LocalSandbox` do TheoKit roda comandos no host, sem isolamento
  ([usetheokit/theokit#1070](https://github.com/usetheokit/theokit/issues/1070)), então não serve
  como `SandboxProvider`.
