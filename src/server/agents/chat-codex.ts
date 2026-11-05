import { chatAgent } from '../factory/chat-agent'
import { ownerOnly } from '../panel/policy'

/** Only the signed-in owner talks to the assistant: it can act on the factory and spends model credit. */
export const policy = ownerOnly

/**
 * The assistant on the owner's ChatGPT subscription, served at `POST /api/agents/chat-codex`. The login is
 * the OpenAI device login the framework offers, made from the panel (Setup); `FACTORY_CHAT_CODEX_MODEL`
 * changes the model.
 */
export default chatAgent(process.env.FACTORY_CHAT_CODEX_MODEL ?? 'openai-chatgpt/gpt-5.4')
