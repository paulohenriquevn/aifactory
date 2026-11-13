import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, repository, stageEvent, task } from '../db/schema'

import { catchUpResolved, resolvedCatchUp } from './resolved-release'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table repository, finding, agent_run, watch, delivery, decision, question, review, evidence, stage_event, task, ingress restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

/** GitHub as the catch-up sees it: which commits each release branch holds. */
function fakeGithub(onBranch: Record<string, string[]>) {
  const compared: string[] = []
  return {
    compared,
    app: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
    api: {
      defaultBranch: async () => 'main',
      async contains(repo: string, _token: string, descendant: string, ancestor: string) {
        compared.push(`${repo}:${ancestor}...${descendant}`)
        return (onBranch[`${repo}:${descendant}`] ?? []).includes(ancestor)
      },
    },
  }
}

let delivery = 0
async function seed(
  repo: string,
  issueNumber: number,
  set: Partial<typeof task.$inferInsert>,
): Promise<number> {
  const [i] = await getDb()
    .insert(ingress)
    .values({
      deliveryId: `d-${++delivery}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await getDb()
    .insert(task)
    .values({ ingressId: i.id, repository: repo, issueNumber, issueTitle: 't', ...set })
    .returning({ id: task.id })
  return t.id
}
const resolved = (repo: string, issueNumber: number, sha: string) =>
  seed(repo, issueNumber, { stage: 'done', resolvedSha: sha })

const stageOf = async (id: number) =>
  (await getDb().select().from(task).where(eq(task.id, id)))[0].stage
const releasedDetail = async (id: number) =>
  (await getDb().select().from(stageEvent).where(eq(stageEvent.taskId, id))).find(
    (e) => e.stage === 'released',
  )?.detail

describe('catchUpResolved', () => {
  it('moves a resolved task whose commit the release branch contains to released, naming the branch and the commit', async () => {
    const id = await resolved('paulo/app', 1, 'aaa111')
    const gh = fakeGithub({ 'paulo/app:main': ['aaa111'] })

    const result = await catchUpResolved({ db: getDb(), ...gh }, { after: 0, limit: 10 })

    expect(result).toEqual({ released: [id], errors: [], next: 0 })
    expect(await stageOf(id)).toBe('released')
    expect(await releasedDetail(id)).toEqual({
      actor: 'factory',
      releaseBranch: 'main',
      resolvedSha: 'aaa111',
    })
  })

  it('leaves a resolved task alone while its commit is not on the release branch', async () => {
    const id = await resolved('paulo/app', 1, 'bbb222')
    const gh = fakeGithub({ 'paulo/app:main': [] })

    const result = await catchUpResolved({ db: getDb(), ...gh }, { after: 0, limit: 10 })

    expect(result.released).toEqual([])
    expect(await stageOf(id)).toBe('done')
  })

  it('compares against the release branch the owner set for the repository', async () => {
    await getDb()
      .insert(repository)
      .values({ fullName: 'paulo/app', enabled: true, releaseBranch: 'stable' })
    const id = await resolved('paulo/app', 1, 'aaa111')
    const gh = fakeGithub({ 'paulo/app:stable': ['aaa111'] })

    await catchUpResolved({ db: getDb(), ...gh }, { after: 0, limit: 10 })

    expect(gh.compared).toEqual(['paulo/app:aaa111...stable'])
    expect(await releasedDetail(id)).toMatchObject({ releaseBranch: 'stable' })
  })

  it('touches only tasks that finished with no change', async () => {
    const merged = await seed('paulo/app', 1, { stage: 'done', mergedSha: 'aaa111' })
    const failed = await seed('paulo/app', 2, { stage: 'failed', resolvedSha: 'aaa111' })
    const both = await seed('paulo/app', 3, {
      stage: 'done',
      resolvedSha: 'aaa111',
      mergedSha: 'ccc333',
    })
    const gh = fakeGithub({ 'paulo/app:main': ['aaa111', 'ccc333'] })

    const result = await catchUpResolved({ db: getDb(), ...gh }, { after: 0, limit: 10 })

    expect(result.released).toEqual([])
    expect(gh.compared).toEqual([])
    expect([await stageOf(merged), await stageOf(failed), await stageOf(both)]).toEqual([
      'done',
      'failed',
      'done',
    ])
  })

  it('is idempotent: a second pass releases nothing again and records no second stage', async () => {
    const id = await resolved('paulo/app', 1, 'aaa111')
    const gh = fakeGithub({ 'paulo/app:main': ['aaa111'] })
    await catchUpResolved({ db: getDb(), ...gh }, { after: 0, limit: 10 })

    const again = await catchUpResolved({ db: getDb(), ...gh }, { after: 0, limit: 10 })

    expect(again.released).toEqual([])
    const events = await getDb().select().from(stageEvent).where(eq(stageEvent.taskId, id))
    expect(events.filter((e) => e.stage === 'released')).toHaveLength(1)
  })

  it('looks at no more tasks than its limit per pass, and the next pass starts after the last one', async () => {
    const first = await resolved('paulo/app', 1, 'aaa111')
    const second = await resolved('paulo/app', 2, 'aaa111')
    const third = await resolved('paulo/app', 3, 'bbb222')
    const gh = fakeGithub({ 'paulo/app:main': ['aaa111', 'bbb222'] })

    const one = await catchUpResolved({ db: getDb(), ...gh }, { after: 0, limit: 2 })
    const two = await catchUpResolved({ db: getDb(), ...gh }, { after: one.next, limit: 2 })

    expect(one).toEqual({ released: [first, second], errors: [], next: second })
    // The same commit is compared once in a pass, however many tasks it resolved.
    expect(gh.compared.slice(0, 1)).toEqual(['paulo/app:aaa111...main'])
    expect(two).toEqual({ released: [third], errors: [], next: 0 })
    expect(gh.compared).toHaveLength(2)
  })

  it('starts over from the first task when a pass reaches the end, so a task left behind is looked at again', async () => {
    const waiting = await resolved('paulo/app', 1, 'bbb222')
    const gh = fakeGithub({ 'paulo/app:main': [] })
    const pass = await catchUpResolved({ db: getDb(), ...gh }, { after: 0, limit: 1 })
    expect(pass).toEqual({ released: [], errors: [], next: waiting })

    const end = await catchUpResolved({ db: getDb(), ...gh }, { after: pass.next, limit: 1 })

    expect(end).toEqual({ released: [], errors: [], next: 0 })
  })

  it("keeps the cron's place between passes, and logs only a pass that released something", async () => {
    const first = await resolved('paulo/app', 1, 'aaa111')
    const second = await resolved('paulo/app', 2, 'bbb222')
    const gh = fakeGithub({ 'paulo/app:main': ['bbb222'] })
    const logged: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(line)
    })
    const pass = resolvedCatchUp(1)

    try {
      const one = await pass({ db: getDb(), ...gh })
      const two = await pass({ db: getDb(), ...gh })

      expect(one).toEqual({ released: [], errors: [], next: first })
      expect(two).toEqual({ released: [second], errors: [], next: second })
      expect(logged.map((l) => JSON.parse(l))).toEqual([
        { event: 'catch_up_resolved', released: [second], errors: [], next: second },
      ])
    } finally {
      log.mockRestore()
    }
  })

  it('records a repository GitHub will not compare and goes on with the others', async () => {
    const broken = await resolved('paulo/gone', 1, 'aaa111')
    const fine = await resolved('paulo/app', 2, 'aaa111')
    const gh = fakeGithub({ 'paulo/app:main': ['aaa111'] })
    const api = {
      ...gh.api,
      async contains(repo: string, token: string, descendant: string, ancestor: string) {
        if (repo === 'paulo/gone') throw new Error('404 comparing aaa111 with main on paulo/gone')
        return gh.api.contains(repo, token, descendant, ancestor)
      },
    }

    const result = await catchUpResolved({ db: getDb(), app: gh.app, api }, { after: 0, limit: 10 })

    expect(result.released).toEqual([fine])
    expect(result.errors).toEqual([
      `task ${broken} (paulo/gone#1): 404 comparing aaa111 with main on paulo/gone`,
    ])
    expect(await stageOf(broken)).toBe('done')
  })
})
