import { defineJob } from 'theokit/server/jobs'
import { z } from 'zod'

import { getDb } from '../db'
import { factoryDeps } from '../factory/deps'
import { withLeaseHeartbeat } from '../factory/lease'
import { resumeTask } from '../factory/run-task'
import { enterStage } from '../factory/stages'

export default defineJob('resume-task', {
  input: z.object({
    taskId: z.number().int().positive(),
    questionId: z.number().int().positive(),
  }),
  // A resume spends the agent's budget again, so like `run-task` it does not retry on its own.
  maxAttempts: 1,
  async handler({ input, signal, extendLease }) {
    let deps
    try {
      deps = factoryDeps()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await enterStage(getDb(), input.taskId, 'failed', { failedAt: 'config', error: message })
      throw error
    }

    await withLeaseHeartbeat(extendLease, async () => {
      const result = await resumeTask(deps, input.taskId, signal)
      console.log(
        JSON.stringify({
          event: 'task_resumed',
          taskId: input.taskId,
          questionId: input.questionId,
          ...result,
        }),
      )
    })
  },
})
