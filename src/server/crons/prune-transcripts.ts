import { defineCron } from 'theokit/server/cron'

import { getDb } from '../db'
import { pruneTranscripts, TRANSCRIPT_RETENTION_DAYS } from '../factory/transcript-store'
import { mainProcessOnly } from '../factory/worker-only'

/** Deletes the agents' steps older than the retention, once a day. */
export default defineCron('prune-transcripts', {
  schedule: '17 3 * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(async () => {
    const deleted = await pruneTranscripts(getDb())
    if (deleted > 0) {
      console.log(
        JSON.stringify({
          event: 'prune_transcripts',
          deleted,
          retentionDays: TRANSCRIPT_RETENTION_DAYS,
        }),
      )
    }
  }),
})
