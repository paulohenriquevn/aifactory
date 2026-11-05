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

import { buildAssistant, type AssistantSpec } from './assistant'

export const CHAT_SPEC: AssistantSpec = {
  system: CHAT_INSTRUCTIONS,
  tools: {
    factory_status: factoryStatusTool,
    list_tasks: listTasksTool,
    task_detail: taskDetailTool,
    backlog_progress: backlogProgressTool,
    retry_task: retryTaskTool,
    request_changes: requestChangesTool,
    start_job: startJobTool,
  },
  asks: {
    retry_task: 'Start this task again from the beginning?',
    request_changes: 'Send this work back to the agent with this note?',
    start_job: 'Open this issue and start the factory on it?',
  },
}

/** The tools the assistant may call: the ones it declares, and no built-in the SDK gives every agent. */
export const CHAT_TOOLS = Object.keys(CHAT_SPEC.tools)

/** The changes it may make, each behind the owner's approval. */
export const ACTING_TOOLS = Object.keys(CHAT_SPEC.asks)

/** The chat assistant on a model: OpenRouter, or the owner's ChatGPT subscription. */
export const chatAgent = (model: string) => buildAssistant(model, CHAT_SPEC)
