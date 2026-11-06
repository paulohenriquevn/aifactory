import { AgentBuilder } from '@theokit/agents'
import { z } from 'zod'

import { assistModel } from '../factory/models'
import { ownerOnly } from '../panel/policy'

import { onlyTools } from './hooks/only-tools'
import { ASSIST_INSTRUCTIONS } from './prompts/assist'
import { proposeTool } from './tools/propose'

/**
 * Only the signed-in owner talks to the assistant: it spends the factory's own model credit, so it is
 * never open the way a chat on a public page would be.
 */
export const policy = ownerOnly

/**
 * The assistant of the panel, served at `POST /api/agents/assist` and used by `useAgent`. It turns what a
 * person says in plain words into what the factory needs (a goal, an issue, a request for changes) and
 * offers it through `propose`. What the factory is lives in `.theokit/THEO.md`, which the framework
 * prepends to every turn. It reads nothing: the one that reads a repository is `assist-setup`.
 *
 * It calls the model provider directly with the factory's own key (`ANTHROPIC_API_KEY`), because a
 * subscription token is for a coding agent in a sandbox and not for this. `FACTORY_ASSIST_MODEL` changes
 * the model.
 */
export default AgentBuilder.create()
  .input(z.object({ message: z.string().max(12_000) }))
  .model(assistModel())
  .system(ASSIST_INSTRUCTIONS)
  .tool(proposeTool)
  .hooks(onlyTools(['propose']))
  .build()
