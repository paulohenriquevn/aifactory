# aifactory

Software factory that turns GitHub issues into verified pull requests. The plan, milestones and
current state are in `docs/PLAN.md`; the decisions behind it are in `docs/adr/`.

Context for coding agents working **on this repository** — Cursor, Copilot, Claude Code and
TheoKit itself all read this file. It sits at the root and is discovered from any subdirectory, so
it is the right place for what someone needs to know before changing code here.

> **Not the same file as `.theokit/THEO.md`.** This one describes the codebase, for agents that
> write it. That one describes your product, for the agent that talks to your users. Two audiences,
> two files — see the table at the bottom.

## Commands

| What                 | Command                                 |
| -------------------- | --------------------------------------- |
| Run in development   | `npm run dev`                           |
| Build for production | `npm run build`                         |
| Serve the build      | `npm start`                             |
| Tests (unit)         | `npm test`                              |
| Tests (Postgres)     | `npm run test:integration`              |
| Types                | `npm run typecheck`                     |
| Lint / format        | `npm run lint` · `npm run format:check` |

The integration suite needs Postgres (`docker compose up -d`) and `DATABASE_URL` exported; it fails
without it on purpose. It never touches that database: a setup file points the suites at
`<name>_test` on the same server, creating it when missing, because they truncate their tables and
the real one holds the factory's tasks.

Run `typecheck` and `test` before proposing a change is finished. `format:check` runs in the same
suite, so a formatting slip fails the build rather than surfacing in review.

## Layout

```
src/app/            frontend — the only half that reaches a browser
src/server/         backend — never leaves the machine
  agents/           the agent, its tools, prompts, skills and hooks (empty until M2)
  panel/            what the panel shows and does: queries, actions, owner session, event stream
  crons/            defineCron files (`poll-answers`)
  db/               Postgres config, pool, Drizzle schema, health probe
  ingest/           GitHub delivery: decide, record (ingress + task), signed webhook handler
  factory/          one task end to end: sandbox, agent, push, stage history
  github/           GitHub App auth (repository-scoped tokens) and issue reads
  jobs/             defineJob files; `run-task` runs a task
  routes/           file-based HTTP
src/shared/         contracts both sides import (`panel.ts` is what the panel API returns)
.theokit/           agent context read at runtime (no rebuild)
```

The paths are declared in `theo.config.ts`. Move them there if you move them at all — the framework
reads that file, not a convention.

## Conventions

- **An agent is a file.** `src/server/agents/chat.ts` is served at `POST /api/agents/chat`. Adding
  a second agent means adding a second file, not registering anything.
- **Sub-folders under `agents/` are semantic, not routes.** `tools/`, `skills/`, `prompts/` and
  `hooks/` are skipped by the route scanner, so `tools/weather.ts` never becomes an endpoint.
- **TheoKit first.** Before adding a library or a mechanism, check what `theokit` already ships.
  A gap becomes an issue on `usetheokit/theokit`, and a workaround cites it.
- **One Postgres pool, owned by TheoKit.** Get it from `getPool()`, which goes through
  `getStorageManager().usePostgres`. Never `new pg.Pool` in application code: the manager drains
  it on shutdown and keeps the process alive when Postgres drops an idle connection.
- **Jobs are TheoKit jobs.** Queue work with `ctx.queue` (`enqueueInTransaction` when it must commit
  with a row), never a queue of our own. List each job in `types/jobs.d.ts`.
- **Sandboxes are TheoKit `SandboxBackend`s.** An agent runs only in a sandbox built from an
  explicit domain allowlist (`createIsolatedSandbox`). Credentials are attached by the firewall and
  never written to a command, a file or an env var inside the sandbox. Text that came from an issue
  reaches git by file, never through a shell.
- **GitHub tokens are repository-scoped.** The App is installed on every repository of the account,
  so `installationToken(repo)` is the only way to get one, and it always names the repository.
- **`src/server/jobs/` holds only jobs.** `theokit build` treats every file there as one and fails the
  build on a helper; a test guards it. Shared helpers live in `factory/`.
- **Panel routes are owner-only.** `.policy(ownerOnly)` on everything under `/api/panel` but the login;
  `.policy('public')` is for the webhook and the probes. The panel never goes through the tunnel.
- **Commits carry no co-author trailer.**
- **Validate at the boundary.** A route validates input with Zod once, then trusts it.
- **Side effects get a human.** A tool that touches the real world is gated with `.approval(...)`
  in `chat.ts`, not with a check buried inside the tool.

## The two context files

|          | `AGENTS.md` (this file)                     | `.theokit/THEO.md`                   |
| -------- | ------------------------------------------- | ------------------------------------ |
| Audience | agents that **write** this code             | the agent your **users** talk to     |
| Content  | commands, layout, conventions               | product facts, domain vocabulary     |
| Read by  | many tools (root, walks up to the git root) | TheoKit only, this directory         |
| Priority | 10 — anything else can override it          | 60 — the strongest file-layer source |

Because `THEO.md` wins conflicts, keep facts there and preferences here.
