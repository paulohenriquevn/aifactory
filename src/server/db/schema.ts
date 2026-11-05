import {
  boolean,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'

/** The stages of a task, in the order a successful run passes through them. */
export const TASK_STAGES = [
  'intake',
  'sandbox',
  'build',
  'push',
  'verify',
  'review',
  'waiting',
  'pr',
  'done',
  'released',
  'handoff',
  'failed',
] as const
export type TaskStage = (typeof TASK_STAGES)[number]

/**
 * One row per webhook delivery GitHub sends, kept whether or not it became work. The delivery ID
 * is unique, so a redelivery cannot be processed twice.
 */
export const ingress = pgTable('ingress', {
  id: serial('id').primaryKey(),
  deliveryId: text('delivery_id').notNull().unique(),
  event: text('event').notNull(),
  repository: text('repository'),
  payload: jsonb('payload').notNull(),
  outcome: text('outcome', { enum: ['task_created', 'task_exists', 'ignored'] }).notNull(),
  /** Stable code for the decision, so a refusal can be counted and searched. */
  code: text('code').notNull(),
  reason: text('reason').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
})

/** A unit of work for the factory. One per issue, whichever delivery asked for it first. */
export const task = pgTable(
  'task',
  {
    id: serial('id').primaryKey(),
    ingressId: integer('ingress_id')
      .notNull()
      .references(() => ingress.id),
    repository: text('repository').notNull(),
    issueNumber: integer('issue_number').notNull(),
    issueTitle: text('issue_title').notNull(),
    stage: text('stage', { enum: TASK_STAGES }).notNull().default('intake'),
    /** The commit the factory pushed. Evidence counts only when it names this SHA. */
    headSha: text('head_sha'),
    pullRequestUrl: text('pull_request_url'),
    /** The commit on the integration branch once the factory merged the pull request. */
    mergedSha: text('merged_sha'),
    /** What the run has spent so far, agents included. It grows while the run is going. */
    costUsd: real('cost_usd').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('task_issue_unique').on(table.repository, table.issueNumber)],
)

/** Every stage a task entered, in order. `task.stage` is only the latest of these. */
export const stageEvent = pgTable('stage_event', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .notNull()
    .references(() => task.id),
  stage: text('stage', { enum: TASK_STAGES }).notNull(),
  detail: jsonb('detail'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * What the factory itself observed about a commit: a check it ran, on that SHA, with its real exit
 * code. An agent's account of its own work is never stored here.
 */
export const evidence = pgTable('evidence', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .notNull()
    .references(() => task.id),
  name: text('name').notNull(),
  command: text('command').notNull(),
  sha: text('sha').notNull(),
  exitCode: integer('exit_code').notNull(),
  timedOut: boolean('timed_out').notNull(),
  passed: boolean('passed').notNull(),
  /** The tail of stdout and stderr. */
  output: text('output').notNull(),
  durationMs: integer('duration_ms').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * What an independent reviewer decided about one commit. `invalid` is an answer the factory could
 * not read as a verdict, which counts as no approval.
 */
export const review = pgTable('review', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .notNull()
    .references(() => task.id),
  round: integer('round').notNull(),
  sha: text('sha').notNull(),
  reviewer: text('reviewer').notNull(),
  verdict: text('verdict', { enum: ['approve', 'changes', 'invalid'] }).notNull(),
  summary: text('summary').notNull(),
  findings: jsonb('findings').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A question an agent could not go on without. The sandbox was snapshotted when it was asked, so an
 * answer resumes the same session, with the same checkout, in a new sandbox. Everything needed to do
 * that lives here, because by then the process that asked may be gone.
 */
export const question = pgTable('question', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .notNull()
    .references(() => task.id),
  body: text('body').notNull(),
  /** The comment the factory posted on the issue. */
  commentId: text('comment_id').notNull(),
  askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
  snapshotId: text('snapshot_id').notNull(),
  sessionId: text('session_id').notNull(),
  harness: text('harness').notNull(),
  repoDir: text('repo_dir').notNull(),
  baseSha: text('base_sha').notNull(),
  /** The attempt the question interrupted, so the budget of three carries over. */
  attempt: integer('attempt').notNull(),
  /** What the run had spent when it stopped. */
  costUsd: real('cost_usd').notNull(),
  answer: text('answer'),
  answeredBy: text('answered_by'),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  /** Set once, atomically, by the run that takes the answer, so two cannot resume one question. */
  resumedAt: timestamp('resumed_at', { withTimezone: true }),
})

/**
 * What a person decided about a task from the panel. `approve` is pinned to the commit the person
 * looked at, so a later commit is not covered by it. `request_changes` carries what to change.
 */
export const decision = pgTable('decision', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .notNull()
    .references(() => task.id),
  kind: text('kind', {
    enum: ['approve', 'request_changes', 'retry', 'release', 'would_release'],
  }).notNull(),
  /** The head commit when the person decided. */
  sha: text('sha'),
  note: text('note').notNull().default(''),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * What the factory delivered. A pre-release is the factory's own delivery and it makes one whenever
 * it has work worth handing over: a tag on the commit with the evidence behind it, marked as a
 * pre-release, that moves nothing on the default branch. A release is the promotion of that work
 * (the merge and the final tag), made by a person or by an agent's verdict.
 */
export const delivery = pgTable('delivery', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .notNull()
    .references(() => task.id),
  kind: text('kind', { enum: ['prerelease', 'release'] }).notNull(),
  tag: text('tag').notNull(),
  url: text('url').notNull(),
  /** The commit the tag points at. */
  sha: text('sha').notNull(),
  /** `factory`, `human` or `agent:<name>`. */
  actor: text('actor').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A release under watch. After the factory (or a person through it) merges a pull request, the
 * checks on the merge commit are watched. If they turn red the factory opens a pull request that
 * reverts the merge, and goes no further: a person decides whether to merge it.
 */
export const watch = pgTable('watch', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .notNull()
    .references(() => task.id),
  repository: text('repository').notNull(),
  /** The merge commit on the default branch. */
  sha: text('sha').notNull(),
  /** The pull request that was merged, which is what a revert undoes. */
  pullRequestNumber: integer('pull_request_number').notNull(),
  /** The release tag, when there is one, for the notes. */
  tag: text('tag'),
  status: text('status', {
    // `reverting` is a red main whose revert is still being opened, so it is not shown as red yet.
    enum: ['watching', 'reverting', 'green', 'red', 'silent'],
  })
    .notNull()
    .default('watching'),
  /** The revert pull request, once the factory opened one. */
  revertUrl: text('revert_url'),
  /** Why the watch ended the way it did: the failing checks, a refused revert, a silent main. */
  detail: text('detail'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  /** When a person said they dealt with a red main, so it leaves the inbox. */
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
})

/**
 * One execution of an agent: a build pass, a rework, a pass that continued after an answer, or a
 * review. It is what a task's cost is made of, so a cost can be said per execution, per agent and per
 * role. `costUsd` is empty for an agent that does not report one.
 */
export const agentRun = pgTable('agent_run', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .notNull()
    .references(() => task.id),
  role: text('role', { enum: ['builder', 'reviewer'] }).notNull(),
  harness: text('harness').notNull(),
  attempt: integer('attempt').notNull(),
  costUsd: real('cost_usd'),
  durationMs: integer('duration_ms').notNull(),
  ok: boolean('ok').notNull(),
  /** The agent stopped because its account's quota ran out. */
  quota: boolean('quota').notNull().default(false),
  sessionId: text('session_id'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * What the supervisor found wrong with the factory itself. `stalled` is work that stopped moving.
 * `orphaned` is something that waits for a thing that is gone: a job nobody queued, a resume that never
 * ran, a snapshot no question needs. A finding stays open while it is true and resolves when it is not.
 */
export const finding = pgTable('finding', {
  id: serial('id').primaryKey(),
  /** Identifies the problem, so the same one is not reported twice. */
  key: text('key').notNull().unique(),
  kind: text('kind', { enum: ['stalled', 'orphaned'] }).notNull(),
  subject: text('subject', {
    enum: ['run', 'queued_run', 'answer_resume', 'snapshot', 'revert'],
  }).notNull(),
  taskId: integer('task_id').references(() => task.id),
  /** What the finding points at when it is not a task: a snapshot id, a question or a watch. */
  ref: text('ref'),
  detail: text('detail').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
})

/**
 * A webhook the factory asked GitHub to send again, so a delivery that keeps failing is tried a few
 * times and then left alone, instead of every five minutes for as long as GitHub keeps it.
 */
export const webhookRedelivery = pgTable('webhook_redelivery', {
  guid: text('guid').primaryKey(),
  attempts: integer('attempts').notNull().default(0),
  lastAt: timestamp('last_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A repository the owner has let the factory work in. The GitHub App is installed on every
 * repository of the account, so being reachable is not permission: only a row with `enabled` makes a
 * labelled issue become a task. The columns after `enabled` are what the owner sets per project, and
 * an empty one means the factory's default.
 */
export const repository = pgTable('repository', {
  id: serial('id').primaryKey(),
  fullName: text('full_name').notNull().unique(),
  enabled: boolean('enabled').notNull().default(false),
  /** The checks a commit must pass: `[{ name, command }]`. Empty means `npm test`. */
  checks: jsonb('checks').$type<{ name: string; command: string }[]>(),
  /** Domains the sandbox may reach besides GitHub, the agent and the npm registry. */
  egress: jsonb('egress').$type<string[]>().notNull().default([]),
  /** The branch the work starts from and the pull request targets, when it is not the default branch. */
  baseBranch: text('base_branch'),
  /** The agent that builds and the one that reviews, when not the factory's default. */
  harness: text('harness'),
  reviewer: text('reviewer'),
  releaseMode: text('release_mode', { enum: ['manual', 'trial', 'auto'] }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A plan: a goal the owner wrote for a repository, broken by an agent into issues. The owner edits the
 * items and decides which become real issues on GitHub, and whether they start at once.
 */
export const plan = pgTable('plan', {
  id: serial('id').primaryKey(),
  repository: text('repository').notNull(),
  goal: text('goal').notNull(),
  status: text('status', { enum: ['planning', 'ready', 'failed', 'created'] })
    .notNull()
    .default('planning'),
  summary: text('summary').notNull().default(''),
  error: text('error'),
  costUsd: real('cost_usd').notNull().default(0),
  /** The GitHub milestone the issues were gathered under, once created. */
  milestoneNumber: integer('milestone_number'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const planItem = pgTable('plan_item', {
  id: serial('id').primaryKey(),
  planId: integer('plan_id')
    .notNull()
    .references(() => plan.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  selected: boolean('selected').notNull().default(true),
  issueNumber: integer('issue_number'),
  issueUrl: text('issue_url'),
  /** True once the `factory` label is on the issue, which is what starts the work. */
  started: boolean('started').notNull().default(false),
})
