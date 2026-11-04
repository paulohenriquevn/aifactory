import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, task, watch } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { CommitChecks, GithubApi } from '../github/pulls'

import { pollWatches } from './watch'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table watch, delivery, decision, question, review, evidence, stage_event, task, ingress restart identity cascade',
  )
  reverts.length = 0
  merges.length = 0
  revertFails = false
})
afterAll(() => getStorageManager().dispose())

const run = (name: string, status: string, conclusion: string | null) => ({
  name,
  status,
  conclusion,
})
let checks: CommitChecks = { checkRuns: [], statuses: 'none' }
const reverts: { number: number; title: string; body: string }[] = []
const merges: number[] = []
let revertFails = false

const api = {
  commitChecks: async () => checks,
  revertPullRequest: async (
    _repo: string,
    _token: string,
    number: number,
    revert: { title: string; body: string },
  ) => {
    if (revertFails) throw new Error('GitHub would not open a revert of paulo/app#12: conflicts')
    reverts.push({ number, ...revert })
    return {
      number: 40 + reverts.length,
      url: `https://github.com/paulo/app/pull/${40 + reverts.length}`,
    }
  },
  // The watcher must never merge anything. If it ever calls this, the test fails by throwing.
  mergePullRequest: async (_repo: string, _token: string, number: number) => {
    merges.push(number)
    throw new Error('the watcher must never merge')
  },
} as unknown as GithubApi
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
      sha: 'merge0001abcdef',
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
    checks = { checkRuns: [run('ci', 'completed', 'failure')], statuses: 'none' }
    let during: string | undefined
    const slow = {
      ...api,
      revertPullRequest: async () => {
        during = (await row(id)).status
        return { number: 50, url: 'https://github.com/paulo/app/pull/50' }
      },
    } as unknown as GithubApi

    await pollWatches({ db: getDb(), github, api: slow })

    expect(during).toBe('reverting')
    expect(await row(id)).toMatchObject({
      status: 'red',
      revertUrl: 'https://github.com/paulo/app/pull/50',
    })
  })

  it('leaves a watch that is already reverting alone, so a crash cannot open a second revert', async () => {
    const id = await watching()
    await getDb().update(watch).set({ status: 'reverting' }).where(eq(watch.id, id))
    checks = { checkRuns: [run('ci', 'completed', 'failure')], statuses: 'none' }

    expect(await poll()).toEqual({ green: [], red: [], silent: [], waiting: 0 })
    expect(reverts).toEqual([])
  })
})

describe('pollWatches', () => {
  it('ends a watch green when the checks on the merge commit pass, and opens nothing', async () => {
    const id = await watching()
    checks = { checkRuns: [run('ci', 'completed', 'success')], statuses: 'none' }

    expect(await poll()).toEqual({ green: [id], red: [], silent: [], waiting: 0 })

    expect(await row(id)).toMatchObject({ status: 'green', revertUrl: null })
    expect((await row(id)).endedAt).not.toBeNull()
    expect(reverts).toEqual([])
  })

  it('opens a revert pull request when the default branch goes red, once, and never merges it', async () => {
    const id = await watching()
    checks = {
      checkRuns: [run('ci', 'completed', 'failure'), run('lint', 'completed', 'success')],
      statuses: 'none',
    }

    const first = await poll()
    const second = await poll()

    expect(first.red).toEqual([id])
    expect(second).toEqual({ green: [], red: [], silent: [], waiting: 0 })
    expect(reverts).toHaveLength(1)
    expect(reverts[0].number).toBe(12)
    expect(reverts[0].title).toMatch(/^Revert: Add truncate \(#\d+\)$/)
    expect(reverts[0].body).toContain('`ci`')
    expect(reverts[0].body).toContain('v0.1.0')
    expect(reverts[0].body).toContain('merge0')
    expect(reverts[0].body).toContain('will not merge it')
    expect(await row(id)).toMatchObject({
      status: 'red',
      revertUrl: 'https://github.com/paulo/app/pull/41',
      detail: 'failing: ci',
    })
    expect(merges).toEqual([])
  })

  it('does not wait for the slow checks once one has failed', async () => {
    const id = await watching()
    checks = {
      checkRuns: [run('ci', 'completed', 'timed_out'), run('e2e', 'in_progress', null)],
      statuses: 'none',
    }
    expect((await poll()).red).toEqual([id])
  })

  it('keeps watching while checks run, and when none has reported yet', async () => {
    const running = await watching()
    checks = { checkRuns: [run('ci', 'in_progress', null)], statuses: 'none' }
    expect(await poll()).toMatchObject({ waiting: 1, green: [], red: [] })
    expect((await row(running)).status).toBe('watching')

    checks = { checkRuns: [], statuses: 'none' }
    expect((await poll()).waiting).toBe(1)
  })

  it('gives up with a reason when the window is over and no check ever said anything', async () => {
    const quiet = await watching(new Date('2026-11-04T10:00:00Z'))
    checks = { checkRuns: [], statuses: 'none' }
    const later = () => new Date('2026-11-04T11:30:00Z')

    const result = await poll({ now: later, windowMs: 60 * 60_000 })

    expect(result.silent).toEqual([quiet])
    expect(await row(quiet)).toMatchObject({
      status: 'silent',
      detail: 'no check reported on the merge commit after 60 minutes',
    })
    expect(reverts).toEqual([])
  })

  it('also gives up, saying so, when checks are still running after the window', async () => {
    const slow = await watching(new Date('2026-11-04T10:00:00Z'))
    checks = { checkRuns: [run('ci', 'queued', null)], statuses: 'none' }
    await poll({ now: () => new Date('2026-11-04T11:30:00Z'), windowMs: 60 * 60_000 })
    expect((await row(slow)).detail).toContain('checks were still running')
  })

  it('records a revert GitHub would not open, so a person is told there is none', async () => {
    const id = await watching()
    checks = { checkRuns: [run('ci', 'completed', 'failure')], statuses: 'none' }
    revertFails = true

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
    checks = { checkRuns: [run('ci', 'completed', 'failure')], statuses: 'none' }
    expect(await poll()).toEqual({ green: [], red: [], silent: [], waiting: 0 })
    expect(reverts).toEqual([])
  })

  it('watches each release on its own', async () => {
    const a = await watching()
    const b = await watching()
    checks = { checkRuns: [run('ci', 'completed', 'failure')], statuses: 'none' }
    const result = await poll()
    expect(result.red.sort()).toEqual([a, b].sort())
    expect(reverts).toHaveLength(2)
  })
})
