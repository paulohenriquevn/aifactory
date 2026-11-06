import { defineCron } from 'theokit/server/cron'

import { mainProcessOnly } from '../factory/worker-only'
import { knowledgeDeps } from '../knowledge/deps'
import { knowledgePass } from '../knowledge/pass'

/**
 * Keeps the knowledge base current for every agent: once a minute it fetches the owner's knowledge
 * repository into the mirror on this host and writes the notes the runs kept to the factory's memory branch.
 * The sandboxes copy from the mirror (see knowledge/feed.ts) and the assistants read it, so this is the only
 * place anything is fetched or pushed.
 */
export default defineCron('knowledge-sync', {
  schedule: '* * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(() => knowledgePass(() => knowledgeDeps())),
})
