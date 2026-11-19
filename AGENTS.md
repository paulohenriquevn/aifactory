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
                    `catch-up`, `retry-due`, `knowledge-sync`, `prune-transcripts`, `coordinate`, `schedule`)
  metrics/          the factory's own indicators, their daily points and control bands (`config.ts`)
  knowledge/        the owner's knowledge repository: mirror, sync, the slice each agent gets, notes
  db/               Postgres config, pool, Drizzle schema, health probe
  ingest/           GitHub delivery: decide, record (ingress + task), signed webhook handler
  coordinator/      the factory's exceptions: facts, recognition, one decision, applying it (ADR 0011)
  scheduler/        the order of the queued runs and the readiness of newly queued issues
  factory/          one task end to end: sandbox, agent, push, stage history; the repository doctor
  github/           GitHub App auth (repository-scoped tokens) and issue reads
  jobs/             defineJob files; `run-task` runs a task, `merge-task` opens and integrates the pull request
                    of approved work, `prove-checks` proves proposed checks
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
- **Every call to the GitHub API goes through `gated` (`github/rate-limit.ts`).** It counts the call for the
  cron pass it is made in, records the `x-ratelimit-*` budget GitHub reports, and throws `RateLimited` with the
  reset time for a refusal for the limit. A cron that calls GitHub wraps its handler in `githubPass`, which logs
  `github_requests` per pass; one that only polls passes `waitsForLimit` and skips its passes while the
  installation's budget is under its reserve. A read that many tasks of one pass share goes through `passReads`.
- **`src/server/jobs/` holds only jobs.** `theokit build` treats every file there as one and fails the
  build on a helper; a test guards it. Shared helpers live in `factory/`.
- **A delivery is taken, routed or ignored, and `decideIngress` is the only place that says which.** An
  `issues` delivery that is labelled `factory`, or opened with the label, is taken and becomes a task. A
  comment (`issue_comment`, `pull_request_review_comment`), a submitted `pull_request_review`, a completed
  `check_suite` or `check_run`, and an issue that is closed, reopened or loses the `factory` label are
  routed: `ingress.outcome` is `routed`, the code names the intent, and `recordDelivery` creates no task and
  queues no job for it. An issue that is closed or loses the label cancels its task when `outcome()` says
  `cancel` (`ingest/withdraw.ts`, in the same transaction): the `cancelled` stage event names why, and the
  task's queued jobs that no worker ever took are deleted. A run records its stages with `enterRunStage`
  (`factory/stages.ts`), which asks `transitions.ts` (`run_step`) and throws `TaskCancelled` for a cancelled task, so
  the run stops at its next stage, records nothing more and does not fail it. Nothing acts on the other routed deliveries yet. A new event is a new entry in `ROUTES` with a
  Zod schema that produces its intent, and the setup report reads `ROUTED_EVENTS` to say which events the
  App does not subscribe to. Any other event or action keeps the code it always had.
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
- **The doctor never calls fine what it did not read.** `factory/doctor.ts` decides over facts and reads
  nothing; `factory/doctor-facts.ts` reads and decides nothing. A read that fails is a fact that was not
  read, and its item is `unknown` with what was tried. A new diagnosis is a new item function and a new
  fact, listed in `DOCTOR_ITEMS`. The doctor asks GitHub only for what the App's permissions allow, and
  `repairRepository` does only what the App can do (create a branch, create the label).
- **Only a proof stores a check as proven.** `proveChecks` in `factory/prove-checks.ts` runs proposed checks
  on the head of the integration branch, all in one sandbox that it always stops, and the `prove-checks` job
  saves only the ones that passed, with the commit (`repository.checks_proven_sha`, `checks_proven`). A check
  cut at its limit is `too_slow`, never `failed`. The settings form saves what the owner types and answers
  with `unprovenChecks`. No agent runs in that sandbox, which is why it opens no knowledge feed
  (`NO_AGENT` in `every-agent.test.ts`): a file listed there may not mention a harness.
- **Every text box in the panel has an `<Assist>`.** `src/app/every-box.test.ts` fails when a file with a
  textarea has none. The premise is that the owner never has to be a programmer.
- **Panel routes are owner-only.** `.policy(ownerOnly)` on everything under `/api/panel` but the login;
  `.policy('public')` is for the webhook and the probes. The panel never goes through the tunnel.
- **Approved work is merged by a job of its own.** When the review approves, `Run.approved` keeps the handover
  of work the factory never integrates (`heldFor`) and the settling of a closed pull request (`reopenedOrEmpty`),
  then enters `merge` and queues `merge-task` in one transaction (`enterMerge` in `factory/merge-task.ts`). The
  stage's detail holds everything the pull request and the delivery need, so the job needs no sandbox. The job
  asks `transitions.ts` (`merge_due`) and does nothing for a task that left `merge` or a commit other than the one
  waiting; it enters `pr`, opens the pull request, integrates it (`integrate` in `factory/integration.ts`) and
  delivers it or leaves it waiting for CI, as below. A failure is `failed` at `merge` or `pr`, like a run's.
- **Three branches, the same in every repository.** `workspace` integrates: the factory merges its own pull
  request there, pinned to the verified commit, once the checks pass and the review approves. When the
  integration branch requires status checks, the factory merges nothing itself: it turns on auto-merge pinned
  to the verified commit (`task.awaiting_ci_sha`), and the `integrate-after-ci` cron finishes the integration
  after GitHub merges, or sends the work back when a required check fails. A required check that fails on the head of
  the integration branch too is the base's, not the task's (`decideWaitingIntegration` in `factory/ci-wait.ts`): the
  task keeps waiting, the checks blamed on the base are kept on its `done` event (`baseBlame`, for the verified commit),
  and once the base passes all of them the task runs again only to merge the base (`mergeFixedBase`, the job's
  `mergeBase`): `Run.mergeBase` merges the head of the integration branch into the work branch itself, with no agent,
  and pushes it, so the checks run again on a commit that is verified and reviewed. A conflict, or a branch that
  already holds that head, fails the run for a person. The base is read only when a required check failed.
  When GitHub refuses auto-merge because
  the pull request is already clean (its checks passed first), the factory merges it at once, pinned to the
  same commit, as if no check were required (`autoMergeOrMergeable` in `github/pulls.ts`). A pull request that is
  still the draft a handoff left is marked ready for review first, with its title restored (`titleToRestore`), on
  either path. Nothing else may merge there, with one
  exception: after a changesets release, `publish-changesets` merges the repository's back-merge, the open pull
  request from the release branch into the integration branch of the same repository (never a fork), with a
  merge commit pinned to its head once its checks are green (`pickBackMerge` in `factory/changesets.ts`). `develop` is
  the pre-release: it advances to each integration, which gets a pre-release tag. When `develop` takes changes
  only through a pull request, the factory opens its promotion from the integration branch and turns on
  auto-merge pinned to the head it saw (`pinPromotion` in `factory/promotion-merge.ts`), only on a pull request
  from the integration branch of the same repository into `develop` (`isFactoryPromotion`: never a fork, never
  another head); a clean one is merged at once with a merge commit pinned to the same head. An open promotion that nothing waits on, in a repository whose integrated work waits for a release, is pinned the same way by the `integrate-after-ci` cron (`adoptPromotions`). While it waits in
  `promotion_wait`, new integrations are held out of the integration branch until `hold_until`
  (`PROMOTION_HOLD_MS`), so its checks can finish: the task waits in `done` with `awaiting_ci_sha` and
  `integration_held`, and the `integrate-after-ci` cron integrates it on the first pass after the hold expires
  or after GitHub merged the promotion. A head that moved before the pin is not merged; the next pass pins the new
  head. Nothing else merges a pull request into `develop`. The default branch
  (`main`) is the release. The factory never merges into it on its own account: a release is a promotion of
  `develop`, goes through `release()` in `factory/deliver.ts` with its refusals, and only a person, an agent's
  verdict in `FACTORY_RELEASE_MODE=auto`, or the coordinator's release train in a repository whose release mode
  is `auto` may start it. When the release branch requires status
  checks, `release()` merges nothing either: it turns on auto-merge pinned to the head it saw and records a
  `release_wait`, and the `integrate-after-ci` cron finishes the release after GitHub merges, or refuses it
  with the reason when a required check fails. A clean release pull request is merged at once, the same way. A refused release is retried only by the release train, once per head of `develop`, and only when
  its cause ends by itself (`passingRefusal`: required checks still expected, running or never reported, a head
  that moved); a second refusal on the same head stays refused, and a new head is a new attempt. Every release, tagged by the factory or published by changesets, releases each finished task
  whose merge is in the promoted commit and closes its issue through `shipContained` in `factory/ship.ts`; an
  issue that will not close is recorded, never thrown. `ensureBranches` creates the two missing
  branches, never touches one that exists, and refuses the default branch as the integration branch.
- **A repository that publishes with changesets tags its own releases.** When `.changeset/config.json` is on
  `develop` and a changeset waits, `release()` makes no tag: it promotes and records a `publication`. A changeset
  waits only when the comparison of `develop` with the release branch lists it as added since their merge base
  and it names a package (`changesetsWaiting`); one a past release consumed on the release branch but `develop`
  still holds does not, and neither does an empty one, which releases nothing.
  With no changeset waiting, it reads what that comparison lists (`changed-packages.ts`):
  when a package changesets publishes changed, it refuses and names the package; when every change is in a
  private package, an ignored one (`ignore` in `.changeset/config.json`) or no package, the release is the
  factory's own, tagged after the highest `v` tag, since no changeset can exist for those. The `publish-changesets` cron merges the Version Packages pull
  request (`changeset-release/<release branch>`) once its checks are green, under the same decision, and
  only that pull request; when the workflow has published, it releases the tasks in the promoted commit and
  closes their issues with the versions. The workflow creates the releases one package at a time, so the
  publication waits for a release of every published package whose version the Version Packages merge moved
  (`versionedTags` in `changed-packages.ts`); 30 minutes after that merge it goes on with the releases that
  exist and names the missing ones in its detail. When the release workflow pushed the version branch after the promotion,
  ahead of the release branch, without opening a pull request from it, the factory opens Version Packages itself
  and the publication keeps waiting; it never ends while such a branch waits. When the run on the promoted commit
  finished without a Version Packages pull request or such a branch
  (`publication-end.ts`, after a 10 minute grace window), the publication ends: a failed
  check, or a promotion that changes a published package, fails it with the reason on the task; otherwise the
  promotion becomes the factory's own patch release. Such a repository also gets a `changeset` check,
  a script the factory writes into the sandbox before every round of checks (`changeset-check.ts`): it fails
  when a published package changed and no changeset the work added names it, and when the work added a
  changeset that names no package; a change only to private or ignored packages passes with no changeset.
  The script repeats the rules of `changesets.ts` in JavaScript a sandbox can run, so a change to which
  package counts as published goes into both.
- **The coordinator decides from a closed set and records every decision.** `coordinator/exception-facts.ts`
  reads and decides nothing; `exceptions.ts` recognises exceptions over those facts and reads nothing, and a
  fact that could not be read is an exception of kind `unknown`; `decide.ts` is a pure function from an
  exception, the decisions already recorded and the time to one action (`send_back`, `review_again`,
  `retry_from_finding`, `scope`, `release`, `prioritise`, `fix_base`, `merge_base`, `wait` or `escalate`). A `scope` gets its text from `draft.ts`, the step between deciding and
  applying, where a drafter built by `buildAssistant` answers JSON that `scope.ts` parses (an answer that does not
  parse is an `escalate`, and a draft naming a `QUALITY_CONFIGURATION` is `refused`); `apply.ts` is the only module with side effects and goes through the
  panel's actions (`sendBackByCoordinator`, which asks for `coordinator_send_back`, and `resolveFinding` with `automatic`, so a retry records no `decision`) and, for a release, `release()`, so
  `transitions.ts` is asked first, even before a scope's only writes of its own (the follow-up issue and
  `updateIssueBody`). A handoff records its `cause`, and an older one is recognised by the start
  of its `reason`. Every decision is a `coordinator_action` row, unique on task, exception kind and head except for a `trial` one, which leaves the head free for `auto`; a
  task gets at most two applied actions (`MAX_APPLIED`), then the next one is escalated. A failure of the work is
  told by how the run starts its reason (`factory/failure-reasons.ts`, `NO_TIME_FOR_AGENT`, `AGENT_OUT_OF_TIME`):
  `checks_red` is sent back on its branch with what the failing checks printed on the head (`evidence`, through
  `failingOutput`, escalated when nothing was kept), `out_of_time` is sent back to continue from the branch, and
  `no_change` is sent back once with what the run recorded, then escalated; each is told apart by its failure
  event (the head is `<sha>@<event id>`), a task that pushed nothing is escalated, and any other failure stays a
  `failure`, escalated. `coordinator_send_back` takes a `failed` task as it takes a handed-over one. A
  `checks_unchanged` whose handoff quoted no output is sent back with the same `failingOutput`, or, when the factory
  kept none either, with what the failed checks of the pull request's head logged on GitHub (`ciFailures`, through
  `readEvidence` and `ciFailingOutput`). One whose pull request conflicts with its base is a `merge_base`
  (`mergeBaseByCoordinator`, which asks for `coordinator_merge_base` and queues the run with `mergeBase`), and a
  merge that conflicts there fails with `baseConflict` and is a `base_conflict`, sent back with the files. An `unknown` is a
  `wait`: the first is recorded as `deferred` (which leaves the head free and is never `seen`), later passes
  record nothing, and it is escalated once the first wait is `UNKNOWN_LIMIT_MS` old. `FACTORY_COORDINATOR_MODE`
  is `off`, `trial` (the default: decide and record, apply nothing) or `auto`. No file under `coordinator/`
  calls a merge, and `merges-nothing.test.ts` fails if one does. A new exception is a new kind in
  `EXCEPTION_KINDS` and a new entry in `BY_KIND`; a new action goes through an action of the panel, never
  around it.
  An escalation of a task goes to the unblocker first (`unblock.ts`), and so does a builder's question (`question`, a
  `question` row with origin `agent` and no answer) once it waited `QUESTION_WAIT_MS`; a release, a reordering and a
  red base never do. `unblocker-facts.ts` reads the issue, its comments, the history, the reviews, the pull request and
  the failed jobs' logs (`ciFailuresOf`), and decides nothing; a read that fails is said in the message. The model is
  built by `buildAssistant` with no tools of its own (`UNBLOCKER_SPEC`, `FACTORY_UNBLOCKER_MODEL`), and its prompt is
  `agents/prompts/unblocker.ts`. `unblocker.ts` is pure: it parses the one action it answers (`answer`, `send_back`,
  `rerun_checks`, `merge_base`, `blocked_by`, `retry`, `scope`, `resolve_elsewhere`, `escalate`), keeps the
  escalation with the parse error for an answer that does not parse, and refuses an `escalate` without an owner
  category (`OWNER_CATEGORIES`), a `resolve_elsewhere` that names no full commit sha (`isEvidence`), a text that names a
  `QUALITY_CONFIGURATION`, and anything but `answer` or `escalate` for a waiting task. Its rows carry `by: unblocker`
  in `draft`, and `unblockerGate` stops it after `UNBLOCKER_MAX_APPLIED` applied actions on one commit or
  `UNBLOCKER_MAX_PER_TASK` on the task. `unblocker-apply.ts` carries out the actions only it decides through the
  panel's: an `answer` goes through `answerByCoordinator` (`coordinator_answer`), which stores the answer and queues
  `resume-task` in one transaction, since `pickAnswer` never takes a comment of the factory's own; `rerun_checks` and
  `blocked_by` ask `coordinator_send_back` before they touch GitHub and then send the task back with no note. A `retry`
  is refused for a task with pushed work, since starting over deletes its branch, and a `resolve_elsewhere` only goes
  through when the integration branch's history holds the named commit (`contains`), since it delivers the task. A pass
  without an unblocker in its dependencies escalates as before and reads no question.
  The release train (ADR 0010) is the `release_ready` playbook: `release-facts.ts` reads each enabled repository,
  `release-train.ts` decides over it and reads nothing. A repository in `auto` (its `release_mode`, or
  `FACTORY_RELEASE_MODE` when it has none) with integrated work (`done` with a `merged_sha`) that has reached `develop` (it holds commits the release branch lacks), no task queued, running or
  waiting for CI, no release or publication in flight and its release branch not red or still watched by
  `watch-main` gets one `release()` call per head of `develop`, as `agent:coordinator`, so `personDecisions` does
  not count it. The row is recorded on the repository's oldest such task, with the head of `develop`. The bump is
  `bumpFor`: `major` only for an issue labelled `breaking`, `minor` for one labelled `enhancement` or `feature`,
  `patch` otherwise; a changesets repository follows its changesets. A red release branch is a `release_blocked`
  exception, escalated, and nothing is called; the one retry of a passing refusal is a `release_retry` exception on
  the same head. A repository in `trial` gets its decision recorded as `trial`, and one in `manual` is never read.
  `MAX_APPLIED` neither counts a release nor holds one back.
  A task held by a red integration branch (`done.detail.baseHold`, set and cleared by `integrate-after-ci`, shown
  on the panel card as `waitingOnBase`), or a failed one still red on the base past its automatic runs, is a
  `base_red` exception once the red lasts `BASE_RED_LIMIT_MS`, one decision per commit and set of checks. It is a
  `fix_base`: in `auto` `apply.ts` files one issue on the repository (`base-fix.ts` writes it; labels `factory`,
  `bug`, `priority:1`, created when missing) naming the checks, the branch and the commit, once per repository,
  branch and set of checks (`baseSignature` in `failure_signature`, through `fileOnce`, the claim Evolve uses too),
  and again only after that issue closed. The tasks keep waiting for the base, `MAX_APPLIED` does not count it, and
  in `trial` it logs the issue it would file. It changes no task, so it asks `transitions.ts` nothing.
  Evolve (`evolve.ts` pure, `evolve-facts.ts` reads, `evolve-apply.ts` writes) files a failure signature seen on
  three tasks in a week, in two incidents an hour or more apart, as a `factory` issue on this repository, once per signature (`failure_signature`, never reading a `base_red:` one), at
  most one per pass and three per week, never a designed wait (`DESIGNED_WAITS`), nothing in `trial` but a
  log line, and a week after the issue closes it records both counts and comments when the signature still
  shows up.
- **A fix for a test that fails the repository's tasks goes ahead of them.** When one test fails on two tasks of a
  repository within six hours and a queued task's issue names it, `queue_blocked` decides `prioritise`:
  `queue-facts.ts` reads, `queue-order.ts` decides, and `queue-apply.ts` moves only that task's pending
  `run-task` job ahead of the repository's other pending jobs, by `available_at` in `theokit_jobs` (TheoKit has no
  call for it, usetheokit/theokit#2117), and holds that repository's other pending jobs back until the fix integrates, fails, waits for an answer or is handed
  to a person (only a person moves it on from there, so the others do not wait on one). The failures of the same test on
  other tasks wait for the fix too (`isHeld`, over the exception and the reason of the failure the task is in now,
  however old) while it is on its way. The decision's head is the test and the fix's job (`headOf`), so a retried
  fix is decided again and an ended hold never comes back. It is not counted by `MAX_APPLIED`, and merges nothing.
- **The scheduler orders the queue and holds back an issue that is not ready, and records every decision.**
  The `schedule` cron runs a pass every two minutes, one at a time on any process (`alone`, an advisory lock).
  `scheduler/facts.ts` reads the queued `run-task` jobs of tasks in `intake`, their issues and the decisions already
  recorded, and decides nothing; `order.ts` and `readiness.ts` decide and read nothing; `apply.ts` is the only module
  with side effects. First readiness: for each first run (no `decisionId`, `feedback`, `resume` or `mergeBase` in its
  input) whose issue has no verdict for its current title and body (`bodyHash`), a judge built by `buildAssistant`
  (`judge.ts`, the prompt in `agents/prompts/readiness.ts`) answers `ready` or `needs_refinement`, with what is missing
  and one question. An answer that does not parse is `ready` with its error recorded, and a judge that throws records
  nothing. In `auto` a `needs_refinement` task asks `transitions.ts` (`needs_refinement`, `ask_owner`), its queued run
  is deleted, the question goes on the issue with `questionComment`, a `question` row with `origin` `readiness` and no
  sandbox is stored and the task enters `waiting`, all in one transaction; `poll-answers` takes the answer, puts the
  task back in `intake` and queues its first run, whose prompt carries the answers (`clarifications`). Then the order:
  among the runs that are due and not held, lower `priority:N` first (no label sorts right after `priority:5`), then a
  `bug`, then the issue more queued issues name in their `Blocked by` line, then the oldest job, then the task id. In
  `auto` the sorted runs get the `available_at` times the queue already had, copied in one statement from the job
  that had each, under `HOLD_LOCK`; only rows whose time changes are written. The scheduler never touches a job a
  worker holds, that failed, that the coordinator holds (`heldFrom`, 'infinity'), that is not due, or of a task that
  left `intake`. Every decision is a `scheduler_decision` row: a `readiness` row once per task and issue version, an
  `order` row when a task's place or its reasons change. Each step has its own mode, `off`, `trial` (the default:
  decide and record, change no job, task or issue) or `auto`: `FACTORY_SCHEDULER_MODE` for the order and
  `FACTORY_READINESS_MODE` for the judge, since the order is a sort the tests prove and the judge holds back work
  only once its verdicts are compared with what became of the tasks. The panel's queued card shows its place, why and the
  verdict (`panel/queue-view.ts`).
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
- **A check that fails on the base is not the task's.** When a rework after failing checks changes nothing, or
  the same checks fail again on the next commit (`sameChecks`), `Run.refuseRedBase` runs those checks on the
  commit the work started from (`BaseProbe` in `factory/base-checks.ts`, in a checkout of its own, each check at
  most once per run). If every one fails there too, the run throws `BaseRed`: the
  failure records `baseRed`, `retryableFailure` reads it as `base`, and the task runs again on its own like an
  environment failure, from half an hour; past its automatic runs the coordinator escalates it as `base_red`.
  `run-case.ts` takes the same step and leaves such a case unmeasured.
- **Whether a stage allows an event is asked of `factory/transitions.ts`.** The table there declares the
  outcome of every pair of stage and event: the action, `ignored` or `refused`, with the reason a person
  reads. A panel action or a cron that checks a stage calls `outcome()` instead of comparing stages itself,
  and a new stage or event gets a row for every pair, which the types and a test require. Events nothing
  acts on yet are listed in `NOT_WIRED`.
- **The factory never integrates a change to its own agents or its gates.** When a task of the factory's own
  repository (`FACTORY_REPOSITORY` in `evals/cases.ts`, `ownRepository` for a fork) touches a file in
  `AGENT_CONFIGURATION` or under `src/server/agents/` (`heldForEvaluation`), or a quality gate or the test guard in
  `QUALITY_GATES` (`heldForReview`), approved work is handed over (`cause: agent_configuration`) as a draft pull
  request, and nothing is merged: the owner runs `pnpm evals:check` against the recorded baseline for the first,
  reads the second, and merges it. The coordinator has no playbook for that cause, so it escalates it (#139).
  Once a person merges the pull request a handoff left, the `integrate-after-ci` cron integrates the task from that
  merge (`adoptMergedHandoffs` in `factory/await-ci.ts`, the `merged_by_person` event): the pre-release is made as
  after the factory's own merge, and the release train or a person releases it and closes its issue. It starts no
  release itself.
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
