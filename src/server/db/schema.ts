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
