import { and, eq, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { ingress, repository, stageEvent, task } from '../db/schema'

import { decideIngress } from './decide'

export type Delivery = {
  /** The `X-GitHub-Delivery` header. */
  deliveryId: string
  /** The `X-GitHub-Event` header. */
  event: string
  payload: unknown
}

export type RecordResult =
  | { status: 'duplicate' }
  | { status: 'ignored'; code: string; reason: string }
  | { status: 'task_created'; taskId: number }
  | { status: 'task_exists'; taskId: number }

/**
 * An issue asking for work in a repository the owner has not enabled is recorded and ignored. The
 * App is installed on every repository of the account, so the label alone is not permission.
 */
async function withRepositoryPermission(
  tx: Database,
  decision: ReturnType<typeof decideIngress>,
): Promise<ReturnType<typeof decideIngress>> {
  if (!decision.accept) return decision
  const [allowed] = await tx
    .select({ id: repository.id })
    .from(repository)
    .where(
      and(
        sql`lower(${repository.fullName}) = lower(${decision.repository})`,
        eq(repository.enabled, true),
      ),
    )
  if (allowed) return decision
  return {
    accept: false,
    code: 'repository_disabled',
    reason: `${decision.repository} is not enabled for the factory: enable it in the panel`,
    repository: decision.repository,
  }
}

/**
 * Records one delivery and, when it asks for work, the task. Both writes are one transaction, so
 * a delivery is never recorded without the task it created. A delivery ID already on file is a
 * redelivery and changes nothing. A second delivery for an issue that already has a task is
 * recorded and points at the existing one.
 */
export async function recordDelivery(
  db: Database,
  delivery: Delivery,
  /** Runs inside the transaction once a task exists, so whatever it writes commits or rolls back with it. */
  onTaskCreated?: (taskId: number) => Promise<unknown>,
): Promise<RecordResult> {
  const asked = decideIngress(delivery.event, delivery.payload)

  return db.transaction(async (tx) => {
    const decision = await withRepositoryPermission(tx, asked)
    const [row] = await tx
      .insert(ingress)
      .values({
        deliveryId: delivery.deliveryId,
        event: delivery.event,
        repository: decision.repository,
        payload: delivery.payload,
        outcome: decision.accept ? 'task_created' : 'ignored',
        code: decision.code,
        reason: decision.reason,
      })
      .onConflictDoNothing({ target: ingress.deliveryId })
      .returning({ id: ingress.id })

    if (!row) return { status: 'duplicate' }
    if (!decision.accept) return { status: 'ignored', code: decision.code, reason: decision.reason }

    const [created] = await tx
      .insert(task)
      .values({
        ingressId: row.id,
        repository: decision.repository,
        issueNumber: decision.issueNumber,
        issueTitle: decision.issueTitle,
      })
      .onConflictDoNothing({ target: [task.repository, task.issueNumber] })
      .returning({ id: task.id })
    if (created) {
      await tx.insert(stageEvent).values({ taskId: created.id, stage: 'intake' })
      await onTaskCreated?.(created.id)
      return { status: 'task_created', taskId: created.id }
    }

    const [existing] = await tx
      .select({ id: task.id })
      .from(task)
      .where(
        and(eq(task.repository, decision.repository), eq(task.issueNumber, decision.issueNumber)),
      )
    await tx.update(ingress).set({ outcome: 'task_exists' }).where(eq(ingress.id, row.id))
    return { status: 'task_exists', taskId: existing.id }
  })
}
