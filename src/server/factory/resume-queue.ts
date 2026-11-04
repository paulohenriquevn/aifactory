import { drizzle } from 'drizzle-orm/node-postgres'

import { getPool } from '../db'
import * as schema from '../db/schema'
import { jobBackend } from './job-backend'

import type { ActionDeps } from '../panel/actions'
import type { WorkDeps } from '../panel/work'

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

/** The same for a plan: its row and the `plan-run` job that has an agent read the repository commit together. */
export const inTransactionForPlan: WorkDeps['inTransaction'] = async (work) => {
  const client = await getPool().connect()
  try {
    return await drizzle(client, { schema }).transaction((tx) =>
      work(tx as never, async (planId) => {
        await jobBackend().enqueueInTransaction(client, {
          name: 'plan-run',
          input: { planId },
          idempotencyKey: `plan-${planId}`,
        })
      }),
    )
  } finally {
    client.release()
  }
}

/** The same for the panel: a decision and the `run-task` it starts commit together. */
export const inTransactionForRun: ActionDeps['inTransaction'] = async (work) => {
  const client = await getPool().connect()
  try {
    return await drizzle(client, { schema }).transaction((tx) =>
      work(tx as never, async (input, key) => {
        await jobBackend().enqueueInTransaction(client, {
          name: 'run-task',
          input,
          idempotencyKey: key,
        })
      }),
    )
  } finally {
    client.release()
  }
}
