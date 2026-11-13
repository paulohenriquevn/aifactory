import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import {
  decision,
  delivery,
  ingress,
  publication,
  releaseWait,
  stageEvent,
  task,
  watch,
} from '../db/schema'
import type { GithubApp } from '../github/app'
import { FakeGithub, type FakePullRequest } from '../../test/fake-github'
import type { CheckReport } from '../github/pulls'

import { pollAwaitingReleases, type AwaitReleaseDeps } from './await-release'
import { CI_SILENCE_MS } from './ci-wait'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
afterAll(() => getStorageManager().dispose())

const PINNED = 'dev1234beef'
const RELEASE_PR = 'https://github.com/paulo/app/pull/381'
const NOW = new Date('2026-11-12T12:00:00Z')

/** GitHub as the wait for the release branch's checks sees it: the release pull request, waiting for `CI`. */
let api = new FakeGithub()
const repo = () => api.repo('paulo/app')

/** Sets how the release pull request stands on GitHub. */
const pull = (over: Partial<FakePullRequest> = {}) =>
  repo().pullRequest({
    number: 381,
    url: RELEASE_PR,
    headRef: 'develop',
    baseRef: 'main',
    headSha: PINNED,
    autoMerge: true,
    mergeableState: 'blocked',
    ...over,
  })
/** Sets what the checks on the pinned head report: these and nothing else. */
const reports = (...list: CheckReport[]) => {
  repo().clearChecks(PINNED)
  for (const report of list) repo().report(PINNED, report)
}
const autoMergeOff = () => api.answered('disableAutoMerge').map(([number]) => number)
const releases = () => api.callsTo('createRelease').map(([release]) => release)
/** The issues the release closed. */
const closed = () => api.answered('closeIssue').map(([issue]) => issue)

beforeEach(async () => {
  await getPool().query(
    'truncate table release_wait, publication, watch, delivery, decision, review, evidence, stage_event, task, ingress, repository restart identity cascade',
  )
  api = new FakeGithub()
  repo().prepare().required.set('main', ['CI'])
  repo().tags.add('v1.2.3')
  pull()
  reports({ name: 'CI', state: 'pending', detail: '', url: 'u' })
})

const deps = (over: Partial<AwaitReleaseDeps> = {}): AwaitReleaseDeps => ({
  db: getDb(),
  github: {
    installationToken: async () => ({ token: 't', expiresAt: new Date() }),
  } as unknown as GithubApp,
  get api() {
    return api
  },
  now: () => NOW,
  ...over,
})

let seeded = 0
/** A delivered task whose release waits, since `at`, for the release branch's required checks. */
async function waitingRelease(
  options: { at?: Date; changesets?: boolean; actor?: string } = {},
): Promise<number> {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `d-${++seeded}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await db
    .insert(task)
    .values({
      ingressId: i.id,
      repository: 'paulo/app',
      issueNumber: 7,
      issueTitle: 'Add truncate',
      stage: 'done',
      headSha: 'abc123def',
      pullRequestUrl: 'https://github.com/paulo/app/pull/12',
      mergedSha: 'merged0001',
    })
    .returning({ id: task.id })
  await db.insert(delivery).values({
    taskId: t.id,
    kind: 'prerelease',
    tag: 'pre/7-develop',
    url: 'https://github.com/paulo/app/releases/pre/7-develop',
    sha: PINNED,
    actor: 'factory',
  })
  await db.insert(releaseWait).values({
    taskId: t.id,
    repository: 'paulo/app',
    pullRequestNumber: 381,
    pullRequestUrl: RELEASE_PR,
    sha: PINNED,
    releaseBranch: 'main',
    bump: 'minor',
    actor: options.actor ?? 'human',
    changesets: options.changesets ?? false,
    checks: ['CI'],
    startedAt: options.at ?? new Date(NOW.getTime() - 60_000),
  })
  return t.id
}

const taskRow = async (id: number) => (await getDb().select().from(task).where(eq(task.id, id)))[0]
const waits = () => getDb().select().from(releaseWait).orderBy(releaseWait.id)
const mergedPull = () => pull({ state: 'closed', merged: true, mergeCommitSha: 'main0001' })

describe('pollAwaitingReleases', () => {
  it('waits while the required checks of the release branch run, and changes nothing', async () => {
    const id = await waitingRelease()

    expect(await pollAwaitingReleases(deps())).toEqual({
      released: [],
      refused: [],
      waiting: 1,
      errors: [],
    })

    expect(await taskRow(id)).toMatchObject({ stage: 'done' })
    expect(await waits()).toMatchObject([{ status: 'waiting', endedAt: null }])
    expect(releases()).toEqual([])
  })

  it('finishes the release GitHub merged at the pinned head: the tag, the delivery, the watch', async () => {
    mergedPull()
    const id = await waitingRelease()

    expect(await pollAwaitingReleases(deps())).toMatchObject({ released: [id], errors: [] })

    expect(releases()).toMatchObject([{ tag: 'v1.3.0', sha: 'main0001', prerelease: false }])
    expect(releases()[0].body).toContain('pre/7-develop')
    expect(releases()[0].body).toContain(RELEASE_PR)
    expect(await taskRow(id)).toMatchObject({ stage: 'released' })
    expect(await waits()).toMatchObject([{ status: 'merged' }])
    expect(await getDb().select().from(delivery).where(eq(delivery.kind, 'release'))).toMatchObject(
      [{ taskId: id, tag: 'v1.3.0', sha: 'main0001', actor: 'human' }],
    )
    expect(await getDb().select().from(decision)).toMatchObject([
      { taskId: id, kind: 'release', sha: PINNED, note: 'human -> v1.3.0' },
    ])
    expect(await getDb().select().from(watch)).toMatchObject([
      { taskId: id, sha: 'main0001', pullRequestNumber: 381, tag: 'v1.3.0', status: 'watching' },
    ])
    const [released] = await getDb()
      .select()
      .from(stageEvent)
      .where(eq(stageEvent.stage, 'released'))
    expect(released.detail).toMatchObject({ actor: 'human', mergeSha: 'main0001', tag: 'v1.3.0' })
    expect(closed()).toEqual([7])
  })

  it('finishes a release only once, however many passes see the merge', async () => {
    mergedPull()
    const id = await waitingRelease()
    await pollAwaitingReleases(deps())

    expect(await pollAwaitingReleases(deps())).toMatchObject({ released: [], waiting: 0 })
    expect(releases()).toHaveLength(1)
    expect(await taskRow(id)).toMatchObject({ stage: 'released' })
  })

  it('records the publication of a changesets repository once the promotion landed, with no tag', async () => {
    mergedPull()
    const id = await waitingRelease({ changesets: true })

    expect(await pollAwaitingReleases(deps())).toMatchObject({ released: [id] })

    expect(releases()).toEqual([])
    expect(await getDb().select().from(publication)).toMatchObject([
      {
        taskId: id,
        repository: 'paulo/app',
        releaseBranch: 'main',
        promotedSha: 'main0001',
        actor: 'human',
        status: 'waiting',
      },
    ])
    expect(await getDb().select().from(watch)).toMatchObject([{ sha: 'main0001', tag: null }])
  })

  it('refuses the release when a required check fails, names it, stops auto-merge and never retries', async () => {
    reports({ name: 'CI', state: 'failure', detail: 'lint failed', url: 'u' })
    const id = await waitingRelease()

    expect(await pollAwaitingReleases(deps())).toMatchObject({ refused: [id], errors: [] })

    expect(autoMergeOff()).toEqual([381])
    const [refused] = await waits()
    expect(refused).toMatchObject({
      status: 'refused',
      detail: 'the required check of main failed on the release pull request: CI',
    })
    expect(refused.endedAt).not.toBeNull()
    expect(await taskRow(id)).toMatchObject({ stage: 'done' })
    expect(releases()).toEqual([])
    expect(await getDb().select().from(watch)).toEqual([])
    // A refused release is not looked at again.
    expect(await pollAwaitingReleases(deps())).toEqual({
      released: [],
      refused: [],
      waiting: 0,
      errors: [],
    })
    expect(autoMergeOff()).toEqual([381])
  })

  it('records an automatic release that was refused as a decision an agent would have made', async () => {
    reports({ name: 'CI', state: 'failure', detail: '', url: 'u' })
    const id = await waitingRelease({ actor: 'agent:fake-reviewer' })

    await pollAwaitingReleases(deps())

    expect(await getDb().select().from(decision)).toMatchObject([
      {
        taskId: id,
        kind: 'would_release',
        sha: PINNED,
        note: 'an automatic release was refused: the required check of main failed on the release pull request: CI',
      },
    ])
  })

  it('still refuses when auto-merge cannot be turned off, and says so', async () => {
    reports({ name: 'CI', state: 'failure', detail: '', url: 'u' })
    api.fail('disableAutoMerge', new Error('GitHub could not turn auto-merge off on paulo/app#381'))
    await waitingRelease()

    await pollAwaitingReleases(deps())

    const [refused] = await waits()
    expect(refused.status).toBe('refused')
    expect(refused.detail).toContain('turning auto-merge off failed: GitHub could not turn')
  })

  it('refuses a release whose checks never reported, once the wait is past the limit', async () => {
    reports()
    await waitingRelease({ at: new Date(NOW.getTime() - CI_SILENCE_MS - 1) })

    await pollAwaitingReleases(deps())

    expect((await waits())[0]).toMatchObject({ status: 'refused' })
    expect((await waits())[0].detail).toContain('never reported')
  })

  it('records a pass that GitHub failed and looks again on the next one', async () => {
    api.fail('readPullRequest', new Error('GitHub answered 502 reading paulo/app#381'))
    const id = await waitingRelease()

    const result = await pollAwaitingReleases(deps())

    expect(result.errors).toEqual([`task ${id}: GitHub answered 502 reading paulo/app#381`])
    expect(await waits()).toMatchObject([{ status: 'waiting' }])
  })
})
