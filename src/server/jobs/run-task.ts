import { defineJob } from 'theokit/server/jobs'
import { z } from 'zod'

import { getDb } from '../db'
import { factoryDeps } from '../factory/deps'
import { runTask } from '../factory/run-task'
import { enterStage } from '../factory/stages'

export default defineJob('run-task', {
  input: z.object({ taskId: z.number().int().positive() }),
  // A run that fails is recorded as the `failed` stage and goes to a person. Retrying it on its
  // own would spend the agent's budget again on the same issue.
  maxAttempts: 1,
  async handler({ input, signal }) {
    let deps
    try {
      deps = factoryDeps()
    } catch (error) {
      // Without the credentials no stage has run yet. Say so on the task instead of leaving it in
      // `intake` with nothing to show why.
      const message = error instanceof Error ? error.message : String(error)
      await enterStage(getDb(), input.taskId, 'failed', { failedAt: 'config', error: message })
      throw error
    }
    const result = await runTask(deps, input.taskId, signal)
    console.log(JSON.stringify({ event: 'task_finished', taskId: input.taskId, ...result }))
  },
})
