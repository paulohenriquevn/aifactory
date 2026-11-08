import { GUIDE_IDS, type GuideId } from '../../shared/guides'
import { GUIDE_INSTRUCTIONS } from '../agents/prompts/guides'
import {
  requestChangesTool,
  retryTaskTool,
  startJobTool,
  taskDetailTool,
  listTasksTool,
  factoryStatusTool,
} from '../agents/tools/chat'
import {
  acknowledgeWatchTool,
  agentPromptTool,
  agentsTool,
  updateAgentSettingsTool,
  approveTool,
  createPlanIssuesTool,
  createPlanTool,
  healthTool,
  inboxTool,
  planTool,
  plansTool,
  repositoriesTool,
  resolveFindingTool,
  setupTool,
  updateRepositoryTool,
} from '../agents/tools/guide'
import { repoFileTool, repoTreeTool } from '../agents/tools/repo'

import { buildAssistant, type AssistantSpec } from './assistant'

type Tools = AssistantSpec['tools']

const ASKS = {
  retry_task: 'Start this task again from the beginning?',
  request_changes: 'Send this work back to the agent with this note?',
  start_job: 'Open this issue and start the factory on it?',
  approve_task: 'Approve the pull request at this commit?',
  update_repository: 'Save these settings?',
  create_plan: 'Start this plan?',
  create_plan_issues: 'Create these issues on GitHub?',
  resolve_finding: 'Do this about the finding?',
  acknowledge_watch: 'Mark the red main branch as seen?',
  update_agent_settings: 'Change which coding agent builds, plans and reviews?',
}

const ALL: Tools = {
  factory_status: factoryStatusTool,
  list_tasks: listTasksTool,
  task_detail: taskDetailTool,
  retry_task: retryTaskTool,
  request_changes: requestChangesTool,
  start_job: startJobTool,
  approve_task: approveTool,
  inbox_items: inboxTool,
  health_report: healthTool,
  setup_report: setupTool,
  list_plans: plansTool,
  plan_detail: planTool,
  list_repositories: repositoriesTool,
  list_agents: agentsTool,
  agent_prompt: agentPromptTool,
  update_agent_settings: updateAgentSettingsTool,
  repo_files: repoTreeTool,
  repo_file: repoFileTool,
  update_repository: updateRepositoryTool,
  create_plan: createPlanTool,
  create_plan_issues: createPlanIssuesTool,
  resolve_finding: resolveFindingTool,
  acknowledge_watch: acknowledgeWatchTool,
}

/** What each guide may use. A guide has the tools of its own page and no others. */
const TOOLS: Record<GuideId, string[]> = {
  board: [
    'factory_status',
    'list_tasks',
    'inbox_items',
    'task_detail',
    'retry_task',
    'request_changes',
    'approve_task',
    'start_job',
  ],
  plans: ['list_plans', 'plan_detail', 'list_repositories', 'create_plan', 'create_plan_issues'],
  repositories: ['list_repositories', 'repo_files', 'repo_file', 'update_repository'],
  inbox: ['inbox_items', 'task_detail', 'approve_task', 'request_changes', 'retry_task'],
  health: ['health_report', 'task_detail', 'resolve_finding', 'acknowledge_watch'],
  agents: ['list_agents', 'agent_prompt', 'update_agent_settings'],
  setup: ['setup_report'],
}

const pick = <T>(from: Record<string, T>, names: string[]) =>
  Object.fromEntries(names.map((name) => [name, from[name]]))

export function guideSpec(id: GuideId): AssistantSpec {
  const names = TOOLS[id]
  return {
    system: GUIDE_INSTRUCTIONS(id),
    tools: pick(ALL, names),
    asks: pick(
      ASKS,
      names.filter((n) => n in ASKS),
    ) as Record<string, string>,
  }
}

export const GUIDE_SPECS = Object.fromEntries(GUIDE_IDS.map((id) => [id, guideSpec(id)])) as Record<
  GuideId,
  AssistantSpec
>

/**
 * The model the guides answer with. They must look at the live data before they answer, and a cheaper
 * model (gemini-2.5-flash) answered from the page description instead. gpt-4.1-mini looks, and answers in
 * a few seconds; the reasoning models took twenty and more.
 */
export const guideModel = (env: NodeJS.ProcessEnv = process.env) =>
  env.FACTORY_GUIDE_MODEL ?? env.FACTORY_CHAT_MODEL ?? 'openrouter/openai/gpt-4.1-mini'

/** The same guides on the owner's ChatGPT subscription. */
export const guideCodexModel = (env: NodeJS.ProcessEnv = process.env) =>
  env.FACTORY_CHAT_CODEX_MODEL ?? 'openai-chatgpt/gpt-5.4'

/** The guide of one page, as an agent. */
export const guideAgent = (id: GuideId, model: 'openrouter' | 'codex' = 'openrouter') =>
  buildAssistant(model === 'codex' ? guideCodexModel() : guideModel(), GUIDE_SPECS[id])
