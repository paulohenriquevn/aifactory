import { integer, jsonb, pgTable, serial, text, timestamp, unique } from 'drizzle-orm/pg-core'

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
    stage: text('stage', { enum: ['intake'] })
      .notNull()
      .default('intake'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('task_issue_unique').on(table.repository, table.issueNumber)],
)
