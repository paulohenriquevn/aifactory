# ADR 0004: acesso da fábrica ao GitHub por GitHub App

Status: aceita (2026-11-03)

## Contexto

A fábrica lê issues, envia branches `factory/<n>`, abre pull requests e registra evidências como
check run. Um token pessoal serve para as três primeiras operações, mas a API de checks só aceita
escrita de um GitHub App: tokens de usuário e OAuth Apps podem ler check runs, não criá-los. Além
disso, a fábrica atende vários projetos, e um token pessoal dá acesso a todos os repositórios do
dono.

## Decisão

A fábrica acessa o GitHub como um GitHub App, `aifactory-paulohenriquevn`, registrado pelo fluxo de
manifest com `scripts/github-app-setup.mjs`.

- Permissões: Contents, Pull requests, Issues e Checks com escrita, e Metadata com leitura. A
  permissão de editar `.github/workflows` não foi pedida, para o agente não alterar as Actions do
  repositório.
- Cada execução mint um token de instalação de curta duração limitado ao repositório da task
  (`repositories: [<repo>]`). Nenhum token de longa duração fica guardado.
- As credenciais ficam fora do git: a chave privada em `.secrets/github-app.pem` e os demais valores
  em `.env.local`, ambos com permissão 600.
- O webhook do App substitui um webhook por repositório. Ele nasce desativado, com URL placeholder,
  e é ativado quando a fábrica tiver um endereço público. O secret gerado é o
  `GITHUB_WEBHOOK_SECRET` que a rota `/api/webhooks/github` já lê.

## Verificação

`scripts/github-app-check.mjs` rodou em 2026-11-03 contra `paulohenriquevn/aifactory-playground`
e observou: autenticação como App, token limitado a um repositório, criação e remoção de uma
branch, criação de um check run em `main` e recusa (HTTP 403) de escrita em um repositório fora do
token.

## Consequências

- A fábrica precisa implementar a autenticação de App: JWT assinado com RS256 e troca por token de
  instalação, como no script de verificação.
- Para cada projeto novo, o dono instala o App naquele repositório. A instalação deve ser por
  repositórios selecionados, não em todos.
- Um check run criado não pode ser apagado. O de verificação ficou em `main` do playground.
