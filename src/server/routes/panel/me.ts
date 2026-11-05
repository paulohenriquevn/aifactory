import { route } from 'theokit/server/define'

import { githubAppFromEnv } from '../../factory/deps'

let cached: { name: string | undefined; at: number } | undefined

/** The GitHub account that owns the App, which is the owner of the factory. Looked up rarely, never fatal. */
async function ownerName(): Promise<string | undefined> {
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.name
  let name: string | undefined
  try {
    name = await githubAppFromEnv().owner()
  } catch {
    name = undefined
  }
  cached = { name, at: Date.now() }
  return name
}

/** Whether this browser is signed in, so the interface knows whether to show the login, and who the owner is. */
export const GET = route()
  .policy('public')
  .handler(async ({ ctx }) => {
    const owner = (ctx as { subject?: { id?: string } }).subject?.id === 'owner'
    return owner ? { owner, name: await ownerName() } : { owner }
  })
  .build()
