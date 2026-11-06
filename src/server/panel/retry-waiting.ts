import { ActionRefused, retry, type ActionDeps } from './actions'
import { listTasks } from './queries'

/**
 * Starts again every task that failed for a reason that passes by itself: the ones the board lists as "Will
 * retry itself". Used once the agent that ran out has been replaced. A task the panel refuses to start again
 * (it moved on since the board was read) is counted and left; any other failure, such as GitHub refusing to
 * delete the branch, is thrown, because the rest would fail the same way.
 */
export async function retryWaiting(
  deps: ActionDeps,
): Promise<{ started: number; skipped: number }> {
  const waiting = (await listTasks(deps.db)).filter((c) => c.stage === 'failed' && c.retryable)
  let started = 0
  let skipped = 0
  for (const card of waiting) {
    try {
      await retry(deps, card.id)
      started += 1
    } catch (error) {
      if (!(error instanceof ActionRefused)) throw error
      skipped += 1
    }
  }
  return { started, skipped }
}
