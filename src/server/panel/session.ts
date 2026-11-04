import { createHash, timingSafeEqual } from 'node:crypto'

import {
  checkThrottle,
  createSessionManager,
  createSessionManagerWeb,
  recordAttempt,
} from 'theokit/server/auth'
import { InMemoryStore } from 'theokit/server/rate-limit'

/** Who the panel lets in: its one owner, who proves it with the token in `FACTORY_PANEL_TOKEN`. */
export type PanelSession = { owner: true }

export const COOKIE = 'aifactory_panel'
const WEEK_MS = 7 * 24 * 3_600_000
export const MIN_SECRET = 32

function config(env: NodeJS.ProcessEnv) {
  const secret = env.FACTORY_PANEL_SECRET
  if (!secret || secret.length < MIN_SECRET) return undefined
  return { secret, cookieName: COOKIE, maxAge: WEEK_MS }
}

/** Reads the session cookie of a Node request. Without a secret nobody is signed in. */
export async function ownerFromNodeRequest(
  request: Parameters<ReturnType<typeof createSessionManager<PanelSession>>['getSession']>[0],
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const c = config(env)
  if (!c) return false
  return (await createSessionManager<PanelSession>(c).getSession(request))?.owner === true
}

/** Compares in constant time, over hashes, so neither the length nor the content leaks. */
export function tokenMatches(given: string, expected: string | undefined): boolean {
  if (!expected || expected.length < MIN_SECRET) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

const attempts = new InMemoryStore()

export type LoginOutcome =
  { ok: true; headers: Headers } | { ok: false; status: 401 | 429 | 503; reason: string }

/**
 * Checks the token and, when it is right, issues the session cookie. Wrong guesses are counted
 * per client, and after five the client is locked out for an hour.
 */
export async function login(
  token: string,
  client: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoginOutcome> {
  const c = config(env)
  if (!c || !env.FACTORY_PANEL_TOKEN) {
    return { ok: false, status: 503, reason: 'the panel has no token or secret configured' }
  }
  const identifier = createHash('sha256').update(client).digest('hex')
  const options = { store: attempts, identifier, maxAttempts: 5 }
  const state = await checkThrottle(options)
  if (!state.allowed) return { ok: false, status: 429, reason: 'too many attempts, try later' }
  const valid = tokenMatches(token, env.FACTORY_PANEL_TOKEN)
  await recordAttempt(options, valid)
  if (!valid) return { ok: false, status: 401, reason: 'wrong token' }
  const headers = new Headers()
  await createSessionManagerWeb<PanelSession>(c).createSession(headers, { owner: true })
  return { ok: true, headers }
}

export function logoutHeaders(env: NodeJS.ProcessEnv = process.env): Headers {
  const headers = new Headers()
  const c = config(env)
  if (c) createSessionManagerWeb<PanelSession>(c).destroySession(headers)
  return headers
}
