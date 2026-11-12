# aifactory

Software factory that turns GitHub issues into verified pull requests. The plan, milestones and
current state are in `docs/PLAN.md`; the decisions behind it are in `docs/adr/`.

Context for coding agents working **on this repository**: Cursor, Copilot, Claude Code and
TheoKit itself all read this file. It sits at the root and is discovered from any subdirectory, so
it is the right place for what someone needs to know before changing code here.

> **Not the same file as `.theokit/THEO.md`.** This one describes the codebase, for agents that
> write it. That one describes your product, for the agent that talks to your users. Two audiences,
> two files. See the table at the bottom.

## Commands

| What                 | Command                                                      |
| -------------------- | ------------------------------------------------------------ |
| Run in development   | `npm run dev`                                                |
| Publish a change     | `scripts/deploy.sh` (build, restart server, workers, feeder) |
| Build for production | `npm run build`                                              |
| Serve the build      | `npm start`                                                  |
| Tests (unit)         | `npm test`                                                   |
| Tests (Postgres)     | `npm run test:integration`                                   |
| Types                | `npm run typecheck`                                          |
| Lint / format        | `npm run lint` · `npm run format:check`                      |
| Quality gates        | `npm run quality` (coverage, CRAP, duplication, mutation)    |

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
  crons/            defineCron files (`poll-answers`, `watch-main`, `watch-promotions`, `publish-changesets`, `integrate-after-ci`, `supervise`, `measure`,
                    `catch-up`, `retry-due`, `knowledge-sync`, `prune-transcripts`)
  metrics/          the factory's own indicators, their daily points and control bands (`config.ts`)
  knowledge/        the owner's knowledge repository: mirror, sync, the slice each agent gets, notes
  db/               Postgres config, pool, Drizzle schema, health probe
  ingest/           GitHub delivery: decide, record (ingress + task), signed webhook handler
  factory/          one task end to end: sandbox, agent, push, stage history
  github/           GitHub App auth (repository-scoped tokens) and issue reads
  jobs/             defineJob files; `run-task` runs a task
  routes/           file-based HTTP
src/shared/         contracts both sides import (`panel.ts` is what the panel API returns)
.theokit/           agent context read at runtime (no rebuild)
```

The paths are declared in `theo.config.ts`. Move them there if you move them at all: the framework
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
- **A labelled issue is not permission.** The App is installed on every repository of the account, so ingestion
  turns an issue into a task only in a repository the owner enabled in the panel (`repository.enabled`).
  Listing what the App reaches is the one place a token is not limited to a repository, and it can only read
  metadata.
- **An agent that runs in the server process may call only the tools it declares.** The SDK gives every agent
  a shell and file access of its own, and the assistants run where the factory's credentials are, so each one
  carries `.hooks(onlyTools([...]))`. A new agent without it is a shell on the host.
- **Every agent reads the knowledge base, the same way.** An assistant is built only by `buildAssistant`,
  which gives it `knowledge_search` and `knowledge_read`; a file that starts a sandbox opens a
  `KnowledgeFeed` on it, which copies the project's slice to `/tmp/knowledge` and replaces it when the base
  moves. Only the `knowledge-sync` cron fetches or pushes, and only to `factory-memory`, never to the
  owner's branch. `src/server/knowledge/every-agent.test.ts` fails for an agent without it.
- **The knowledge repository is never a project.** Its rules change only through a pull request the owner
  merges, so `saveRepository` refuses to enable it and `saveKnowledge` refuses a repository that is enabled.
- **The knowledge base is an Open Knowledge Format 0.2 bundle.** `knowledge/okf.ts` holds the specification and
  nothing of the factory; `knowledge/format.ts` is the factory's layout on top of it. What the factory writes
  conforms (a test checks every file it writes), and what it reads may not: never refuse a bundle for missing
  front matter, an unknown type or a broken link (§11 of the specification).
- **Every text box in the panel has an `<Assist>`.** `src/app/every-box.test.ts` fails when a file with a
  textarea has none. The premise is that the owner never has to be a programmer.
- **Panel routes are owner-only.** `.policy(ownerOnly)` on everything under `/api/panel` but the login;
  `.policy('public')` is for the webhook and the probes. The panel never goes through the tunnel.
- **Three branches, the same in every repository.** `workspace` integrates: the factory merges its own pull
  request there, pinned to the verified commit, once the checks pass and the review approves. When the
  integration branch requires status checks, the factory merges nothing itself: it turns on auto-merge pinned
  to the verified commit (`task.awaiting_ci_sha`), and the `integrate-after-ci` cron finishes the integration
  after GitHub merges, or sends the work back when a required check fails. Nothing else may merge there, with one
  exception: after a changesets release, `publish-changesets` merges the repository's back-merge, the open pull
  request from the release branch into the integration branch of the same repository (never a fork), with a
  merge commit pinned to its head once its checks are green (`pickBackMerge` in `factory/changesets.ts`). `develop` is
  the pre-release: it advances to each integration, which gets a pre-release tag. The default branch
  (`main`) is the release. The factory never merges into it on its own account: a release is a promotion of
  `develop`, goes through `release()` in `factory/deliver.ts` with its refusals, and only a person or, in
  `FACTORY_RELEASE_MODE=auto`, an agent's verdict may start it. When the release branch requires status
  checks, `release()` merges nothing either: it turns on auto-merge pinned to the head it saw and records a
  `release_wait`, and the `integrate-after-ci` cron finishes the release after GitHub merges, or refuses it
  with the reason when a required check fails. A refused release is never retried on its own. Every release, tagged by the factory or published by changesets, releases each finished task
  whose merge is in the promoted commit and closes its issue through `shipContained` in `factory/ship.ts`; an
  issue that will not close is recorded, never thrown. `ensureBranches` creates the two missing
  branches, never touches one that exists, and refuses the default branch as the integration branch.
- **A repository that publishes with changesets tags its own releases.** When `.changeset/config.json` is on
  `develop` and a changeset waits there, `release()` makes no tag: it promotes and records a `publication`.
  With no changeset waiting, it reads what `develop` changes since the release branch (`changed-packages.ts`):
  when a package changesets publishes changed, it refuses and names the package; when every change is in a
  private package, an ignored one (`ignore` in `.changeset/config.json`) or no package, the release is the
  factory's own, tagged after the highest `v` tag, since no changeset can exist for those. The `publish-changesets` cron merges the Version Packages pull
  request (`changeset-release/<release branch>`) once its checks are green, under the same decision, and
  only that pull request; when the workflow has published, it releases the tasks in the promoted commit and
  closes their issues with the versions. Such a repository also gets a `changeset` check.
- **The factory opens a revert and never merges it.** `watch-main` may open a pull request that
  reverts a release when its merge commit goes red. Nothing in `factory/watch.ts` calls a merge, and a
  test fails if it does.
- **New code stays under the quality gates.** No new function over CRAP 30 (the baseline in
  `quality/crap-baseline.json` is empty, and an entry may only shrink), duplication under 1%, and a mutation score of 90 on the
  decision logic. A gate that fails is fixed with a test or a smaller function, not by raising the line.
- **A run is `Run`, one method per step.** `factory/run.ts` holds what changes during a run (cost, the
  agent's last words, its session) and a method for each step; `run-task.ts` is only the public entry
  points. A new step is a new method, not a branch inside another. The same step goes into
  `src/server/evals/run-case.ts`, which runs evaluation cases along the factory's path without pushing:
  without it, the suite measures a factory that no longer exists.
- **Commits carry no co-author trailer.**
- **Validate at the boundary.** A route validates input with Zod once, then trusts it.
- **Side effects get a human.** A tool that touches the real world is gated with `.approval(...)`
  in `chat.ts`, not with a check buried inside the tool.

## The two context files

|          | `AGENTS.md` (this file)                     | `.theokit/THEO.md`                  |
| -------- | ------------------------------------------- | ----------------------------------- |
| Audience | agents that **write** this code             | the agent your **users** talk to    |
| Content  | commands, layout, conventions               | product facts, domain vocabulary    |
| Read by  | many tools (root, walks up to the git root) | TheoKit only, this directory        |
| Priority | 10, anything else can override it           | 60, the strongest file-layer source |

Because `THEO.md` wins conflicts, keep facts there and preferences here.
