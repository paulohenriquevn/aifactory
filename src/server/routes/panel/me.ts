import { route } from 'theokit/server/define'

/** Whether this browser is signed in, so the interface knows whether to show the login. */
export const GET = route()
  .policy('public')
  .handler(({ ctx }) => ({ owner: (ctx as { subject?: { id?: string } }).subject?.id === 'owner' }))
  .build()
