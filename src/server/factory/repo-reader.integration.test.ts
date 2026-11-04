import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import type { FetchLike } from '../github/app'

import { repoFile, repoTree, type ReaderDeps } from './repo-reader'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query('truncate table repository restart identity cascade')
  await getPool().query("insert into repository (full_name, enabled) values ('Acme/App', true)")
  await getPool().query("insert into repository (full_name, enabled) values ('acme/off', false)")
})
afterAll(() => getStorageManager().dispose())

const asked: string[] = []
const github = {
  async installationToken(repo: string) {
    asked.push(repo)
    return { token: 'ghs_x', expiresAt: new Date(Date.now() + 3_600_000) }
  },
}

function serve(answer: (url: string) => Response) {
  const calls: { url: string; auth: string; accept: string }[] = []
  const fetch: FetchLike = async (url, init) => {
    const h = init?.headers as Record<string, string>
    calls.push({ url, auth: h.authorization, accept: h.accept })
    return answer(url)
  }
  const deps: ReaderDeps = { db: getDb(), github, fetch }
  return { deps, calls }
}

describe('reading a repository for the assistant', () => {
  it('lists file names only, without what a build leaves behind, under the name GitHub uses', async () => {
    const { deps, calls } = serve(() =>
      Response.json({
        tree: [
          { path: 'package.json', type: 'blob' },
          { path: 'src', type: 'tree' },
          { path: 'src/index.ts', type: 'blob' },
          { path: 'node_modules/x/index.js', type: 'blob' },
          { path: 'dist/app.js', type: 'blob' },
          { path: 'packages/a/.venv/lib/x.py', type: 'blob' },
        ],
      }),
    )

    expect(await repoTree(deps, 'acme/app')).toEqual(['package.json', 'src/index.ts'])
    expect(calls[0].url).toBe('https://api.github.com/repos/Acme/App/git/trees/HEAD?recursive=1')
    expect(calls[0].auth).toBe('Bearer ghs_x')
    expect(asked).toContain('Acme/App')
  })

  it('keeps at most three hundred names', async () => {
    const tree = Array.from({ length: 450 }, (_, i) => ({ path: `f${i}.txt`, type: 'blob' }))
    const { deps } = serve(() => Response.json({ tree }))
    expect(await repoTree(deps, 'Acme/App')).toHaveLength(300)
  })

  it('reads a build file as plain text, cut to twenty thousand characters', async () => {
    const { deps, calls } = serve(() => new Response('x'.repeat(30_000)))
    const text = await repoFile(deps, 'Acme/App', 'apps/web/package.json')
    expect(text).toHaveLength(20_000)
    expect(calls[0].url).toBe(
      'https://api.github.com/repos/Acme/App/contents/apps/web/package.json',
    )
    expect(calls[0].accept).toBe('application/vnd.github.raw+json')
  })

  it('refuses a file that is not a build or test file before it asks GitHub for anything', async () => {
    const { deps, calls } = serve(() => new Response('secret'))
    await expect(repoFile(deps, 'Acme/App', 'src/secret.ts')).rejects.toThrow(
      /not a file the assistant may read/,
    )
    await expect(repoFile(deps, 'Acme/App', '.env')).rejects.toThrow(
      /not a file the assistant may read/,
    )
    expect(calls).toEqual([])
  })

  it('refuses a repository that is not enabled, or that the factory does not know, without asking GitHub', async () => {
    const { deps, calls } = serve(() => Response.json({ tree: [] }))
    await expect(repoTree(deps, 'acme/off')).rejects.toThrow(
      'not a repository the factory works in',
    )
    await expect(repoFile(deps, 'acme/other', 'package.json')).rejects.toThrow(
      'not a repository the factory works in',
    )
    expect(calls).toEqual([])
  })

  it('says what GitHub answered when a file is missing or the call fails', async () => {
    const missing = serve(() => new Response('', { status: 404 }))
    await expect(repoFile(missing.deps, 'Acme/App', 'package.json')).rejects.toThrow(
      'package.json does not exist in Acme/App',
    )
    const broken = serve(() => new Response('', { status: 502 }))
    await expect(repoFile(broken.deps, 'Acme/App', 'package.json')).rejects.toThrow(
      'GitHub answered 502 reading Acme/App/package.json',
    )
    await expect(repoTree(broken.deps, 'Acme/App')).rejects.toThrow(
      'GitHub answered 502 listing Acme/App',
    )
  })
})
