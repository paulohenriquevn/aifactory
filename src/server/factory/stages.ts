import { eq } from 'drizzle-orm'

import type { Database } from '../db'
import { stageEvent, task, type TaskStage } from '../db/schema'

/** Columns of `task` that change together with the stage. */
export type TaskPatch = Partial<{ headSha: string; pullRequestUrl: string; resolvedSha: string }>

/**
 * Moves a task to a stage and records that it did, in one transaction, so `task.stage` and the
 * `stage_event` history cannot disagree.
 */
export async function enterStage(
  db: Database,
  taskId: number,
  stage: TaskStage,
  detail?: Record<string, unknown>,
  patch: TaskPatch = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(stageEvent).values({ taskId, stage, detail: detail ?? null })
    await tx
      .update(task)
      .set({ stage, ...patch })
      .where(eq(task.id, taskId))
  })
}
