import { defineJob } from 'theokit/server/jobs'
import { z } from 'zod'

import { eq } from 'drizzle-orm'

import { getDb } from '../db'
import { decision } from '../db/schema'
import { jobDeps } from '../factory/job-deps'
import { withLeaseHeartbeat } from '../factory/lease'
import { runTask } from '../factory/run-task'
import { runContinuation } from '../factory/run-support'

export default defineJob('run-task', {
  input: z.object({
    taskId: z.number().int().positive(),
    /** The panel decision that started this run: a request for changes carries what to change. */
    decisionId: z.number().int().positive().optional(),
    /** What to change when the factory itself sent the work back, as for required checks that failed. */
    feedback: z.string().max(4_000).optional(),
  }),
  // A run that fails is recorded as the `failed` stage and goes to a person. Retrying it on its
  // own would spend the agent's budget again on the same issue.
  maxAttempts: 1,
  async handler({ input, signal, extendLease }) {
    const deps = await jobDeps(input.taskId)

    // The lease is two minutes and a run up to half an hour: renew it while the run is alive.
    await withLeaseHeartbeat(extendLease, async () => {
      const [decided] = input.decisionId
        ? await getDb().select().from(decision).where(eq(decision.id, input.decisionId))
        : []
      const continuation = runContinuation(decided, input.feedback)
      const result = await runTask(deps, input.taskId, signal, continuation)
      console.log(JSON.stringify({ event: 'task_finished', taskId: input.taskId, ...result }))
    })
  },
})
