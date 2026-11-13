import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, task, watch } from '../db/schema'
import type { GithubApp } from '../github/app'
import { FakeGithub, type FakeCheckRun } from '../../test/fake-github'

import { pollWatches } from './watch'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table watch, delivery, decision, question, review, evidence, stage_event, task, ingress restart identity cascade',
  )
  api = new FakeGithub()
  // The release each watch is on: pull request 12, merged. The next one GitHub opens is 41.
  api.repo('paulo/app').pullRequest({
    number: 12,
    headRef: 'develop',
    state: 'closed',
    merged: true,
    mergeCommitSha: MERGE,
  })
  api.repo('paulo/app').nextNumber = 41
})
afterAll(() => getStorageManager().dispose())

const MERGE = 'merge0001abcdef'
let api = new FakeGithub()

const run = (name: string, status: string, conclusion: string | null) => ({
  name,
  status,
  conclusion,
})
/** What the checks on the merge commit say now: these runs and nothing else. */
const checked = (...runs: (Partial<FakeCheckRun> & { name: string })[]) => {
  const repo = api.repo('paulo/app').clearChecks(MERGE)
  for (const each of runs) repo.checkRun(MERGE, each)
}
/** The reverts GitHub opened, each with the pull request it reverts. */
const reverts = () =>
  api.answered('revertPullRequest').map(([number, revert]) => ({ number, ...revert }))
// The watcher must never merge anything.
const merges = () => api.callsTo('mergePullRequest')
const github: GithubApp = { installationToken: async () => ({ token: 't', expiresAt: new Date() }) }

let seeded = 0
async function watching(startedAt = new Date()): Promise<number> {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `w-${++seeded}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'c',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await db
    .insert(task)
    .values({
      ingressId: i.id,
      repository: 'paulo/app',
      issueNumber: seeded,
      issueTitle: 'Add truncate',
      stage: 'released',
    })
    .returning({ id: task.id })
  const [w] = await db
    .insert(watch)
    .values({
      taskId: t.id,
      repository: 'paulo/app',
      sha: MERGE,
      pullRequestNumber: 12,
      tag: 'v0.1.0',
      startedAt,
    })
    .returning({ id: watch.id })
  return w.id
}
const poll = (over: { now?: () => Date; windowMs?: number } = {}) =>
  pollWatches({ db: getDb(), github, api, ...over })
const row = async (id: number) => (await getDb().select().from(watch).where(eq(watch.id, id)))[0]

describe('pollWatches while a revert is being opened', () => {
  it('is not red until the attempt is over, so nobody is told there is no revert too soon', async () => {
    const id = await watching()
    checked(run('ci', 'completed', 'failure'))
    let during: string | undefined
    api.repo('paulo/app').nextNumber = 50
    api.before('revertPullRequest', async () => {
      during = (await row(id)).status
    })

    await pollWatches({ db: getDb(), github, api })

    expect(during).toBe('reverting')
    expect(await row(id)).toMatchObject({
      status: 'red',
      revertUrl: 'https://github.com/paulo/app/pull/50',
    })
  })

  it('leaves a watch that is already reverting alone, so a crash cannot open a second revert', async () => {
    const id = await watching()
    await getDb().update(watch).set({ status: 'reverting' }).where(eq(watch.id, id))
    checked(run('ci', 'completed', 'failure'))

    expect(await poll()).toEqual({ green: [], red: [], silent: [], waiting: 0 })
    expect(reverts()).toEqual([])
  })
})

describe('pollWatches', () => {
  it('ends a watch green when the checks on the merge commit pass, and opens nothing', async () => {
    const id = await watching()
    checked(run('ci', 'completed', 'success'))

    expect(await poll()).toEqual({ green: [id], red: [], silent: [], waiting: 0 })

    expect(await row(id)).toMatchObject({ status: 'green', revertUrl: null })
    expect((await row(id)).endedAt).not.toBeNull()
    expect(reverts()).toEqual([])
  })

  it('opens a revert pull request when the default branch goes red, once, and never merges it', async () => {
    const id = await watching()
    checked(run('ci', 'completed', 'failure'), run('lint', 'completed', 'success'))

    const first = await poll()
    const second = await poll()

    expect(first.red).toEqual([id])
    expect(second).toEqual({ green: [], red: [], silent: [], waiting: 0 })
    expect(reverts()).toHaveLength(1)
    expect(reverts()[0].number).toBe(12)
    expect(reverts()[0].title).toMatch(/^Revert: Add truncate \(#\d+\)$/)
    expect(reverts()[0].body).toContain('`ci`')
    expect(reverts()[0].body).toContain('v0.1.0')
    expect(reverts()[0].body).toContain('merge0')
    expect(reverts()[0].body).toContain('will not merge it')
    expect(await row(id)).toMatchObject({
      status: 'red',
      revertUrl: 'https://github.com/paulo/app/pull/41',
      detail: 'failing: ci',
    })
    expect(merges()).toEqual([])
  })

  it('does not wait for the slow checks once one has failed', async () => {
    const id = await watching()
    checked(run('ci', 'completed', 'timed_out'), run('e2e', 'in_progress', null))
    expect((await poll()).red).toEqual([id])
  })

  it('keeps watching while checks run, and when none has reported yet', async () => {
    const running = await watching()
    checked(run('ci', 'in_progress', null))
    expect(await poll()).toMatchObject({ waiting: 1, green: [], red: [] })
    expect((await row(running)).status).toBe('watching')

    checked()
    expect((await poll()).waiting).toBe(1)
  })

  it('gives up with a reason when the window is over and no check ever said anything', async () => {
    const quiet = await watching(new Date('2026-11-04T10:00:00Z'))
    checked()
    const later = () => new Date('2026-11-04T11:30:00Z')

    const result = await poll({ now: later, windowMs: 60 * 60_000 })

    expect(result.silent).toEqual([quiet])
    expect(await row(quiet)).toMatchObject({
      status: 'silent',
      detail: 'no check reported on the merge commit after 60 minutes',
    })
    expect(reverts()).toEqual([])
  })

  it('also gives up, saying so, when checks are still running after the window', async () => {
    const slow = await watching(new Date('2026-11-04T10:00:00Z'))
    checked(run('ci', 'queued', null))
    await poll({ now: () => new Date('2026-11-04T11:30:00Z'), windowMs: 60 * 60_000 })
    expect((await row(slow)).detail).toContain('checks were still running')
  })

  it('records a revert GitHub would not open, so a person is told there is none', async () => {
    const id = await watching()
    checked(run('ci', 'completed', 'failure'))
    api.fail(
      'revertPullRequest',
      new Error('GitHub would not open a revert of paulo/app#12: conflicts'),
    )

    await poll()

    const stored = await row(id)
    expect(stored.status).toBe('red')
    expect(stored.revertUrl).toBeNull()
    expect(stored.detail).toContain('no revert was opened')
    expect(stored.detail).toContain('conflicts')
  })

  it('does not look at a watch that has already ended', async () => {
    const id = await watching()
    await getDb().update(watch).set({ status: 'green' }).where(eq(watch.id, id))
    checked(run('ci', 'completed', 'failure'))
    expect(await poll()).toEqual({ green: [], red: [], silent: [], waiting: 0 })
    expect(reverts()).toEqual([])
  })

  it('watches each release on its own', async () => {
    const a = await watching()
    const b = await watching()
    checked(run('ci', 'completed', 'failure'))
    const result = await poll()
    expect(result.red.sort()).toEqual([a, b].sort())
    expect(reverts()).toHaveLength(2)
  })
})
