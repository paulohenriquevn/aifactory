import { chatAgent } from '../factory/chat-agent'
import { chatModel } from '../factory/models'
import { ownerOnly } from '../panel/policy'

/** Only the signed-in owner talks to the assistant: it can act on the factory and spends model credit. */
export const policy = ownerOnly

/**
 * The assistant on OpenRouter, served at `POST /api/agents/chat`. `FACTORY_CHAT_MODEL` changes the model;
 * it needs `OPENROUTER_API_KEY` on the server.
 */
export default chatAgent(chatModel())
