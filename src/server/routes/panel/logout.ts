import { route } from 'theokit/server/define'

import { logoutHeaders } from '../../panel/session'

export const POST = route()
  .policy('public')
  .handler(
    () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: new Headers([...logoutHeaders().entries(), ['content-type', 'application/json']]),
      }),
  )
  .build()
