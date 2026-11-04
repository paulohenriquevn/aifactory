import { drizzle } from 'drizzle-orm/node-postgres'

import { getPool } from '../db'
import * as schema from '../db/schema'
import { jobBackend } from './job-backend'

import type { PollDeps } from './waiting'

/** Runs `work` in a transaction on one connection, with `resume-task` queued through that connection. */
export const inTransaction: PollDeps['inTransaction'] = async (work) => {
  const client = await getPool().connect()
  try {
    return await drizzle(client, { schema }).transaction((tx) =>
      work(tx as never, async (taskId, questionId) => {
        await jobBackend().enqueueInTransaction(client, {
          name: 'resume-task',
          input: { taskId, questionId },
          idempotencyKey: `resume-${questionId}`,
        })
      }),
    )
  } finally {
    client.release()
  }
}
