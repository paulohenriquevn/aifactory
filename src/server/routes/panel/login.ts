import { route } from 'theokit/server/define'
import { z } from 'zod'

import { login } from '../../panel/session'

export const POST = route()
  // Nobody is signed in yet; the token in the body is what proves the owner.
  .policy('public')
  .body(z.object({ token: z.string().min(1).max(500) }))
  .handler(async ({ request, body }) => {
    const client = request.headers.get('x-forwarded-for') ?? 'local'
    const outcome = await login(body.token, client)
    if (!outcome.ok) {
      return Response.json(
        { error: 'login_refused', message: outcome.reason },
        { status: outcome.status },
      )
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: new Headers([...outcome.headers.entries(), ['content-type', 'application/json']]),
    })
  })
  .build()
