import { tool } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../db'
import {
  agentsForGuide,
  enginesForGuide,
  healthForGuide,
  inboxForGuide,
  planForGuide,
  promptForGuide,
  plansForGuide,
  repositoriesForGuide,
  setupForGuide,
} from '../../factory/guide-tools'
import { acknowledgeWatch, approve, resolveFinding } from '../../panel/actions'
import { changeAgentSettings } from '../../panel/agent-settings'
import { actionDeps, workDeps } from '../../panel/deps'
import { health, inbox } from '../../panel/queries'
import { repositoryPatchSchema } from '../../panel/repository-schema'
import { readSetup } from '../../panel/setup-live'
import {
  createPlan,
  createPlanIssues,
  getPlan,
  listPlans,
  listRepositories,
  saveRepository,
} from '../../panel/work'

/** Reading: free. What each page of the panel shows, as the guide of that page needs it. */

export const inboxTool = tool('inbox_items')
  .describe(
    'What waits for the owner now, oldest first: a question, a pull request nobody approved, work handed over after three tries, a failed run, a red main branch.',
  )
  .input(z.object({}))
  .execute(async () => inboxForGuide(await inbox(getDb())))
  .build()

export const healthTool = tool('health_report')
  .describe(
    'What the factory spent (24 hours, 7 days, total, by agent) and the open findings of the supervisor.',
  )
  .input(z.object({}))
  .execute(async () => healthForGuide(await health(getDb())))
  .build()

export const setupTool = tool('setup_report')
  .describe(
    'What stands between this install and a first pull request: each part, whether it is ready, and where to fix it.',
  )
  .input(z.object({}))
  .execute(async () => setupForGuide(await readSetup()))
  .build()

export const plansTool = tool('list_plans')
  .describe('The plans, newest first: the goal, its state and how many issues came of it.')
  .input(z.object({}))
  .execute(async () => plansForGuide(await listPlans(getDb())))
  .build()

export const planTool = tool('plan_detail')
  .describe(
    'One plan: the goal, the summary and each item with whether it became an issue and was started.',
  )
  .input(z.object({ id: z.number().int().positive() }))
  .execute(async ({ id }) => planForGuide(await getPlan(getDb(), id), id))
  .build()

export const repositoriesTool = tool('list_repositories')
  .describe(
    'The repositories GitHub lets the factory reach, whether each is enabled, and every setting it has.',
  )
  .input(z.object({}))
  .execute(async () => repositoriesForGuide(await listRepositories(workDeps())))
  .build()

/** Acting: each of these asks the owner first (`asks` in the guide), because it changes the real world. */

export const approveTool = tool('approve_task')
  .describe(
    'Approve the pull request of a task at the commit it is at now. It does not merge or release anything.',
  )
  .input(z.object({ id: z.number().int().positive() }))
  .execute(async ({ id }) => {
    await approve(actionDeps(), id)
    return `Task ${id} was approved at its current commit.`
  })
  .build()

export const updateRepositoryTool = tool('update_repository')
  .describe(
    'Change the settings of a repository, or enable it. Send only what changes. null clears a setting back to its default.',
  )
  .input(repositoryPatchSchema.extend({ repository: z.string().max(200).describe('owner/name') }))
  .execute(async ({ repository, ...patch }) => {
    const { doctor } = await saveRepository(workDeps(), repository, patch)
    const found = (doctor?.items ?? []).filter((item) => item.status !== 'ok')
    if (found.length === 0) return `Saved the settings of ${repository}.`
    return `Saved the settings of ${repository}. The doctor found: ${found
      .map((item) => `${item.id} (${item.status}): ${item.cause} ${item.repair}`)
      .join(' | ')}`
  })
  .build()

export const createPlanTool = tool('create_plan')
  .describe(
    'Start a plan: an agent reads the repository and splits the goal into issues for the owner to review. It creates no issue yet.',
  )
  .input(
    z.object({
      repository: z.string().max(200).describe('owner/name of an enabled repository'),
      goal: z.string().min(10).max(4000),
    }),
  )
  .execute(async (input) => {
    const { planId } = await createPlan(workDeps(), input)
    return `Plan ${planId} was started. It is ready to review in a minute or two.`
  })
  .build()

export const createPlanIssuesTool = tool('create_plan_issues')
  .describe(
    'Turn the selected items of a ready plan into issues on GitHub, and start them at once or leave them waiting.',
  )
  .input(z.object({ planId: z.number().int().positive(), start: z.boolean() }))
  .execute(async ({ planId, start }) => {
    await createPlanIssues(workDeps(), planId, { start })
    return start
      ? `The issues of plan ${planId} were created and started.`
      : `The issues of plan ${planId} were created and are waiting.`
  })
  .build()

export const resolveFindingTool = tool('resolve_finding')
  .describe(
    'Act on an open finding. retry: start the stuck task again. resume: carry on an answered question. delete_snapshot: remove an unused snapshot. mark_revert_unknown: show a stuck revert as red.',
  )
  .input(
    z.object({
      id: z.number().int().positive(),
      action: z.enum(['retry', 'resume', 'delete_snapshot', 'mark_revert_unknown']),
    }),
  )
  .execute(async ({ id, action }) => {
    await resolveFinding(actionDeps(), id, action)
    return `Finding ${id} was handled (${action}).`
  })
  .build()

export const acknowledgeWatchTool = tool('acknowledge_watch')
  .describe('Mark a red main branch as seen by a person, once someone looked at it.')
  .input(z.object({ id: z.number().int().positive() }))
  .execute(async ({ id }) => {
    await acknowledgeWatch(actionDeps(), id)
    return `The red main branch ${id} was marked as seen.`
  })
  .build()

/** Not imported at the top: the catalog reads the guides, and the guides read these tools. */
const catalog = async () => (await import('../../factory/agent-view')).agentsView(getDb())

export const agentsTool = tool('list_agents')
  .describe(
    'Every agent of the factory: what it does, when it runs, the model or coding agent behind it and how that is changed, what it may call, and the titles of its prompts.',
  )
  .input(z.object({}))
  .execute(async () => {
    const view = await catalog()
    return { agents: agentsForGuide(view), codingAgents: enginesForGuide(view.settings) }
  })
  .build()

export const agentPromptTool = tool('agent_prompt')
  .describe(
    'One prompt of one agent, whole, as written in the code. Give the agent id from list_agents, and the prompt id when it has more than one.',
  )
  .input(z.object({ id: z.string().max(60), prompt: z.string().max(60).optional() }))
  .execute(async ({ id, prompt }) => promptForGuide(await catalog(), id, prompt))
  .build()

const engine = z.string().max(40).nullable().optional()
const perRole = z.object({ builder: engine, planner: engine, reviewer: engine }).optional()

export const updateAgentSettingsTool = tool('update_agent_settings')
  .describe(
    'Choose which coding agent builds, which plans and which reviews, and which model and effort level each uses. Send only what changes. For a model or an effort give an id from the engines list of list_agents for the agent that role will use. null goes back to the default: the planner and the reviewer then use the same agent as the builder, and an agent without a chosen model uses its own default. It applies to the next runs, not the ones in progress.',
  )
  .input(
    z.object({
      builder: engine,
      planner: engine,
      reviewer: engine,
      models: perRole,
      efforts: perRole,
    }),
  )
  .execute(async (input) => {
    await changeAgentSettings(getDb(), input)
    return 'Saved. It applies to the next runs; the ones in progress finish with the agent they started with.'
  })
  .build()
