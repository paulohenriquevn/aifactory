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
