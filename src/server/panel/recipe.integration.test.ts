import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { repository } from '../db/schema'
import { parseRecipe, type Recipe } from '../factory/recipe'

import { ActionRefused } from './actions'
import { approveRecipeEgress, repositoryRecipe, type RecipeDeps } from './recipe'

let onBranch: () => Recipe | undefined
const read: string[] = []
const deps: RecipeDeps = {
  // Read when a test runs, after the storage is configured.
  get db() {
    return getDb()
  },
  github: {
    installationToken: async (repo: string) => ({ token: `tok-${repo}`, expiresAt: new Date() }),
  },
  readRecipe: async (repo, token) => {
    read.push(`${repo} ${token}`)
    return onBranch()
  },
}

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query('truncate table repository restart identity cascade')
  await getDb()
    .insert(repository)
    .values({ fullName: 'Paulo/App', enabled: true, egress: ['a.example.org'] })
  onBranch = () => ({ egress: ['a.example.org', 'b.example.org', 'c.example.org'] })
  read.length = 0
})
afterAll(() => getStorageManager().dispose())

const approvedOf = async () =>
  (await getDb().select().from(repository).where(eq(repository.fullName, 'Paulo/App')))[0]
    .approvedRecipeEgress

describe('the recipe on the panel', () => {
  it('shows what the recipe asks for that the sandbox does not reach yet, read with the repository token', async () => {
    const view = await repositoryRecipe(deps, 'paulo/app')
    expect(view).toEqual({
      fullName: 'Paulo/App',
      recipe: { egress: ['a.example.org', 'b.example.org', 'c.example.org'] },
      pending: ['b.example.org', 'c.example.org'],
      approved: [],
      problem: null,
    })
    expect(read).toEqual(['Paulo/App tok-Paulo/App'])
  })

  it('approves domains the recipe asks for, once each, and they stop being pending', async () => {
    await approveRecipeEgress(deps, 'paulo/app', ['B.example.org '])
    const view = await approveRecipeEgress(deps, 'Paulo/App', ['b.example.org', 'c.example.org'])
    expect(view.pending).toEqual([])
    expect(await approvedOf()).toEqual(['b.example.org', 'c.example.org'])
  })

  it('refuses a domain the recipe on the branch does not ask for, and saves nothing', async () => {
    await expect(
      approveRecipeEgress(deps, 'paulo/app', ['b.example.org', 'evil.example']),
    ).rejects.toThrow('does not ask for evil.example')
    expect(await approvedOf()).toEqual([])
  })

  it('says why a recipe cannot be used, and approves nothing from it', async () => {
    onBranch = () => parseRecipe('Paulo/App', '{"egress":["*"]}')
    const view = await repositoryRecipe(deps, 'paulo/app')
    expect(view.problem).toMatch(/cannot be used: egress.0 is not a hostname/)
    await expect(approveRecipeEgress(deps, 'paulo/app', ['b.example.org'])).rejects.toThrow(
      ActionRefused,
    )
  })

  it('shows a project with no recipe as having nothing to approve', async () => {
    onBranch = () => undefined
    expect(await repositoryRecipe(deps, 'paulo/app')).toMatchObject({ recipe: null, pending: [] })
  })

  it('refuses a repository the factory does not know', async () => {
    await expect(repositoryRecipe(deps, 'paulo/nope')).rejects.toThrow('enable it first')
  })
})
