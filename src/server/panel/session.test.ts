import { describe, expect, it } from 'vitest'

import { login, logoutHeaders, ownerFromNodeRequest, tokenMatches } from './session'

const TOKEN = 't'.repeat(40)
const SECRET = 's'.repeat(40)
const env = { FACTORY_PANEL_TOKEN: TOKEN, FACTORY_PANEL_SECRET: SECRET }

const cookieOf = (headers: Headers) => (headers.get('set-cookie') ?? '').split(';')[0]
const nodeRequest = (cookie: string) => ({ headers: { cookie } }) as never

describe('tokenMatches', () => {
  it('accepts the token and nothing else', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true)
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false)
    expect(tokenMatches('', TOKEN)).toBe(false)
  })

  it('accepts nothing when the expected token is missing or too short to be one', () => {
    expect(tokenMatches('', undefined)).toBe(false)
    expect(tokenMatches('short', 'short')).toBe(false)
  })
})

describe('login', () => {
  it('issues a session cookie for the right token, and that cookie signs the owner in', async () => {
    const outcome = await login(TOKEN, 'client-ok', env)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const cookie = cookieOf(outcome.headers)
    expect(cookie).toMatch(/^aifactory_panel=/)
    expect(outcome.headers.get('set-cookie')).toMatch(/HttpOnly/i)
    expect(await ownerFromNodeRequest(nodeRequest(cookie), env)).toBe(true)
  })

  it('refuses a wrong token, and locks a client out after five wrong ones', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) {
      const outcome = await login('wrong', 'client-bad', env)
      statuses.push(outcome.ok ? 200 : outcome.status)
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429])
    // The right token does not get through a lockout either.
    const locked = await login(TOKEN, 'client-bad', env)
    expect(locked.ok).toBe(false)
    // Another client is not affected.
    expect((await login(TOKEN, 'client-other', env)).ok).toBe(true)
  })

  it('says it is not configured instead of letting anyone in', async () => {
    expect(await login(TOKEN, 'c', {})).toMatchObject({ ok: false, status: 503 })
    expect(await login(TOKEN, 'c', { FACTORY_PANEL_TOKEN: TOKEN })).toMatchObject({ status: 503 })
    expect(await login(TOKEN, 'c', { ...env, FACTORY_PANEL_SECRET: 'short' })).toMatchObject({
      status: 503,
    })
  })
})

describe('the owner session', () => {
  it('is not valid without a cookie, with a forged one, or with another secret', async () => {
    expect(await ownerFromNodeRequest(nodeRequest(''), env)).toBe(false)
    expect(await ownerFromNodeRequest(nodeRequest('aifactory_panel=forged'), env)).toBe(false)

    const outcome = await login(TOKEN, 'client-secret', env)
    if (!outcome.ok) throw new Error('login failed')
    const cookie = cookieOf(outcome.headers)
    expect(
      await ownerFromNodeRequest(nodeRequest(cookie), {
        ...env,
        FACTORY_PANEL_SECRET: 'x'.repeat(40),
      }),
    ).toBe(false)
    expect(await ownerFromNodeRequest(nodeRequest(cookie), {})).toBe(false)
  })

  it('is cleared by logging out', () => {
    expect(logoutHeaders(env).get('set-cookie')).toMatch(/aifactory_panel=;|Max-Age=0|Expires=/i)
  })
})
