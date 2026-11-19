/**
 * The model behind each assistant of the panel, with the default written once. The agents, the setup page
 * and the catalog of agents all ask here, so what the page says is what the agent uses.
 */
export const chatModel = (env: NodeJS.ProcessEnv = process.env) =>
  env.FACTORY_CHAT_MODEL ?? 'openrouter/google/gemini-2.5-flash'

export const chatCodexModel = (env: NodeJS.ProcessEnv = process.env) =>
  env.FACTORY_CHAT_CODEX_MODEL ?? 'openai-chatgpt/gpt-5.4'

export const assistModel = (env: NodeJS.ProcessEnv = process.env) =>
  env.FACTORY_ASSIST_MODEL || 'anthropic/claude-sonnet-4-6'

/**
 * The model the coordinator drafts a scope decision with (`coordinator/draft.ts`). It is its own setting, not
 * the panel assistants': the drafter runs with nobody watching, so it must not change when a page's model
 * does. gpt-4.1-mini answered the scope of a real handoff in about four seconds with a draft that parsed.
 */
export const coordinatorModel = (env: NodeJS.ProcessEnv = process.env) =>
  env.FACTORY_COORDINATOR_MODEL || 'openrouter/openai/gpt-4.1-mini'

/**
 * The model the coordinator's unblocker investigates an escalation with (`coordinator/unblock.ts`). It is its own
 * setting so it can be given a stronger model than the drafter; unset, it is the coordinator's model.
 */
export const unblockerModel = (env: NodeJS.ProcessEnv = process.env) =>
  env.FACTORY_UNBLOCKER_MODEL || coordinatorModel(env)
