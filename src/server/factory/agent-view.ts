import type { AgentsView } from '../../shared/panel'
import type { Database } from '../db'

import { agentCatalog } from './agent-catalog'
import { agentSettings, effectiveEnv } from './settings'

/** The agents as they work now, and what can be changed about them: the catalog read with the owner's choices laid over. */
export async function agentsView(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  read?: (path: string) => string,
): Promise<AgentsView> {
  return {
    ...agentCatalog(await effectiveEnv(db, env), read),
    settings: await agentSettings(db, env),
  }
}
