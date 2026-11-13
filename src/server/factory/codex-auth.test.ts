import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  codexAccount,
  codexAuthFile,
  CodexLoginError,
  freshCodexLogin,
  fromCliAuth,
  hasCodexLogin,
  legacyAuthFile,
  markCodexRefused,
  renewCodexLogin,
  REFRESH_MARGIN_MS,
  saveCodexLogin,
} from './codex-auth'

const NOW = 1_800_000_000_000
const jwt = (claims: object) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
const ID_TOKEN = jwt({
  email: 'owner@example.com',
  'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' },
})
const accessExpiring = (msLeft: number) => jwt({ exp: Math.floor((NOW + msLeft) / 1000) })

const homes: string[] = []
function newHome() {
  const home = mkdtempSync(join(tmpdir(), 'codex-auth-test-'))
  chmodSync(home, 0o700)
  homes.push(home)
  return { FACTORY_CODEX_HOME: home }
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** What `codex login --device-auth` writes. */
function cliAuth(access: string) {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: ID_TOKEN,
      access_token: access,
      refresh_token: 'cli-refresh',
      account_id: 'acc-1',
    },
    last_refresh: '2026-11-04T14:05:00Z',
  })
}
function writeCliLogin(env: { FACTORY_CODEX_HOME: string }, access: string) {
  writeFileSync(legacyAuthFile(env), cliAuth(access), { mode: 0o600 })
}
const stored = (env: { FACTORY_CODEX_HOME: string }) =>
  JSON.parse(readFileSync(codexAuthFile(env), 'utf8')) as Record<string, unknown>

const refusing = (async () => {
  throw new Error('no network in this test')
}) as unknown as typeof fetch
const answering = (body: object, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('fromCliAuth', () => {
  it('turns the Codex CLI login into a TheoKit credential, ID token included', () => {
    const access = accessExpiring(5 * 86_400_000)
    expect(fromCliAuth(cliAuth(access))).toEqual({
      type: 'oauth',
      provider: 'openai',
      access,
      refresh: 'cli-refresh',
      expires: Math.floor((NOW + 5 * 86_400_000) / 1000) * 1000,
      account_id: 'acc-1',
      id_token: ID_TOKEN,
    })
  })

  it('refuses a file with no ChatGPT login in it', () => {
    expect(() => fromCliAuth('{"OPENAI_API_KEY":"sk-x"}')).toThrow(CodexLoginError)
  })
})

describe('freshCodexLogin', () => {
  it('moves the old CLI login over on the first read, privately, and leaves the old file alone', async () => {
    const env = newHome()
    const access = accessExpiring(5 * 86_400_000)
    writeCliLogin(env, access)

    const login = await freshCodexLogin({ env, fetch: refusing, now: () => NOW })

    expect(login).toEqual({ accessToken: access, idToken: ID_TOKEN, accountId: 'acc-1' })
    expect(stored(env)).toMatchObject({ refresh: 'cli-refresh', id_token: ID_TOKEN })
    expect(statSync(codexAuthFile(env)).mode & 0o777).toBe(0o600)
    expect(readFileSync(legacyAuthFile(env), 'utf8')).toBe(cliAuth(access))
  })

  it('uses the stored token while it has more than the margin left, without calling out', async () => {
    const env = newHome()
    // TheoKit renews within the margin plus the SDK's one-minute skew, so two minutes is clear of both.
    writeCliLogin(env, accessExpiring(REFRESH_MARGIN_MS + 120_000))
    await expect(freshCodexLogin({ env, fetch: refusing, now: () => NOW })).resolves.toMatchObject({
      idToken: ID_TOKEN,
    })
  })

  it('renews a token inside the margin, keeps the rotated refresh token and the ID token', async () => {
    const env = newHome()
    writeCliLogin(env, accessExpiring(REFRESH_MARGIN_MS - 60_000))
    const renewed = accessExpiring(10 * 86_400_000)
    const fetch = answering({
      access_token: renewed,
      refresh_token: 'rotated',
      expires_in: 864_000,
    })

    const login = await freshCodexLogin({ env, fetch, now: () => NOW })

    expect(login).toEqual({ accessToken: renewed, idToken: ID_TOKEN, accountId: 'acc-1' })
    expect(stored(env)).toMatchObject({ access: renewed, refresh: 'rotated', id_token: ID_TOKEN })
  })

  it('says to connect again when the renewal is refused', async () => {
    const env = newHome()
    writeCliLogin(env, accessExpiring(60_000))
    const fetch = answering({ error: 'invalid_grant' }, 400)
    await expect(freshCodexLogin({ env, fetch, now: () => NOW })).rejects.toThrow(
      /could not be renewed.*connect Codex again from the Setup page/,
    )
  })

  it('says where to connect when there is no login at all', async () => {
    const env = newHome()
    await expect(freshCodexLogin({ env, fetch: refusing, now: () => NOW })).rejects.toThrow(
      /no Codex login in .*connect Codex from the Setup page/,
    )
  })

  it('never writes the old account over a login saved while it was renewing', async () => {
    const env = newHome()
    writeCliLogin(env, accessExpiring(60_000))
    let answer: () => void = () => {}
    // Resolved once the renewal is inside the lock and asking: a fixed wait raced it on a loaded machine.
    let asked: () => void = () => {}
    const renewalAsked = new Promise<void>((done) => (asked = done))
    const slow = (() =>
      new Promise<Response>((done) => {
        asked()
        answer = () =>
          done(
            new Response(
              JSON.stringify({
                access_token: accessExpiring(864_000_000),
                refresh_token: 'old-account',
              }),
            ),
          )
      })) as unknown as typeof fetch

    const renewing = freshCodexLogin({ env, fetch: slow, now: () => NOW })
    await renewalAsked
    const saving = saveCodexLogin(
      {
        access: 'new-account-access',
        refresh: 'new-account',
        expires: NOW + 864_000_000,
        idToken: ID_TOKEN,
      },
      env,
    )
    answer()
    await renewing
    await saving

    expect(stored(env)).toMatchObject({ access: 'new-account-access', refresh: 'new-account' })
  })
})

describe('saveCodexLogin', () => {
  it('keeps a login with its ID token where the factory reads it', async () => {
    const env = newHome()
    await saveCodexLogin({ access: 'a', refresh: 'r', expires: NOW, idToken: ID_TOKEN }, env)
    expect(stored(env)).toMatchObject({ type: 'oauth', access: 'a', id_token: ID_TOKEN })
    expect(hasCodexLogin(env)).toBe(true)
  })

  it('refuses a login without the ID token Codex needs, and keeps nothing', async () => {
    const env = newHome()
    await expect(saveCodexLogin({ access: 'a', refresh: 'r', expires: NOW }, env)).rejects.toThrow(
      /no ID token/,
    )
    expect(hasCodexLogin(env)).toBe(false)
  })
})

describe('codexAccount', () => {
  it('names the account and its plan from the ID token, and never carries a token', async () => {
    const env = newHome()
    await saveCodexLogin({ access: 'a', refresh: 'r', expires: NOW, idToken: ID_TOKEN }, env)
    const account = codexAccount(env)
    expect(account).toEqual({ connected: true, email: 'owner@example.com', plan: 'pro' })
    expect(JSON.stringify(account)).not.toContain(ID_TOKEN)
  })

  it('reads an old CLI login that has not been moved over yet', () => {
    const env = newHome()
    writeCliLogin(env, accessExpiring(86_400_000))
    expect(codexAccount(env)).toMatchObject({ connected: true, email: 'owner@example.com' })
  })

  it('is not connected when there is no login', () => {
    expect(codexAccount(newHome())).toEqual({ connected: false })
  })

  it('says why a login on disk cannot be used', async () => {
    const env = newHome()
    await saveCodexLogin({ access: 'a', refresh: 'r', expires: NOW, idToken: ID_TOKEN }, env)
    chmodSync(codexAuthFile(env), 0o644)
    const account = codexAccount(env)
    expect(account.connected).toBe(false)
    expect(account).toHaveProperty('problem')
  })
})

describe('a login the provider refused', () => {
  it('is renewed on demand even when its exp is far away', async () => {
    const env = newHome()
    writeCliLogin(env, accessExpiring(REFRESH_MARGIN_MS + 66 * 3_600_000))
    const renewed = accessExpiring(10 * 86_400_000)
    const fetch = answering({
      access_token: renewed,
      refresh_token: 'rotated',
      expires_in: 864_000,
    })

    const login = await renewCodexLogin({ env, fetch, now: () => NOW })

    expect(login.accessToken).toBe(renewed)
    expect(stored(env)).toMatchObject({ access: renewed, refresh: 'rotated' })
  })

  it('fails with an error that names the Codex login when the renewal fails', async () => {
    const env = newHome()
    writeCliLogin(env, accessExpiring(REFRESH_MARGIN_MS + 66 * 3_600_000))
    await expect(renewCodexLogin({ env, fetch: refusing, now: () => NOW })).rejects.toThrow(
      /Codex login .* could not be renewed/,
    )
  })

  it('is not shown as connected until it is renewed or signed in again', async () => {
    const env = newHome()
    writeCliLogin(env, accessExpiring(REFRESH_MARGIN_MS + 66 * 3_600_000))
    expect(codexAccount(env)).toMatchObject({ connected: true })

    markCodexRefused('HTTP 401 token_expired', env)
    const refused = codexAccount(env)
    expect(refused).toMatchObject({ connected: false })
    expect((refused as { problem?: string }).problem).toMatch(/refused.*token_expired/)

    const fetch = answering({
      access_token: accessExpiring(10 * 86_400_000),
      refresh_token: 'rotated',
      expires_in: 864_000,
    })
    await renewCodexLogin({ env, fetch, now: () => NOW })
    expect(codexAccount(env)).toMatchObject({ connected: true })
  })
})
