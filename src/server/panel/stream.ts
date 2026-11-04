import { desc, gt } from 'drizzle-orm'

import type { Database } from '../db'
import { stageEvent } from '../db/schema'
import type { Stage, StreamEvent } from '../../shared/panel'

const encoder = new TextEncoder()
const frame = (event: StreamEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)

/**
 * A server-sent event stream of stage changes. It starts at the newest event, so a client that
 * connects sees what happens from then on and asks the API for the rest, and it ends when the client
 * goes away. A comment line goes out every `pingMs` to keep proxies from closing an idle stream.
 */
export function stageStream(
  db: Database,
  signal: AbortSignal,
  { intervalMs = 1_500, pingMs = 15_000 } = {},
): Response {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const [newest] = await db
        .select({ id: stageEvent.id })
        .from(stageEvent)
        .orderBy(desc(stageEvent.id))
        .limit(1)
      let last = newest?.id ?? 0
      let quiet = 0
      controller.enqueue(encoder.encode(': connected\n\n'))

      const tick = async () => {
        if (signal.aborted) return
        try {
          const rows = await db
            .select({
              id: stageEvent.id,
              taskId: stageEvent.taskId,
              stage: stageEvent.stage,
              at: stageEvent.at,
            })
            .from(stageEvent)
            .where(gt(stageEvent.id, last))
            .orderBy(stageEvent.id)
          for (const row of rows) {
            last = row.id
            controller.enqueue(
              frame({
                type: 'stage',
                taskId: row.taskId,
                stage: row.stage as Stage,
                at: row.at.toISOString(),
              }),
            )
          }
          quiet = rows.length > 0 ? 0 : quiet + intervalMs
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
