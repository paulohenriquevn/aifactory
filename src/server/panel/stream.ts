import { desc, gt } from 'drizzle-orm'

import type { Database } from '../db'
import { agentEvent, stageEvent } from '../db/schema'
import { toTranscriptEvent } from '../factory/transcript-store'
import type { Stage, StreamEvent } from '../../shared/panel'

const encoder = new TextEncoder()
const frame = (event: StreamEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)

/** Where the stream is in each table it follows: the id of the last row it sent. */
type Cursor = { stage: number; agent: number }

async function newest(db: Database): Promise<Cursor> {
  const [stage] = await db
    .select({ id: stageEvent.id })
    .from(stageEvent)
    .orderBy(desc(stageEvent.id))
    .limit(1)
  const [agent] = await db
    .select({ id: agentEvent.id })
    .from(agentEvent)
    .orderBy(desc(agentEvent.id))
    .limit(1)
  return { stage: stage?.id ?? 0, agent: agent?.id ?? 0 }
}

/** What happened after the cursor, stages first, and the cursor moved past it. */
async function since(db: Database, cursor: Cursor): Promise<StreamEvent[]> {
  const stages = await db
    .select({
      id: stageEvent.id,
      taskId: stageEvent.taskId,
      stage: stageEvent.stage,
      at: stageEvent.at,
    })
    .from(stageEvent)
    .where(gt(stageEvent.id, cursor.stage))
    .orderBy(stageEvent.id)
  // A run writes many steps a second at most; a page keeps one slow client from holding a huge result.
  const steps = await db
    .select()
    .from(agentEvent)
    .where(gt(agentEvent.id, cursor.agent))
    .orderBy(agentEvent.id)
    .limit(500)
  cursor.stage = stages.at(-1)?.id ?? cursor.stage
  cursor.agent = steps.at(-1)?.id ?? cursor.agent
  return [
    ...stages.map((r): StreamEvent => ({
      type: 'stage',
      taskId: r.taskId,
      stage: r.stage as Stage,
      at: r.at.toISOString(),
    })),
    ...steps.map((r): StreamEvent => ({
      type: 'agent',
      taskId: r.taskId,
      event: toTranscriptEvent(r),
    })),
  ]
}

/**
 * A server-sent event stream of stage changes and of the agents' steps. It starts at the newest of each,
 * so a client that connects sees what happens from then on and asks the API for the rest, and it ends
 * when the client goes away. A comment line goes out every `pingMs` to keep proxies from closing an idle
 * stream.
 */
export function stageStream(
  db: Database,
  signal: AbortSignal,
  { intervalMs = 1_500, pingMs = 15_000 } = {},
): Response {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const cursor = await newest(db)
      let quiet = 0
      controller.enqueue(encoder.encode(': connected\n\n'))

      const tick = async () => {
        if (signal.aborted) return
        try {
          const events = await since(db, cursor)
          for (const event of events) controller.enqueue(frame(event))
          quiet = events.length > 0 ? 0 : quiet + intervalMs
          if (quiet >= pingMs) {
            controller.enqueue(encoder.encode(': ping\n\n'))
            quiet = 0
          }
        } catch (error) {
          controller.error(error)
          return
        }
        timer = setTimeout(tick, intervalMs)
      }
      timer = setTimeout(tick, intervalMs)
      signal.addEventListener('abort', () => {
        if (timer) clearTimeout(timer)
        try {
          controller.close()
        } catch {
          // Already closed by the client.
        }
      })
    },
    cancel() {
      if (timer) clearTimeout(timer)
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  })
}
