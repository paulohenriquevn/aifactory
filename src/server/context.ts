import { ownerFromNodeRequest } from './panel/session'

/**
 * Who is asking, for every route. The panel has one owner, signed in by a cookie; everyone else is
 * anonymous, and the routes that matter refuse an anonymous caller (`panel/policy.ts`).
 */
export async function createContext({ request }: { request: never }) {
  return (await ownerFromNodeRequest(request)) ? { subject: { id: 'owner' } } : {}
}
