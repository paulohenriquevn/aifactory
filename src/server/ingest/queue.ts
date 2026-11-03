import { drizzle } from 'drizzle-orm/node-postgres'
import type { QueueClient } from 'theokit/server/jobs'

import { getPool } from '../db'
import * as schema from '../db/schema'

import { recordDelivery, type Delivery } from './record'

/**
 * Stores the delivery and, when it created a task, queues the run in the same transaction: a task
 * row never exists without its job, and a job never exists for a task that rolled back.
 */
export async function recordAndQueue(delivery: Delivery, queue: QueueClient) {
  const client = await getPool().connect()
  try {
    return await recordDelivery(drizzle(client, { schema }), delivery, (taskId) =>
      queue.enqueueInTransaction(
        client,
        'run-task',
        { taskId },
        { idempotencyKey: `task-${taskId}` },
      ),
    )
  } finally {
    client.release()
  }
}
