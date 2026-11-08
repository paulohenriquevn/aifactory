import { inArray, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { ingress, webhookRedelivery } from '../db/schema'
import type { AppHooks } from '../github/app'

/** GitHub keeps a delivery log for three days, so there is nothing to ask for further back. */
export const CATCH_UP_WINDOW_MS = 72 * 3_600_000
const MAX_ATTEMPTS = 3
/** A failure younger than this may still be one the sender is retrying or the server is restarting for. */
const GRACE_MS = 60_000

export type CatchUpResult = { redelivered: string[]; gaveUp: string[]; errors: string[] }

/**
 * Finds the webhooks GitHub could not deliver (the server was down, the tunnel was, a deploy was in
 * the middle) and asks for them again. A delivery is left alone when any try of it was accepted, when
 * the factory already recorded it, or when it was asked for three times already. Recording is by the
 * delivery's GUID, which does not change across redeliveries, so a delivery that arrives twice still
 * makes one task.
 */
export async function catchUp(deps: {
  db: Database
  app: AppHooks
  now?: () => Date
}): Promise<CatchUpResult> {
  const { db, app } = deps
  const now = (deps.now ?? (() => new Date()))().getTime()
  const result: CatchUpResult = { redelivered: [], gaveUp: [], errors: [] }

  const recent = (await app.hookDeliveries()).filter(
    (d) => now - d.deliveredAt.getTime() <= CATCH_UP_WINDOW_MS,
  )
  const accepted = new Set(
    recent.filter((d) => d.statusCode >= 200 && d.statusCode < 300).map((d) => d.guid),
  )
  // Newest failure of each delivery: that is the one worth asking for again.
  const failed = new Map<string, (typeof recent)[number]>()
  for (const d of recent) {
    if (accepted.has(d.guid) || now - d.deliveredAt.getTime() < GRACE_MS) continue
    if (!failed.has(d.guid)) failed.set(d.guid, d)
  }
  if (failed.size === 0) return result

  const guids = [...failed.keys()]
  const known = new Set(
    (
      await db
        .select({ id: ingress.deliveryId })
        .from(ingress)
        .where(inArray(ingress.deliveryId, guids))
    ).map((r) => r.id),
  )
  const tried = new Map(
    (await db.select().from(webhookRedelivery).where(inArray(webhookRedelivery.guid, guids))).map(
      (r) => [r.guid, r.attempts],
    ),
  )

  for (const [guid, delivery] of failed) {
    if (known.has(guid)) continue
    if ((tried.get(guid) ?? 0) >= MAX_ATTEMPTS) {
      result.gaveUp.push(guid)
      continue
    }
    await db
      .insert(webhookRedelivery)
      .values({ guid, attempts: 1, lastAt: new Date(now) })
      .onConflictDoUpdate({
        target: webhookRedelivery.guid,
        set: { attempts: sql`${webhookRedelivery.attempts} + 1`, lastAt: new Date(now) },
      })
    try {
      await app.redeliver(delivery.id)
      result.redelivered.push(guid)
    } catch (error) {
      // One delivery GitHub refuses must not hold back the ones after it.
      result.errors.push(`${guid}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}
