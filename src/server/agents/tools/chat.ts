import { tool } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../db'
import { effectiveEnv } from '../../factory/settings'
import { backlogProgress, describeTask, factoryStatus, findTasks } from '../../factory/chat-tools'
import { actionDeps, workDeps } from '../../panel/deps'
import { requestChanges, retry } from '../../panel/actions'
import { createJob } from '../../panel/work'

/** Reading: free. These return facts about the factory, and nothing that can change it. */

export const factoryStatusTool = tool('factory_status')
  .describe(
    'The state of the factory now: tasks by stage, the repositories it works in and how each is set up, how it is configured, and the progress of the backlog feeder.',
  )
  .input(z.object({}))
  .execute(async () => factoryStatus(getDb(), await effectiveEnv(getDb())))
  .build()

export const listTasksTool = tool('list_tasks')
  .describe(
    'List tasks, the most recently active first. Filter by stage (failed, done, build, waiting, handoff, released...), by the board column as the screen writes it (Queued, Working, Waiting for you, Will retry itself, Delivered, Released, Already resolved, Needs a person), or by part of the repository name.',
  )
  .input(
    z.object({
      stage: z.string().max(20).optional(),
      column: z.string().max(30).optional(),
      repository: z.string().max(100).optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(40)
        .optional()
        .describe('Leave it out unless you need fewer; the default is 15.'),
    }),
  )
  .execute(async (input) => findTasks(getDb(), input))
  .build()

export const taskDetailTool = tool('task_detail')
  .describe(
    'One task in detail: its latest events, the checks that ran and the review of the work.',
  )
  .input(z.object({ id: z.number().int().positive() }))
  .execute(async ({ id }) => describeTask(getDb(), id))
  .build()

export const backlogProgressTool = tool('backlog_progress')
  .describe(
    'How far the backlog feeder got: items tried, how many ended each way, and the ones that need attention with the reason.',
  )
  .input(z.object({}))
  .execute(
    async () => backlogProgress() ?? { note: 'the backlog feeder has not run on this machine' },
  )
  .build()

/**
 * Acting: each of these asks the owner first (`.approval` in the agent), because it changes the real world:
 * it runs an agent, opens an issue, or sends work back.
 */

export const retryTaskTool = tool('retry_task')
  .describe(
    'Start a failed or handed-over task again from the beginning. Its branch and pull request are deleted first.',
  )
  .input(z.object({ id: z.number().int().positive() }))
  .execute(async ({ id }) => {
    await retry(actionDeps(), id)
    return `Task ${id} was started again.`
  })
  .build()

export const requestChangesTool = tool('request_changes')
  .describe('Send a pull request back to the agent with a precise note about what to change.')
  .input(z.object({ id: z.number().int().positive(), note: z.string().min(3).max(4000) }))
  .execute(async ({ id, note }) => {
    await requestChanges(actionDeps(), id, note)
    return `Task ${id} was sent back with the note.`
  })
  .build()

export const startJobTool = tool('start_job')
  .describe(
    'Open an issue in an enabled repository and start the factory on it. The text must stand alone and end with "Done when:" and a list of things that can be checked.',
  )
  .input(
    z.object({
      repository: z.string().max(200).describe('owner/name of an enabled repository'),
      title: z.string().min(3).max(200),
      body: z.string().min(10).max(9000),
    }),
  )
  .execute(async (input) => {
    const made = await createJob(workDeps(), { ...input, start: true })
    return `Opened ${made.url} and started the factory on it.`
  })
  .build()
