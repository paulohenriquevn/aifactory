import { defineWebhook, dispatchWebhook, github } from 'theokit/server/webhook'

import type { Delivery, RecordResult } from './record'

export type GithubWebhookDeps = {
  /** `GITHUB_WEBHOOK_SECRET`. Without it the endpoint refuses everything. */
  secret: string | undefined
  /** Stores a verified delivery. The route decides what else commits with it. */
  record: (delivery: Delivery) => Promise<RecordResult>
}

/**
 * Handles a GitHub delivery: verifies the HMAC signature over the raw body first, and only a
 * verified delivery reaches the database. An endpoint without a secret answers 503 rather than
 * accepting unsigned input.
 */
export async function handleGithubDelivery(
  request: Request,
  { secret, record }: GithubWebhookDeps,
): Promise<Response> {
  if (!secret) {
    console.error(JSON.stringify({ event: 'github_webhook_not_configured' }))
    return Response.json(
      { error: 'webhook_not_configured', message: 'GITHUB_WEBHOOK_SECRET is not set' },
      { status: 503 },
    )
  }

  const webhook = defineWebhook({
    verify: github({ secret }),
    // GitHub deliveries carry up to 25 MB; an issues event is far smaller, so the default cap
    // (1 MB) is kept and a larger body is refused with 413.
    handler: async ({ rawBody, request: verified }) => {
      const deliveryId = verified.headers.get('x-github-delivery')
      const event = verified.headers.get('x-github-event')
      if (!deliveryId || !event) {
        return Response.json(
          {
            error: 'missing_headers',
            message: 'X-GitHub-Delivery and X-GitHub-Event are required',
          },
          { status: 400 },
        )
      }

      let payload: unknown
      try {
        payload = JSON.parse(rawBody)
      } catch {
        return Response.json({ error: 'invalid_json' }, { status: 400 })
      }

      const result = await record({ deliveryId, event, payload })
      return Response.json(result)
    },
  })

  return dispatchWebhook(webhook, request)
}
