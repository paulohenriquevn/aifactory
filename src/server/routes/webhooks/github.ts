import { route } from 'theokit/server/define'

import { getDb } from '../../db'
import { handleGithubDelivery } from '../../ingest/webhook'

export const POST = route()
  // Authenticated by the HMAC signature on the raw body, not by a session.
  .policy('public')
  // A third-party POST carries no CSRF token; without this it is refused before the signature check.
  .csrf(false)
  .handler(({ request }) =>
    handleGithubDelivery(request, { secret: process.env.GITHUB_WEBHOOK_SECRET, db: getDb }),
  )
  .build()
