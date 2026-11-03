# ADR 0003: sandbox de execução

Status: proposta. Depende de um spike que ainda não rodou.

## Contexto

O agente executa código de terceiros e do próprio modelo. A execução precisa de isolamento, e a
fábrica recusa rodar sem ele. Um benchmark documental de 2026-10-30 comparou provedores, sem
executar nada.

## Decisão proposta

Vercel Sandbox como primeiro adapter de `SandboxProvider` e E2B como alternativa. A confiança é
de cerca de 70%, porque o benchmark leu documentação e as contas para testar não existiam.
As condições e capacidades dos provedores devem ser verificadas de novo no spike, sem tratar o
benchmark como garantia atual.

O spike precisa verificar ao menos:

1. Bloqueio de hosts fora da allowlist, incluindo o comportamento de DNS.
2. Ausência de secrets dentro do sandbox e compatibilidade do Claude Code com credenciais
   intermediadas pelo provedor.
3. Streaming incremental de stdout.
4. Preservação do workspace ao retomar a execução.
5. Se o estado `waiting` exige preservar processos em memória ou só o filesystem.

## Consequências

- O spike bloqueia o M2 (execução) e não afeta o M0 nem o M1.
- Ele exige contas Vercel (plano Pro) e E2B, que são do Paulo.
- O `LocalSandbox` do TheoKit roda comandos no host, sem isolamento
  ([usetheokit/theokit#1070](https://github.com/usetheokit/theokit/issues/1070)), então não
  serve como `SandboxProvider`.
- Esta ADR muda para aceita, ou é substituída, quando o spike terminar.
