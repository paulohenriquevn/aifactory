import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { createGithubApp, type FetchLike } from './app'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown }

/** A fake GitHub: records every call and answers the two endpoints the app auth uses. */
function fakeGithub(options: { expiresInMs?: number; installationStatus?: number } = {}) {
  const calls: Call[] = []
  let minted = 0
  const fetch: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: init?.method ?? 'GET', headers, body })
    if (url.endsWith('/installation')) {
      return Response.json(
        options.installationStatus === 404 ? { message: 'Not Found' } : { id: 4242 },
        { status: options.installationStatus ?? 200 },
      )
    }
    if (url.endsWith('/access_tokens')) {
      minted += 1
      return Response.json(
        {
          token: `ghs_token_${minted}`,
          expires_at: new Date(Date.now() + (options.expiresInMs ?? 3_600_000)).toISOString(),
        },
        { status: 201 },
      )
    }
    return Response.json({ message: 'unexpected' }, { status: 500 })
  }
  return { fetch, calls, minted: () => minted }
}

const app = (fetch: FetchLike, extra = {}) =>
  createGithubApp({ appId: '123', privateKey, fetch, ...extra })

describe('GitHub App installation tokens', () => {
  it('always limits the token to the one repository it was asked for', async () => {
    const github = fakeGithub()
    await app(github.fetch).installationToken('paulohenriquevn/aifactory-playground')

    const mint = github.calls.find((c) => c.url.endsWith('/access_tokens'))
    expect(mint?.method).toBe('POST')
    expect(mint?.url).toContain('/app/installations/4242/')
    expect(mint?.body).toEqual({
      repositories: ['aifactory-playground'],
      permissions: {
        contents: 'write',
        pull_requests: 'write',
        issues: 'write',
        checks: 'write',
      },
    })
  })

  it('never sends an access_tokens request without a repository filter', async () => {
    const github = fakeGithub()
    const auth = app(github.fetch)
    await auth.installationToken('o/a')
    await auth.installationToken('o/b')

    const mints = github.calls.filter((c) => c.url.endsWith('/access_tokens'))
    expect(mints).toHaveLength(2)
    for (const mint of mints) {
      expect((mint.body as { repositories?: string[] }).repositories).toHaveLength(1)
    }
  })

  it.each(['', 'justaname', 'a/b/c', '/b', 'a/', 'a b/c', 'o/*'])(
    'refuses the repository %j before calling GitHub',
    async (repo) => {
      const github = fakeGithub()
      await expect(app(github.fetch).installationToken(repo)).rejects.toThrow(/owner\/name/)
      expect(github.calls).toHaveLength(0)
    },
  )

  it('signs the app JWT with RS256 for the configured app id', async () => {
    const github = fakeGithub()
    await app(github.fetch).installationToken('o/r')

    const bearer = github.calls[0].headers.authorization.replace('Bearer ', '')
    const [header, payload, signature] = bearer.split('.')
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    })
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    expect(claims.iss).toBe('123')
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)
    const valid = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(createPublicKey(publicKey), signature, 'base64url')
    expect(valid).toBe(true)
  })

  it('reuses a token that is still valid, per repository', async () => {
    const github = fakeGithub()
    const auth = app(github.fetch)
    const first = await auth.installationToken('o/r')
    const second = await auth.installationToken('o/r')
    const other = await auth.installationToken('o/other')

    expect(second.token).toBe(first.token)
    expect(other.token).not.toBe(first.token)
    expect(github.minted()).toBe(2)
  })

  it('mints a new token when the cached one is about to expire', async () => {
    const github = fakeGithub({ expiresInMs: 30_000 })
    const auth = app(github.fetch)
    const first = await auth.installationToken('o/r')
    const second = await auth.installationToken('o/r')

    expect(second.token).not.toBe(first.token)
    expect(github.minted()).toBe(2)
  })

  it('says so when the app is not installed on the repository', async () => {
    const github = fakeGithub({ installationStatus: 404 })
    await expect(app(github.fetch).installationToken('o/r')).rejects.toThrow(
      /not installed on o\/r/,
    )
  })

  it('does not put the token or the key in an error message', async () => {
    const github = fakeGithub({ installationStatus: 404 })
    const error = await app(github.fetch)
      .installationToken('o/r')
      .catch((e: Error) => e)
    expect(String((error as Error).message)).not.toContain('PRIVATE KEY')
  })
})
