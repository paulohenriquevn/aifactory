import {
  boolean,
  integer,
  jsonb,
  pgTable,
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
  'pr',
  'done',
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
