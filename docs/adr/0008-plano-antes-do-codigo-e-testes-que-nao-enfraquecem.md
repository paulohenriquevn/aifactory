# ADR 0008: o construtor escreve um plano antes de mudar o código, e não pode enfraquecer os testes

Status: aceita (2026-11-11). Issues: #33 (plano) e #34 (testes enfraquecidos).

## Contexto

Até aqui, o construtor recebia a issue e começava a editar. O revisor via o diff e a issue, mas não tinha
como saber o que o construtor pretendia fazer. Um arquivo mexido sem motivo (uma reformatação, um ajuste
de lint em outro módulo) só aparecia se o revisor reparasse nele. Também não havia registro do raciocínio
antes do código, nem no PR nem no painel.

Os guardas sem modelo de `guards.ts` pegavam um arquivo de teste apagado, o script `test` trocado e
mudanças em `.github/`. Um teste que perdesse asserções, um caso removido de um arquivo que continua
existindo ou um `it.skip` acrescentado passavam pelos guardas. Restava ao revisor perceber. Os checks
verdes contam pouco quando o teste que deveria falhar ficou mais fácil, e isso pesa mais numa correção de
bug, em que o teste de regressão é a prova do conserto.

## Decisão

### Plano versionado antes do código (#33)

- **Um passo novo em `Run`**, `planChange()`, chamado em `start()` antes de `firstPass()`. Ele grava o
  estágio `plan`. O construtor recebe o mesmo texto do build (issue, regras, checks, base de
  conhecimento), mais a instrução de não alterar nenhum arquivo nem perguntar nada nesse turno. O turno
  termina com um objeto JSON com `files` (caminho e motivo), `order`, `risks`, `proof` e `outOfScope`.
- **O build continua a mesma sessão.** Depois do plano, o construtor recebe pelo `resume` a instrução de
  implementar o plano e de explicar no resumo final qualquer arquivo fora dele. O raciocínio do plano
  não se perde e não há segundo prompt com a issue inteira.
- **O que o turno de plano mudou no checkout é descartado** (`reset --hard` na base, `clean -fd`), e o
  construtor fica sabendo.
- **Um plano ilegível ganha uma segunda chance** na mesma sessão. Sem plano de novo, a task falha em
  `plan`, com o que o agente disse.
- **O turno de plano tem teto de 15 minutos** (`PLAN_MS`), para não comer o tempo do build.
- **O plano é gravado** na tabela `change_plan` (migration 0025): task, commit base, agente e o JSON.
  Ele vai no corpo do PR (seção recolhível "Plan"), no painel (seção "Plan" da task, com o último plano)
  e no prompt do revisor.
- **Uma comparação sem modelo** (`unplannedFiles`) cruza os arquivos do diff com os do plano. Um caminho
  terminado em `/` vale como pasta, `*` vale dentro de uma pasta e `**` vale em qualquer profundidade.
  Lockfiles ficam de fora. O revisor recebe a lista dos arquivos fora do plano e a instrução de tratar
  cada um como achado, pelo menos `major`, a menos que o resumo do construtor dê um motivo que a issue
  sustente. A fábrica também grava cada arquivo fora do plano como achado `minor`, para o registro. Quem
  bloqueia é o revisor, porque só ele consegue julgar o motivo.
- **Uma task retomada não planeja de novo.** Resposta a uma pergunta, mudanças pedidas por uma pessoa ou
  checks obrigatórios que devolveram o trabalho usam o último plano gravado da task. Uma renovação de
  sessão do E2B (#29) acontece dentro do mesmo run e mantém o plano em memória.
- **Um construtor que não sabe retomar sessão não planeja.** O plano não chegaria ao turno que faz o
  trabalho. Os dois agentes atuais (Claude Code e Codex) sabem retomar.
- **Sem aprovação humana do plano, por padrão.** A fábrica existe para que o dono não precise
  acompanhar cada task. Uma aprovação aqui pararia toda task até alguém olhar, e o painel já mostra o
  plano a quem quiser ler. Quem confere é o revisor, contra o diff, com a mesma independência do resto da
  revisão. A opção `planFirst: false` em `RunTaskDeps` desliga o passo.

### Testes que não enfraquecem (#34)

- **Um guarda sem modelo** (`testWeakening`, em `test-weakening.ts`) lê o `git diff -U0` dos arquivos de
  teste entre a base e o commit. Os caminhos vêm de pathspecs fixos, então nenhum caminho criado pelo
  agente chega ao shell. Num arquivo de teste que já existia na base, o guarda aponta:
  - casos removidos (`it`, `test`, `def test_`, `func Test`) cujo nome não volta em nenhum lugar do diff;
  - perda líquida de asserções (`expect(`, `assert…`, `t.Error/Fatal`), descontadas as que foram junto
    com um caso movido para outro arquivo;
  - `.skip`, `.only`, `.todo`, `xit`, `xdescribe`, `@pytest.mark.skip` ou `t.Skip` acrescentados.
- **A severidade depende da issue.** Numa issue com label `bug`, o achado é `blocker`; nas outras,
  `major`. Os dois impedem a aprovação, e o revisor não consegue derrubá-los. Quando o texto da issue
  cita o arquivo ou um caso removido (de 6 letras ou mais), o achado vira `minor` e a decisão fica com
  o revisor, porque a remoção pode ser justamente o que a issue pede.
- **Um arquivo de teste apagado** continua com o guarda que já existia (`major`).

## Evidência

- _Observado:_ a tabela de estágios e os guardas antes desta mudança, lidos em `run.ts` e `guards.ts`
  no commit `6385b0a`.
- _Observado:_ os testes unitários de `change-plan.ts` e `test-weakening.ts` e os testes de integração
  de `run-task.integration.test.ts`, com Postgres real e sandbox falso. Eles cobrem o plano gravado e
  seguido na mesma sessão, o descarte do que o turno de plano mudou, a segunda chance e a falha em
  `plan`, a task enviada de volta que mantém o plano, e a aprovação recusada quando uma asserção some.
- _Observado:_ mutação de 98% nos dois módulos novos, acima da linha de 90 do projeto.
- _Não medido:_ o efeito em tasks reais (taxa de retrabalho, custo por task, qualidade do PR). Não rodei
  o teste de ponta a ponta com E2B nesta mudança. Antes de tirar conclusões, os números devem vir das
  métricas da fábrica sobre as próximas tasks.

## Custo

- **Um turno de agente a mais por task nova**, com teto de 15 minutos, quase sempre bem menos, porque o
  turno só lê o código e escreve o plano. O custo em dinheiro é o de um turno curto do mesmo agente. Como
  o build continua a mesma sessão, a leitura do código feita no plano não precisa ser repetida.
- **Tempo dentro da sessão de 60 minutos do E2B.** O turno de plano gasta parte da hora da sessão
  gratuita. A renovação de sessão por snapshot (#29) cobre o retrabalho que não caberia mais na sessão,
  dentro dos 90 minutos do run, e o teto de 15 minutos limita o pior caso.
- **Falso positivo do guarda de testes.** Uma refatoração que reescreve um teste com outro nome e menos
  asserções gera um achado. Fora de uma correção de bug, ele é `major` e volta ao construtor com o
  motivo. Se a issue citar o teste, vira `minor`.

## Alternativas consideradas

- **Manter como está.** Custo zero, mas o revisor continua sem saber o que o construtor pretendia, e um
  teste enfraquecido depende de ser notado por um modelo.
- **Plano aprovado por uma pessoa antes do build.** Pega o erro de direção mais cedo, mas para toda
  task à espera de alguém, o que vai contra o objetivo da fábrica. Pode voltar como opção por repositório
  se os dados mostrarem planos errados com frequência.
- **Plano num agente separado (um "planejador").** O build perderia a leitura que o planejador fez, e
  seria mais uma sessão para pagar e coordenar.
- **Plano no mesmo turno do build, como primeira parte da resposta.** Mais barato, mas o plano seria
  escrito com o código já mudando e não poderia ser gravado antes da primeira edição.
- **Pedir ao revisor que procure testes enfraquecidos.** Já acontecia, sem garantia. Um fato que dá para
  checar sem modelo fica num guarda, como o script `test` e `.github/`.
- **Rodar os testes da base contra o código novo** para ver se continuam passando. Pega mais casos, mas
  custa outra rodada de checks por task, e um teste removido nem roda. Fica para quando houver um caso
  real que o guarda de diff não pegue.

## Consequências

- O PR e o painel mostram o que o construtor pretendia, e o revisor tem contra o que medir o diff.
- Uma task nova passa por `plan` antes de `build`, e o painel mostra o estágio como "planning".
- Os dois guardas novos usam heurísticas de texto. Um framework de teste com outra sintaxe (por exemplo,
  `#[test]` em Rust) não é lido. O guarda não falha nesse caso: só não aponta nada.
