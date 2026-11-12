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
import type { CheckReport, GithubApi, PullRequestDetail, ReleaseInput } from '../github/pulls'

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

/** GitHub as the wait for the release branch's checks sees it, scripted per test. */
const gh = {
  pull: undefined as PullRequestDetail | undefined,
  required: ['CI'] as string[],
  reports: [] as CheckReport[],
  readFails: false,
  disableFails: false,
  autoMergeOff: [] as number[],
  releases: [] as ReleaseInput[],
  latest: 'v1.2.3' as string | undefined,
  /** The issues the release closed. */
  closed: [] as number[],
}

const openPull = (over: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  number: 381,
  url: RELEASE_PR,
  state: 'open',
  merged: false,
  headSha: PINNED,
  autoMerge: true,
  mergeableState: 'blocked',
  ...over,
})

beforeEach(async () => {
  await getPool().query(
    'truncate table release_wait, publication, watch, delivery, decision, review, evidence, stage_event, task, ingress, repository restart identity cascade',
  )
  Object.assign(gh, {
    pull: openPull(),
    required: ['CI'],
    reports: [{ name: 'CI', state: 'pending', detail: '', url: 'u' }],
    readFails: false,
    disableFails: false,
    autoMergeOff: [],
    releases: [],
    latest: 'v1.2.3',
    closed: [],
  })
})

const api = {
  readPullRequest: async () => {
    if (gh.readFails) throw new Error('GitHub answered 502 reading paulo/app#381')
    return gh.pull
  },
  requiredChecks: async () => gh.required,
  checkReports: async () => gh.reports,
  disableAutoMerge: async (_repo: string, _token: string, number: number) => {
    if (gh.disableFails) throw new Error('GitHub could not turn auto-merge off on paulo/app#381')
    gh.autoMergeOff.push(number)
  },
  latestReleaseTag: async () => gh.latest,
  contains: async () => true,
  commentOnIssue: async () => 'c',
  closeIssue: async (_repo: string, _token: string, issue: number) => {
    gh.closed.push(issue)
  },
  createRelease: async (_repo: string, _token: string, release: ReleaseInput) => {
    gh.releases.push(release)
    return { id: 1, tag: release.tag, url: `https://github.com/paulo/app/releases/${release.tag}` }
  },
} as unknown as GithubApi

const deps = (over: Partial<AwaitReleaseDeps> = {}): AwaitReleaseDeps => ({
  db: getDb(),
  github: {
    installationToken: async () => ({ token: 't', expiresAt: new Date() }),
  } as unknown as GithubApp,
  api,
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
const mergedPull = () => openPull({ state: 'closed', merged: true, mergeCommitSha: 'main0001' })

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
    expect(gh.releases).toEqual([])
  })

  it('finishes the release GitHub merged at the pinned head: the tag, the delivery, the watch', async () => {
    gh.pull = mergedPull()
    const id = await waitingRelease()

    expect(await pollAwaitingReleases(deps())).toMatchObject({ released: [id], errors: [] })

    expect(gh.releases).toMatchObject([{ tag: 'v1.3.0', sha: 'main0001', prerelease: false }])
    expect(gh.releases[0].body).toContain('pre/7-develop')
    expect(gh.releases[0].body).toContain(RELEASE_PR)
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
    expect(gh.closed).toEqual([7])
  })

  it('finishes a release only once, however many passes see the merge', async () => {
    gh.pull = mergedPull()
    const id = await waitingRelease()
    await pollAwaitingReleases(deps())

    expect(await pollAwaitingReleases(deps())).toMatchObject({ released: [], waiting: 0 })
    expect(gh.releases).toHaveLength(1)
    expect(await taskRow(id)).toMatchObject({ stage: 'released' })
  })

  it('records the publication of a changesets repository once the promotion landed, with no tag', async () => {
    gh.pull = mergedPull()
    const id = await waitingRelease({ changesets: true })

    expect(await pollAwaitingReleases(deps())).toMatchObject({ released: [id] })

    expect(gh.releases).toEqual([])
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
    gh.reports = [{ name: 'CI', state: 'failure', detail: 'lint failed', url: 'u' }]
    const id = await waitingRelease()

    expect(await pollAwaitingReleases(deps())).toMatchObject({ refused: [id], errors: [] })

    expect(gh.autoMergeOff).toEqual([381])
    const [refused] = await waits()
    expect(refused).toMatchObject({
      status: 'refused',
      detail: 'the required check of main failed on the release pull request: CI',
    })
    expect(refused.endedAt).not.toBeNull()
    expect(await taskRow(id)).toMatchObject({ stage: 'done' })
    expect(gh.releases).toEqual([])
    expect(await getDb().select().from(watch)).toEqual([])
    // A refused release is not looked at again.
    expect(await pollAwaitingReleases(deps())).toEqual({
      released: [],
      refused: [],
      waiting: 0,
      errors: [],
    })
    expect(gh.autoMergeOff).toEqual([381])
  })

  it('records an automatic release that was refused as a decision an agent would have made', async () => {
    gh.reports = [{ name: 'CI', state: 'failure', detail: '', url: 'u' }]
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
    gh.reports = [{ name: 'CI', state: 'failure', detail: '', url: 'u' }]
    gh.disableFails = true
    await waitingRelease()

    await pollAwaitingReleases(deps())

    const [refused] = await waits()
    expect(refused.status).toBe('refused')
    expect(refused.detail).toContain('turning auto-merge off failed: GitHub could not turn')
  })

  it('refuses a release whose checks never reported, once the wait is past the limit', async () => {
    gh.reports = []
    await waitingRelease({ at: new Date(NOW.getTime() - CI_SILENCE_MS - 1) })

    await pollAwaitingReleases(deps())

    expect((await waits())[0]).toMatchObject({ status: 'refused' })
    expect((await waits())[0].detail).toContain('never reported')
  })

  it('records a pass that GitHub failed and looks again on the next one', async () => {
    gh.readFails = true
    const id = await waitingRelease()

    const result = await pollAwaitingReleases(deps())

    expect(result.errors).toEqual([`task ${id}: GitHub answered 502 reading paulo/app#381`])
    expect(await waits()).toMatchObject([{ status: 'waiting' }])
  })
})
