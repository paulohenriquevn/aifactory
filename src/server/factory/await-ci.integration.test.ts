import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { decision, delivery, ingress, review, stageEvent, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { CheckReport, GithubApi, PullRequestDetail, ReleaseInput } from '../github/pulls'

import { pollAwaitingIntegrations, type AwaitCiDeps } from './await-ci'
import { CI_SILENCE_MS } from './ci-wait'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
afterAll(() => getStorageManager().dispose())

const VERIFIED = 'abc1234def'
const PR_URL = 'https://github.com/paulo/app/pull/12'
const NOW = new Date('2026-11-11T12:00:00Z')

/** GitHub as the wait for the repository's checks sees it, scripted per test. */
const gh = {
  pull: undefined as PullRequestDetail | undefined,
  required: ['CI'] as string[],
  reports: [] as CheckReport[],
  readFails: false,
  autoMergeOff: [] as number[],
  deleted: [] as string[],
  branchMerges: [] as { base: string; head: string }[],
  releases: [] as ReleaseInput[],
  comments: [] as { issue: number; body: string }[],
}
const sentBack: { taskId: number; note: string }[] = []
const startedOver: number[] = []

const openPull = (over: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  number: 12,
  url: PR_URL,
  state: 'open',
  merged: false,
  headSha: VERIFIED,
  autoMerge: true,
  mergeableState: 'blocked',
  ...over,
})

beforeEach(async () => {
  await getPool().query(
    'truncate table publication, watch, delivery, decision, question, review, evidence, stage_event, task, ingress, repository restart identity cascade',
  )
  Object.assign(gh, {
    pull: openPull(),
    required: ['CI'],
    reports: [{ name: 'CI', state: 'pending', detail: '', url: 'u' }],
    readFails: false,
    autoMergeOff: [],
    deleted: [],
    branchMerges: [],
    releases: [],
    comments: [],
  })
  sentBack.length = 0
  startedOver.length = 0
})

const api = {
  readPullRequest: async () => {
    if (gh.readFails) throw new Error('GitHub answered 502 reading paulo/app#12')
    return gh.pull
  },
  requiredChecks: async () => gh.required,
  checkReports: async () => gh.reports,
  disableAutoMerge: async (_repo: string, _token: string, number: number) =>
    void gh.autoMergeOff.push(number),
  deleteBranch: async (_repo: string, _token: string, branch: string) =>
    void gh.deleted.push(branch),
  mergeBranch: async (_repo: string, _token: string, base: string, head: string) => {
    gh.branchMerges.push({ base, head })
    return { sha: 'develop0001', changed: true }
  },
  createRelease: async (_repo: string, _token: string, release: ReleaseInput) => {
    gh.releases.push(release)
    return { id: 1, tag: release.tag, url: `https://github.com/paulo/app/releases/${release.tag}` }
  },
  commentOnIssue: async (_repo: string, _token: string, issue: number, body: string) => {
    gh.comments.push({ issue, body })
    return 'c1'
  },
} as unknown as GithubApi

const deps = (over: Partial<AwaitCiDeps> = {}): AwaitCiDeps => ({
  db: getDb(),
  github: {
    installationToken: async () => ({ token: 't', expiresAt: new Date() }),
  } as unknown as GithubApp,
  api,
  releaseMode: undefined,
  now: () => NOW,
  sendBack: async (taskId, note) => {
    sentBack.push({ taskId, note })
    await getDb()
      .update(task)
      .set({ stage: 'intake', awaitingCiSha: null })
      .where(eq(task.id, taskId))
  },
  startOver: async (taskId) => {
    startedOver.push(taskId)
  },
  ...over,
})

let seeded = 0
/** A task the factory finished and whose pull request waits for the repository's checks since `at`. */
async function waitingTask(
  options: {
    at?: Date
    automaticRuns?: number
    awaiting?: string | null
    stage?: string
    issueNumber?: number
  } = {},
) {
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
      issueNumber: options.issueNumber ?? 7,
      issueTitle: 'Add truncate',
      stage: (options.stage ?? 'done') as never,
      headSha: VERIFIED,
      pullRequestUrl: PR_URL,
      awaitingCiSha: options.awaiting === undefined ? VERIFIED : options.awaiting,
      costUsd: 0.42,
    })
    .returning({ id: task.id })
  for (let n = 0; n < (options.automaticRuns ?? 0); n++) {
    await db.insert(stageEvent).values({
      taskId: t.id,
      stage: 'intake',
      detail: { decision: 'request_changes', automatic: true },
    })
  }
  await db.insert(review).values({
    taskId: t.id,
    round: 1,
    sha: VERIFIED,
    reviewer: 'fake-reviewer',
    verdict: 'approve',
    summary: 'fine',
    findings: [],
  })
  await db.insert(stageEvent).values({
    taskId: t.id,
    stage: 'done',
    at: options.at ?? new Date(NOW.getTime() - 60_000),
    detail: {
      sha: VERIFIED,
      pullRequestUrl: PR_URL,
      attempts: 2,
      agentSummary: 'added truncate',
      awaitingChecks: ['CI'],
    },
  })
  return t.id
}

const row = async (id: number) => (await getDb().select().from(task).where(eq(task.id, id)))[0]
const events = (id: number) =>
  getDb().select().from(stageEvent).where(eq(stageEvent.taskId, id)).orderBy(stageEvent.id)

describe('pollAwaitingIntegrations', () => {
  it('waits while the required checks run, and changes nothing', async () => {
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ waiting: 1, errors: [] })

    expect(await row(id)).toMatchObject({ stage: 'done', awaitingCiSha: VERIFIED, mergedSha: null })
    expect(gh.autoMergeOff).toEqual([])
  })

  it('finishes the integration GitHub merged: develop advances and the pre-release is made there', async () => {
    gh.pull = openPull({ state: 'closed', merged: true, mergeCommitSha: 'merge0001' })
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ merged: [id] })

    expect(await row(id)).toMatchObject({
      stage: 'done',
      mergedSha: 'merge0001',
      awaitingCiSha: null,
    })
    expect(gh.deleted).toEqual(['factory/7'])
    expect(gh.branchMerges).toEqual([{ base: 'develop', head: 'merge0001' }])
    expect(gh.releases).toMatchObject([{ sha: 'develop0001', prerelease: true }])
    expect(gh.releases[0].body).toContain('added truncate')
    expect(await getDb().select().from(delivery)).toMatchObject([
      { taskId: id, kind: 'prerelease', sha: 'develop0001' },
    ])
    const done = (await events(id)).at(-1)!
    expect(done).toMatchObject({ stage: 'done' })
    expect(done.detail).toMatchObject({
      sha: VERIFIED,
      pullRequestUrl: PR_URL,
      integratedBy: 'auto-merge',
      mergedSha: 'merge0001',
      developSha: 'develop0001',
      preRelease: expect.stringMatching(/^pre\/7-/),
    })
  })

  it('records what an agent would release, in trial mode, once the merge is integrated', async () => {
    gh.pull = openPull({ state: 'closed', merged: true, mergeCommitSha: 'merge0001' })
    const id = await waitingTask()

    await pollAwaitingIntegrations(deps({ releaseMode: 'trial' }))

    expect(await getDb().select().from(decision)).toMatchObject([
      {
        taskId: id,
        kind: 'would_release',
        sha: VERIFIED,
        note: expect.stringMatching(/^agent:fake-reviewer/),
      },
    ])
  })

  it('finishes a merge once, when a second pass sees it again', async () => {
    gh.pull = openPull({ state: 'closed', merged: true, mergeCommitSha: 'merge0001' })
    const id = await waitingTask()

    await pollAwaitingIntegrations(deps())
    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ merged: [], waiting: 0 })

    expect(gh.branchMerges).toHaveLength(1)
    expect((await events(id)).filter((e) => e.stage === 'done')).toHaveLength(2)
  })

  it('turns auto-merge off and sends the work back with each failed check', async () => {
    gh.reports = [
      { name: 'CI', state: 'failure', detail: 'foo.test.ts failed', url: 'https://ci/1' },
    ]
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ sentBack: [id] })

    expect(gh.autoMergeOff).toEqual([12])
    expect(sentBack).toEqual([{ taskId: id, note: expect.stringContaining('- CI: https://ci/1') }])
    expect(sentBack[0].note).toContain('foo.test.ts failed')
  })

  it('hands to a person the checks that still fail after the automatic runs, and says so on the issue', async () => {
    gh.reports = [{ name: 'CI', state: 'failure', detail: '', url: 'https://ci/1' }]
    const id = await waitingTask({ automaticRuns: 3 })

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ toPerson: [id] })

    expect(sentBack).toEqual([])
    expect(gh.autoMergeOff).toEqual([12])
    expect(await row(id)).toMatchObject({ stage: 'handoff', awaitingCiSha: null })
    const handoff = (await events(id)).at(-1)!
    expect(handoff).toMatchObject({ stage: 'handoff' })
    expect(handoff.detail).toMatchObject({
      reason: expect.stringMatching(/still fail after 3 automatic runs: CI/),
      pullRequestUrl: PR_URL,
      sha: VERIFIED,
    })
    expect(gh.comments).toEqual([
      {
        issue: 7,
        body: expect.stringMatching(/still fail after 3 automatic runs: CI[\s\S]*pull\/12/),
      },
    ])
  })

  it('stops auto-merge and hands to a person a pull request someone pushed to', async () => {
    gh.pull = openPull({ headSha: 'pushed1234' })
    const id = await waitingTask()

    await pollAwaitingIntegrations(deps())

    expect(gh.autoMergeOff).toEqual([12])
    expect(await row(id)).toMatchObject({ stage: 'handoff', awaitingCiSha: null, mergedSha: null })
  })

  it('leaves auto-merge alone on a pull request a person closed', async () => {
    gh.pull = openPull({ state: 'closed' })
    const id = await waitingTask()

    await pollAwaitingIntegrations(deps())

    expect(gh.autoMergeOff).toEqual([])
    expect(await row(id)).toMatchObject({ stage: 'handoff' })
  })

  it('starts over a pull request that conflicts with its base', async () => {
    gh.pull = openPull({ mergeableState: 'dirty' })
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ startedOver: [id] })

    expect(startedOver).toEqual([id])
  })

  it('tells a person about a required check that never reports', async () => {
    gh.reports = []
    const id = await waitingTask({ at: new Date(NOW.getTime() - CI_SILENCE_MS - 60_000) })

    await pollAwaitingIntegrations(deps())

    expect(await row(id)).toMatchObject({ stage: 'handoff' })
    expect(gh.comments[0].body).toMatch(/CI never reported/)
  })

  it('looks only at tasks that wait for the repository checks', async () => {
    await waitingTask({ awaiting: null })
    await waitingTask({ stage: 'intake', issueNumber: 8 })

    expect(await pollAwaitingIntegrations(deps())).toEqual({
      merged: [],
      sentBack: [],
      startedOver: [],
      toPerson: [],
      waiting: 0,
      errors: [],
    })
  })

  it('records what stopped one task and goes on with the others', async () => {
    gh.readFails = true
    const id = await waitingTask()

    const result = await pollAwaitingIntegrations(deps())

    expect(result.errors).toEqual([expect.stringMatching(new RegExp(`^task ${id}: .*502`))])
    expect(await row(id)).toMatchObject({ stage: 'done', awaitingCiSha: VERIFIED })
  })
})
