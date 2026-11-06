import { getDb } from '../db'

import { factoryDeps } from './deps'
import { effectiveEnv } from './settings'
import { enterStage } from './stages'

/**
 * What a job needs, or a task that says why it could not start. Without the credentials no stage has
 * run yet, so the failure is recorded on the task instead of leaving it queued with nothing to show.
 */
export async function jobDeps(taskId: number): Promise<ReturnType<typeof factoryDeps>> {
  try {
    // The agent the owner chose in the panel is read now, so a change applies to the next run with no restart.
    return factoryDeps(await effectiveEnv(getDb()))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await enterStage(getDb(), taskId, 'failed', { failedAt: 'config', error: message })
    throw error
  }
}
