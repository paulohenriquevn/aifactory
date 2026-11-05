import { AgentBuilder, Provider } from '@theokit/agents'
import { z } from 'zod'

import { onlyTools } from '../agents/hooks/only-tools'
import { CHAT_INSTRUCTIONS } from '../agents/prompts/chat'
import {
  backlogProgressTool,
  factoryStatusTool,
  listTasksTool,
  requestChangesTool,
  retryTaskTool,
  startJobTool,
  taskDetailTool,
} from '../agents/tools/chat'

/** The tools the assistant may call: the ones it declares, and no built-in the SDK gives every agent. */
export const CHAT_TOOLS = [
  'factory_status',
  'list_tasks',
  'task_detail',
  'backlog_progress',
  'retry_task',
  'request_changes',
  'start_job',
] as const

/** The changes it may make, each behind the owner's approval. */
export const ACTING_TOOLS = ['retry_task', 'request_changes', 'start_job'] as const

/**
 * The assistant on a model. Two agents are made from it: one on OpenRouter, one on the owner's ChatGPT
 * subscription (the Codex login), and the page picks between them. The `ChatGPT` provider is not part of
 * the framework's own model resolution, so its plugin is handed over explicitly.
 */
export function chatAgent(model: string) {
  return AgentBuilder.create()
    .input(z.object({ message: z.string().max(40_000) }))
    .model(model)
    .plugins(Provider.builtins())
    .system(CHAT_INSTRUCTIONS)
    .tool(factoryStatusTool)
    .tool(listTasksTool)
    .tool(taskDetailTool)
    .tool(backlogProgressTool)
    .tool(retryTaskTool)
    .tool(requestChangesTool)
    .tool(startJobTool)
    .approval('retry_task', { question: 'Start this task again from the beginning?' })
    .approval('request_changes', { question: 'Send this work back to the agent with this note?' })
    .approval('start_job', { question: 'Open this issue and start the factory on it?' })
    .hooks(onlyTools([...CHAT_TOOLS]))
    .build()
}
