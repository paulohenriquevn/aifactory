import { and, eq } from 'drizzle-orm'

import type { Database } from '../db'
import { ingress, task } from '../db/schema'

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
 * Records one delivery and, when it asks for work, the task. Both writes are one transaction, so
 * a delivery is never recorded without the task it created. A delivery ID already on file is a
 * redelivery and changes nothing. A second delivery for an issue that already has a task is
 * recorded and points at the existing one.
 */
export async function recordDelivery(db: Database, delivery: Delivery): Promise<RecordResult> {
  const decision = decideIngress(delivery.event, delivery.payload)

  return db.transaction(async (tx) => {
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
    if (created) return { status: 'task_created', taskId: created.id }

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
