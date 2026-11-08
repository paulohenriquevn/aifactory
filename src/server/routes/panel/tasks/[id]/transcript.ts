import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../../../db'
import { eventsOf } from '../../../../factory/transcript-store'
import { ownerOnly } from '../../../../panel/policy'
import type { TranscriptPage } from '../../../../../shared/panel'

const PAGE = 500

/** The steps of a task's agents after `after`, oldest first, a page at a time. */
export const GET = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.coerce.number().int().positive() }))
  .query(z.object({ after: z.coerce.number().int().min(0).default(0) }))
  .handler(async ({ params, query }): Promise<TranscriptPage> => {
    const rows = await eventsOf(getDb(), params.id, { afterSeq: query.after, limit: PAGE + 1 })
    return { events: rows.slice(0, PAGE), more: rows.length > PAGE }
  })
  .build()
