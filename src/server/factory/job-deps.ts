import { getDb } from '../db'

import { factoryDeps } from './deps'
import { enterStage } from './stages'

/**
 * What a job needs, or a task that says why it could not start. Without the credentials no stage has
 * run yet, so the failure is recorded on the task instead of leaving it queued with nothing to show.
 */
export function jobDeps(taskId: number): ReturnType<typeof factoryDeps> | Promise<never> {
  try {
    return factoryDeps()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return enterStage(getDb(), taskId, 'failed', { failedAt: 'config', error: message }).then(
      () => {
        throw error
      },
    )
  }
}
