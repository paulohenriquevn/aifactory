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

describe('the delivery log', () => {
  const row = (id: number | string, guid: string, status: number) => ({
    id,
    guid,
    delivered_at: '2026-11-04T12:00:00Z',
    status_code: status,
    event: 'issues',
  })

  it('reads deliveries with the App key, and follows the next page up to the limit', async () => {
    const calls: { url: string; auth: string }[] = []
    const fetch: FetchLike = async (url, init) => {
      calls.push({
        url,
        auth: String(Object.entries(init?.headers ?? {}).find(([k]) => k === 'authorization')?.[1]),
      })
      const second = url.includes('cursor=2')
      return Response.json([second ? row(3, 'c', 200) : row(1, 'a', 502)], {
        headers: second
          ? {}
          : {
              link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=2>; rel="next"',
            },
      })
    }

    const found = await app(fetch).hookDeliveries()

    expect(found.map((d) => [d.id, d.guid, d.statusCode])).toEqual([
      ['1', 'a', 502],
      ['3', 'c', 200],
    ])
    expect(found[0].deliveredAt).toEqual(new Date('2026-11-04T12:00:00Z'))
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/app/hook/deliveries?per_page=100',
      'https://api.github.com/app/hook/deliveries?per_page=100&cursor=2',
    ])
    expect(calls.every((c) => c.auth.startsWith('Bearer '))).toBe(true)
  })

  it('keeps a delivery id that is too big for a number exactly as GitHub wrote it', async () => {
    const fetch: FetchLike = async () =>
      new Response(
        '[{"id":3852181270593298432,"guid":"g","delivered_at":"2026-11-04T12:00:00Z","status_code":502,"event":"issues"}]',
      )
    const [found] = await app(fetch).hookDeliveries()
    expect(found.id).toBe('3852181270593298432')
    expect(String(Number('3852181270593298432'))).not.toBe('3852181270593298432')
  })

  it('stops at the page limit even when GitHub offers more', async () => {
    let served = 0
    const fetch: FetchLike = async () => {
      served += 1
      return Response.json([row(served, `g${served}`, 200)], {
        headers: { link: '<https://api.github.com/app/hook/deliveries?cursor=x>; rel="next"' },
      })
    }
    expect(await app(fetch).hookDeliveries({ pages: 2 })).toHaveLength(2)
    expect(served).toBe(2)
  })

  it('says what GitHub answered when it cannot list', async () => {
    const fetch: FetchLike = async () => Response.json({}, { status: 401 })
    await expect(app(fetch).hookDeliveries()).rejects.toThrow(
      'GitHub answered 401 listing deliveries',
    )
  })

  it('asks GitHub to send a delivery again, and checks it was accepted', async () => {
    const seen: { url: string; method: string }[] = []
    const ok: FetchLike = async (url, init) => {
      seen.push({ url, method: init?.method ?? 'GET' })
      return new Response('{}', { status: 202 })
    }
    await app(ok).redeliver('77')
    expect(seen).toEqual([
      { url: 'https://api.github.com/app/hook/deliveries/77/attempts', method: 'POST' },
    ])
    await expect(app(ok).redeliver('7/../x')).rejects.toThrow('not a delivery id')
    const refused: FetchLike = async () => new Response('{}', { status: 422 })
    await expect(app(refused).redeliver('77')).rejects.toThrow(
      'GitHub answered 422 redelivering 77',
    )
  })
})

describe('the repositories the App reaches', () => {
  const repo = (name: string, priv = false) => ({
    full_name: name,
    private: priv,
    default_branch: 'main',
  })

  function fakeInstall(pages: { repositories: ReturnType<typeof repo>[] }[]) {
    const calls: { url: string; auth: string; body: unknown }[] = []
    const fetch: FetchLike = async (url, init) => {
      const headers = Object.fromEntries(Object.entries(init?.headers ?? {}))
      calls.push({
        url,
        auth: headers.authorization,
        body: init?.body && JSON.parse(String(init.body)),
      })
      if (url.endsWith('/app/installations')) return Response.json([{ id: 77 }])
      if (url.endsWith('/access_tokens'))
        return Response.json({ token: 'ghs_list' }, { status: 201 })
      const page = Number(new URL(url).searchParams.get('page'))
      return Response.json(pages[page - 1] ?? { repositories: [] })
    }
    return { fetch, calls }
  }

  it('lists them sorted, asks for a token that can only read metadata, and never names a repository', async () => {
    const { fetch, calls } = fakeInstall([
      { repositories: [repo('o/zeta', true), repo('o/alpha')] },
    ])

    const found = await app(fetch).installationRepositories()

    expect(found).toEqual([
      { fullName: 'o/alpha', private: false, defaultBranch: 'main' },
      { fullName: 'o/zeta', private: true, defaultBranch: 'main' },
    ])
    const mint = calls.find((c) => c.url.endsWith('/access_tokens'))
    expect(mint?.body).toEqual({ permissions: { metadata: 'read' } })
    expect(calls.find((c) => c.url.includes('/installation/repositories'))?.auth).toBe(
      'Bearer ghs_list',
    )
  })

  it('follows the pages while they are full, and stops at the first that is not', async () => {
    const full = Array.from({ length: 100 }, (_, i) => repo(`o/r${String(i).padStart(3, '0')}`))
    const { fetch, calls } = fakeInstall([
      { repositories: full },
      { repositories: [repo('o/last')] },
    ])

    const found = await app(fetch).installationRepositories()

    expect(found).toHaveLength(101)
    expect(calls.filter((c) => c.url.includes('/installation/repositories'))).toHaveLength(2)
  })

  it('says what GitHub answered when listing, minting or reading fails', async () => {
    const failing = (bad: string, status: number): FetchLike => {
      const ok = fakeInstall([{ repositories: [] }]).fetch
      return async (url, init) =>
        url.includes(bad) ? Response.json({}, { status }) : ok(url, init)
    }
    await expect(
      app(failing('/app/installations', 401)).installationRepositories(),
    ).rejects.toThrow('GitHub answered 401 listing installations')
    await expect(app(failing('/access_tokens', 403)).installationRepositories()).rejects.toThrow(
      'GitHub answered 403 minting a listing token',
    )
    await expect(
      app(failing('/installation/repositories', 500)).installationRepositories(),
    ).rejects.toThrow('GitHub answered 500 listing repositories')
  })
})

describe('how long the repository list is kept', () => {
  it('answers a second ask from memory, and asks GitHub again after fifteen seconds', async () => {
    let clock = 1_000_000
    let installationCalls = 0
    const fetch: FetchLike = async (url) => {
      if (url.endsWith('/app/installations')) {
        installationCalls += 1
        return Response.json([{ id: 5 }])
      }
      if (url.endsWith('/access_tokens')) return Response.json({ token: 't' }, { status: 201 })
      return Response.json({
        repositories: [{ full_name: 'o/a', private: false, default_branch: 'main' }],
      })
    }
    const github = app(fetch, { now: () => clock })

    await github.installationRepositories()
    await github.installationRepositories()
    expect(installationCalls).toBe(1)

    clock += 14_999
    await github.installationRepositories()
    expect(installationCalls).toBe(1)

    clock += 2
    await github.installationRepositories()
    expect(installationCalls).toBe(2)
  })

  it('does not keep a failure', async () => {
    let fail = true
    const fetch: FetchLike = async (url) => {
      if (url.endsWith('/app/installations')) {
        return fail ? Response.json({}, { status: 502 }) : Response.json([])
      }
      return Response.json({})
    }
    const github = app(fetch)
    await expect(github.installationRepositories()).rejects.toThrow('502')
    fail = false
    expect(await github.installationRepositories()).toEqual([])
  })
})
