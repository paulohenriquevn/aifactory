import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { decision, delivery, ingress, review, stageEvent, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { FailedRun } from '../github/promotion-api'
import { FakeGithub, githubAnswered, type FakePullRequest } from '../../test/fake-github'
import type { CheckReport } from '../github/pulls'

import { pollAwaitingIntegrations, type AwaitCiDeps } from './await-ci'
import type { EvidenceApi } from './check-evidence'
import { CI_SILENCE_MS } from './ci-wait'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
afterAll(() => getStorageManager().dispose())

const VERIFIED = 'abc1234def'
const PR_URL = 'https://github.com/paulo/app/pull/12'
const NOW = new Date('2026-11-11T12:00:00Z')

/** GitHub as the wait for the repository's checks sees it: one pull request, waiting for `CI`. */
let api = new FakeGithub()
const repo = () => api.repo('paulo/app')

/** The failed check runs of the verified commit, with their logs and annotations, scripted per test. */
const gh = {
  failedRuns: [] as FailedRun[],
  logs: {} as Record<number, string>,
  annotations: {} as Record<number, string[]>,
  logFails: false,
  attempts: {} as Record<number, number>,
  rerunRefusal: undefined as string | undefined,
  reruns: [] as number[],
}
const sentBack: { taskId: number; note: string }[] = []
const startedOver: number[] = []

/** Sets how the task's pull request stands on GitHub. */
const pull = (over: Partial<FakePullRequest> = {}) =>
  repo().pullRequest({
    number: 12,
    url: PR_URL,
    headRef: 'factory/7',
    baseRef: 'workspace',
    headSha: VERIFIED,
    autoMerge: true,
    mergeableState: 'blocked',
    ...over,
  })
/** Sets what the checks on the verified commit report: these and nothing else. */
const reports = (...list: CheckReport[]) => {
  repo().clearChecks(VERIFIED)
  for (const report of list) repo().report(VERIFIED, report)
}
const autoMergeOff = () => api.answered('disableAutoMerge').map(([number]) => number)
const branchMerges = () => api.callsTo('mergeBranch').map(([base, head]) => ({ base, head }))
const releases = () => api.callsTo('createRelease').map(([release]) => release)
const comments = () => api.answered('commentOnIssue').map(([issue, body]) => ({ issue, body }))

beforeEach(async () => {
  await getPool().query(
    'truncate table publication, watch, delivery, decision, question, review, evidence, stage_event, task, ingress, repository restart identity cascade',
  )
  api = new FakeGithub()
  repo().prepare().required.set('workspace', ['CI'])
  pull()
  reports({ name: 'CI', state: 'pending', detail: '', url: 'u' })
  Object.assign(gh, {
    failedRuns: [],
    logs: {},
    annotations: {},
    logFails: false,
    attempts: {},
    rerunRefusal: undefined,
    reruns: [],
  })
  sentBack.length = 0
  startedOver.length = 0
})

const checks: EvidenceApi = {
  failedChecks: async (_repo, _token, sha) => (sha === VERIFIED ? gh.failedRuns : []),
  jobLog: async (_repo, _token, jobId) => {
    if (gh.logFails) throw new Error(`GitHub answered 410 reading the log of job ${jobId}`)
    return gh.logs[jobId] ?? ''
  },
  annotations: async (_repo, _token, checkRunId) => gh.annotations[checkRunId] ?? [],
  jobAttempt: async (_repo, _token, jobId) => ({
    runId: jobId * 10,
    attempt: gh.attempts[jobId] ?? 2,
  }),
  rerunFailedJobs: async (_repo, _token, runId) => {
    if (gh.rerunRefusal) return { started: false, refusal: gh.rerunRefusal }
    gh.reruns.push(runId)
    return { started: true }
  },
}

const deps = (over: Partial<AwaitCiDeps> = {}): AwaitCiDeps => ({
  db: getDb(),
  github: {
    installationToken: async () => ({ token: 't', expiresAt: new Date() }),
  } as unknown as GithubApp,
  get api() {
    return api
  },
  checks,
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
    expect(autoMergeOff()).toEqual([])
  })

  it('finishes the integration GitHub merged: develop advances and the pre-release is made there', async () => {
    pull({ state: 'closed', merged: true, mergeCommitSha: 'merge0001' })
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ merged: [id] })

    expect(await row(id)).toMatchObject({
      stage: 'done',
      mergedSha: 'merge0001',
      awaitingCiSha: null,
    })
    expect(api.callsTo('deleteBranch').map(([branch]) => branch)).toEqual(['factory/7'])
    expect(branchMerges()).toEqual([{ base: 'develop', head: 'merge0001' }])
    expect(releases()).toMatchObject([{ sha: 'develop0001', prerelease: true }])
    expect(releases()[0].body).toContain('added truncate')
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
    pull({ state: 'closed', merged: true, mergeCommitSha: 'merge0001' })
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
    pull({ state: 'closed', merged: true, mergeCommitSha: 'merge0001' })
    const id = await waitingTask()

    await pollAwaitingIntegrations(deps())
    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ merged: [], waiting: 0 })

    expect(branchMerges()).toHaveLength(1)
    expect((await events(id)).filter((e) => e.stage === 'done')).toHaveLength(2)
  })

  it('turns auto-merge off and sends the work back with each failed check', async () => {
    reports({ name: 'CI', state: 'failure', detail: 'foo.test.ts failed', url: 'https://ci/1' })
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ sentBack: [id] })

    expect(autoMergeOff()).toEqual([12])
    expect(sentBack).toEqual([{ taskId: id, note: expect.stringContaining('- CI: https://ci/1') }])
    expect(sentBack[0].note).toContain('foo.test.ts failed')
  })

  it('puts the error lines of a failed Actions job in the note, read with the repository token', async () => {
    const link = 'https://github.com/paulo/app/actions/runs/431/job/1308'
    reports({ name: 'CI', state: 'failure', detail: '', url: link })
    gh.failedRuns = [{ id: 1308, name: 'CI', url: link, summary: '', actions: true }]
    gh.logs = {
      1308: [
        '2026-11-12T10:00:00.0000000Z > npm run docs:coverage',
        '2026-11-12T10:00:01.0000000Z [doc-coverage] FAIL 99.7% is below the 100% floor',
        '2026-11-12T10:00:02.0000000Z ##[error]Process completed with exit code 1.',
      ].join('\n'),
    }
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ sentBack: [id] })

    expect(sentBack[0].note).toContain(`- CI: ${link}`)
    expect(sentBack[0].note).toContain(
      'CI:\n~~~~text\n[doc-coverage] FAIL 99.7% is below the 100% floor\n~~~~',
    )
  })

  it('names the step that exited and the line that says why', async () => {
    const link = 'https://github.com/paulo/app/actions/runs/431/job/1308'
    reports({ name: 'CI', state: 'failure', detail: '', url: link })
    gh.failedRuns = [{ id: 1308, name: 'CI', url: link, summary: '', actions: true }]
    gh.logs = {
      1308: [
        '2026-11-12T10:00:00.0000000Z ##[group]Run pnpm quality',
        'error types-dont-import-runtime: packages/sdk/src/types/agent.ts → packages/sdk/src/builtin-tools.ts',
        'ERROR: "quality:depcruise" exited with 1.',
        '2026-11-12T10:00:02.0000000Z ##[error]Process completed with exit code 1.',
      ].join('\n'),
    }
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ sentBack: [id] })

    const { note } = sentBack[0]
    expect(note).toContain('Step that exited: quality:depcruise (ran: pnpm quality)')
    expect(note).toContain('error types-dont-import-runtime: packages/sdk/src/types/agent.ts')
  })

  it('reruns a failed job on its first attempt and sends nothing back', async () => {
    const link = 'https://github.com/paulo/app/actions/runs/431/job/1308'
    reports({ name: 'CI', state: 'failure', detail: '', url: link })
    gh.failedRuns = [{ id: 1308, name: 'CI', url: link, summary: '', actions: true }]
    gh.attempts = { 1308: 1 }
    const id = await waitingTask()

    const result = await pollAwaitingIntegrations(deps())

    expect(result).toMatchObject({ rerun: [id], sentBack: [], toPerson: [], errors: [] })
    expect(gh.reruns).toEqual([13080])
    expect(sentBack).toEqual([])
    expect(autoMergeOff()).toEqual([])
    expect((await row(id)).awaitingCiSha).toBe(VERIFIED)
  })

  it('says the rerun was refused instead of blaming the work', async () => {
    const link = 'https://github.com/paulo/app/actions/runs/431/job/1308'
    reports({ name: 'CI', state: 'failure', detail: '', url: link })
    gh.failedRuns = [{ id: 1308, name: 'CI', url: link, summary: '', actions: true }]
    gh.attempts = { 1308: 1 }
    gh.rerunRefusal = 'GitHub answered 403 rerunning'
    const id = await waitingTask()

    const result = await pollAwaitingIntegrations(deps())

    expect(result).toMatchObject({
      sentBack: [id],
      errors: [`task ${id}: GitHub answered 403 rerunning`],
    })
    expect(sentBack[0].note).toContain('could not rerun the failed jobs')
  })

  it('puts the error of the job a required aggregate check depends on in the note', async () => {
    const ci = 'https://github.com/usetheokit/theokit/actions/runs/500/job/1'
    const types = 'https://github.com/usetheokit/theokit/actions/runs/500/job/2'
    repo().required.set('workspace', ['CI'])
    reports(
      { name: 'CI', state: 'failure', detail: '', url: ci },
      { name: 'Type tests', state: 'failure', detail: '', url: types },
    )
    gh.failedRuns = [
      { id: 1, name: 'CI', url: ci, summary: '', actions: true },
      { id: 2, name: 'Type tests', url: types, summary: '', actions: true },
    ]
    gh.logs = {
      1: '2026-11-12T22:00:01.0000000Z ##[error]at least one dependency did not succeed',
      2: [
        '2026-11-12T21:58:01.0000000Z AssertionError: expected 1 to be 2',
        '2026-11-12T21:58:02.0000000Z ##[error]Process completed with exit code 1.',
      ].join('\n'),
    }
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({
      sentBack: [id],
      unreadEvidence: [],
    })

    const { note } = sentBack[0]
    expect(note).toContain(`- CI: ${ci}\n- Type tests: ${types} (not a required check`)
    expect(note).toContain('Type tests:\n~~~~text\nAssertionError: expected 1 to be 2\n~~~~')
  })

  it('puts the annotations and summary of a failed check that is not an Actions job in the note', async () => {
    repo().required.set('workspace', ['CodeQL'])
    reports({ name: 'CodeQL', state: 'failure', detail: '', url: 'https://cq/1' })
    gh.failedRuns = [
      { id: 77, name: 'CodeQL', url: 'https://cq/1', summary: '1 new alert', actions: false },
    ]
    gh.annotations = { 77: ['src/a.ts:3 Sink: tainted input'] }
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ sentBack: [id] })

    expect(sentBack[0].note).toContain('- CodeQL: https://cq/1')
    expect(sentBack[0].note).toContain(
      'CodeQL:\n~~~~text\nsrc/a.ts:3 Sink: tainted input\n1 new alert\n~~~~',
    )
  })

  it('sends the work back with the link when the evidence cannot be read, and logs why', async () => {
    reports({ name: 'CI', state: 'failure', detail: '', url: 'https://ci/1' })
    gh.failedRuns = [{ id: 5, name: 'CI', url: 'https://ci/1', summary: '', actions: true }]
    gh.logFails = true
    const id = await waitingTask()

    const result = await pollAwaitingIntegrations(deps())

    expect(result).toMatchObject({
      sentBack: [id],
      errors: [],
      unreadEvidence: [`task ${id}: CI: GitHub answered 410 reading the log of job 5`],
    })
    expect(sentBack[0].note).toContain(
      '- CI: https://ci/1 (the factory could not read its log or annotations)',
    )
  })

  it('hands to a person the checks that still fail after the automatic runs, and says so on the issue', async () => {
    reports({ name: 'CI', state: 'failure', detail: '', url: 'https://ci/1' })
    const id = await waitingTask({ automaticRuns: 3 })

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ toPerson: [id] })

    expect(sentBack).toEqual([])
    expect(autoMergeOff()).toEqual([12])
    expect(await row(id)).toMatchObject({ stage: 'handoff', awaitingCiSha: null })
    const handoff = (await events(id)).at(-1)!
    expect(handoff).toMatchObject({ stage: 'handoff' })
    expect(handoff.detail).toMatchObject({
      reason: expect.stringMatching(/still fail after 3 automatic runs: CI/),
      pullRequestUrl: PR_URL,
      sha: VERIFIED,
    })
    expect(comments()).toEqual([
      {
        issue: 7,
        body: expect.stringMatching(/still fail after 3 automatic runs: CI[\s\S]*pull\/12/),
      },
    ])
  })

  it('stops auto-merge and hands to a person a pull request someone pushed to', async () => {
    pull({ headSha: 'pushed1234' })
    const id = await waitingTask()

    await pollAwaitingIntegrations(deps())

    expect(autoMergeOff()).toEqual([12])
    expect(await row(id)).toMatchObject({ stage: 'handoff', awaitingCiSha: null, mergedSha: null })
  })

  it('leaves auto-merge alone on a pull request a person closed', async () => {
    pull({ state: 'closed' })
    const id = await waitingTask()

    await pollAwaitingIntegrations(deps())

    expect(autoMergeOff()).toEqual([])
    expect(await row(id)).toMatchObject({ stage: 'handoff' })
  })

  it('starts over a pull request that conflicts with its base', async () => {
    pull({ mergeableState: 'dirty' })
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ startedOver: [id] })

    expect(startedOver).toEqual([id])
  })

  it('tells a person about a required check that never reports', async () => {
    reports()
    const id = await waitingTask({ at: new Date(NOW.getTime() - CI_SILENCE_MS - 60_000) })

    await pollAwaitingIntegrations(deps())

    expect(await row(id)).toMatchObject({ stage: 'handoff' })
    expect(comments()[0].body).toMatch(/CI never reported/)
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
      unreadEvidence: [],
    })
  })

  it('records what stopped one task and goes on with the others', async () => {
    api.fail('readPullRequest', githubAnswered(502, 'reading paulo/app#12'))
    const id = await waitingTask()

    const result = await pollAwaitingIntegrations(deps())

    expect(result.errors).toEqual([expect.stringMatching(new RegExp(`^task ${id}: .*502`))])
    expect(await row(id)).toMatchObject({ stage: 'done', awaitingCiSha: VERIFIED })
  })
})
