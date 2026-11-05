import { guideAgent } from '../factory/guides'
import { ownerOnly } from '../panel/policy'

/** Only the signed-in owner talks to a guide: it can act on the factory and spends model credit. */
export const policy = ownerOnly

/** The guide of the "health" page on the owner's ChatGPT subscription, at `POST /api/agents/guide-health-codex`. */
export default guideAgent('health', 'codex')
