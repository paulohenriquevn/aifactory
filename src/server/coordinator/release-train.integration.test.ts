import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import {
  coordinatorAction,
  decision,
  delivery,
  evidence,
  ingress,
  releaseWait,
  repository,
  task,
  watch,
} from '../db/schema'
import { pollAwaitingReleases } from '../factory/await-release'
import { CI_SILENCE_MS } from '../factory/ci-wait'
import { release, ReleaseRefused, type ReleaseMode } from '../factory/deliver'
import { FakeGithub, githubAnswered } from '../../test/fake-github'

import { coordinate, type CoordinatorDeps } from './coordinate'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table coordinator_action, release_wait, publication, watch, delivery, decision, evidence, stage_event, task, ingress, repository restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

const REPO = 'paulo/app'
/** The head of `develop` once the fake repository is prepared. */
const DEVELOP = 'c'.repeat(40)

let api = new FakeGithub()
const repo = () => api.repo(REPO)
beforeEach(() => {
  api = new FakeGithub()
  repo().prepare().ahead('main', 'develop', 1).tags.add('v1.2.3')
})

const deps = (releaseMode: ReleaseMode = 'manual'): CoordinatorDeps => ({
  db: getDb(),
  github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
  api,
  issues: api,
  readIssue: (r, number) => api.readIssue(r, number),
  drafter: async () => ({ response: '', cost: 0 }),
  releaseMode,
  enqueueResume: async () => undefined,
  deleteSnapshot: async () => undefined,
  inTransaction: (work) => getDb().transaction((tx) => work(tx as never, async () => undefined)),
})

async function enable(releaseMode: ReleaseMode | null) {
  await getDb().insert(repository).values({ fullName: REPO, enabled: true, releaseMode })
}

let seeded = 0
/** A task whose work is integrated and has a pre-release and green checks: what a release takes. */
async function integrated(labels: string[] = ['factory'], stage = 'done') {
  const n = ++seeded
  const db = getDb()
  repo().issue(n, { title: `Issue ${n}`, labels })
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `t-${n}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const head = `head${n}`.padEnd(40, '0')
  const [t] = await db
    .insert(task)
    .values({
      ingressId: i.id,
      repository: REPO,
      issueNumber: n,
      issueTitle: `Issue ${n}`,
      stage: stage as never,
      headSha: head,
      mergedSha: stage === 'done' ? `merge${n}`.padEnd(40, '0') : null,
      pullRequestUrl: `https://github.com/${REPO}/pull/${100 + n}`,
    })
    .returning({ id: task.id })
  await db.insert(delivery).values({
    taskId: t.id,
    kind: 'prerelease',
    tag: `pre/${n}-develop`,
    url: `https://github.com/${REPO}/releases/pre-${n}`,
    sha: DEVELOP,
    actor: 'factory',
  })
  await db.insert(evidence).values({
    taskId: t.id,
    name: 'test',
    command: 'npm test',
    sha: head,
    exitCode: 0,
    timedOut: false,
    passed: true,
    output: '',
    durationMs: 1,
  })
  return t.id
}

/** A task finished with no change: done, resolved at a commit of the integration branch, nothing merged. */
async function resolved(sha: string) {
  const n = ++seeded
  repo().issue(n, { title: `Issue ${n}`, labels: ['factory'] })
  const [i] = await getDb()
    .insert(ingress)
    .values({
      deliveryId: `t-${n}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await getDb()
    .insert(task)
    .values({
      ingressId: i.id,
      repository: REPO,
      issueNumber: n,
      issueTitle: `Issue ${n}`,
      stage: 'done',
      resolvedSha: sha,
    })
    .returning({ id: task.id })
  return { id: t.id, issue: n }
}

const actions = () => getDb().select().from(coordinatorAction).orderBy(coordinatorAction.id)
const promotions = () => api.callsTo('openPullRequest').filter(([pull]) => pull.head === 'develop')
const merges = () => api.callsTo('mergePullRequest')
const tags = () => api.callsTo('createRelease').map(([release]) => release.tag)
const stageOf = async (id: number) =>
  (await getDb().select({ stage: task.stage }).from(task).where(eq(task.id, id)))[0].stage

describe('the release train in a repository in auto', () => {
  it('calls nothing while develop holds nothing the release branch lacks, and records nothing', async () => {
    await enable('auto')
    await integrated()
    repo().ahead('main', 'develop', 0)

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 0, refused: 0, failed: 0 })
    expect(promotions()).toEqual([])
    expect(await actions()).toEqual([])
  })

  it('releases integrated work once in one pass and records one applied row on the oldest task', async () => {
    await enable('auto')
    const oldest = await integrated()
    const newer = await integrated(['bug'])

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 1, refused: 0, failed: 0 })
    expect(promotions()).toHaveLength(1)
    expect(merges()).toEqual([[expect.any(Number), DEVELOP, { method: 'merge' }]])
    expect(await actions()).toMatchObject([
      {
        taskId: oldest,
        exceptionKind: 'release_ready',
        headSha: DEVELOP,
        action: 'release',
        outcome: 'applied',
      },
    ])
    expect(await stageOf(oldest)).toBe('released')
    expect(await stageOf(newer)).toBe('released')
  })

  it('records the release as the coordinator, never as a person', async () => {
    await enable('auto')
    const id = await integrated()

    await coordinate(deps(), 'auto')

    const [released] = await getDb().select().from(decision).where(eq(decision.taskId, id))
    expect(released).toMatchObject({ kind: 'release', note: 'agent:coordinator -> v1.2.4' })
  })

  it('calls nothing more on a second pass', async () => {
    await enable('auto')
    await integrated()
    await coordinate(deps(), 'auto')

    const result = await coordinate(deps(), 'auto')

    expect(result).toEqual({
      applied: 0,
      trial: 0,
      refused: 0,
      failed: 0,
      escalated: 0,
      deferred: 0,
    })
    expect(promotions()).toHaveLength(1)
    expect(await actions()).toHaveLength(1)
  })

  it('takes the factory default for a repository with no release mode of its own', async () => {
    await enable(null)
    await integrated()

    await coordinate(deps('auto'), 'auto')

    expect(merges()).toHaveLength(1)
  })

  it('releases nothing while a task of the repository is still working', async () => {
    await enable('auto')
    await integrated()
    await integrated(['factory'], 'build')

    await coordinate(deps(), 'auto')

    expect(promotions()).toEqual([])
    expect(await actions()).toEqual([])
  })
})

describe('the bump the train asks for', () => {
  it('is major when an issue carries the breaking label', async () => {
    await enable('auto')
    await integrated(['bug'])
    await integrated(['enhancement', 'breaking'])

    await coordinate(deps(), 'auto')

    expect(tags()).toEqual(['v2.0.0'])
  })

  it('is minor, never major, for a feature without the breaking label', async () => {
    await enable('auto')
    await integrated(['bug'])
    await integrated(['enhancement'])

    await coordinate(deps(), 'auto')

    expect(tags()).toEqual(['v1.3.0'])
  })

  it('is patch when no issue is a feature', async () => {
    await enable('auto')
    await integrated(['bug'])

    await coordinate(deps(), 'auto')

    expect(tags()).toEqual(['v1.2.4'])
  })
})

describe('the release train outside auto', () => {
  it('never calls release() in a repository in manual mode', async () => {
    await enable('manual')
    await integrated()

    const result = await coordinate(deps('auto'), 'auto')

    expect(result).toEqual({
      applied: 0,
      trial: 0,
      refused: 0,
      failed: 0,
      escalated: 0,
      deferred: 0,
    })
    expect(api.calls).toEqual([])
    expect(await actions()).toEqual([])
  })

  it('never calls release() in a repository in trial mode, and records once what it would do', async () => {
    await enable('trial')
    await integrated()

    await coordinate(deps(), 'auto')
    await coordinate(deps(), 'auto')

    expect(promotions()).toEqual([])
    expect(merges()).toEqual([])
    expect(await actions()).toMatchObject([
      { exceptionKind: 'release_ready', action: 'release', outcome: 'trial' },
    ])
  })

  it('records trial and calls nothing when the coordinator itself is in trial', async () => {
    await enable('auto')
    await integrated()

    await coordinate(deps(), 'trial')

    expect(promotions()).toEqual([])
    expect(await actions()).toMatchObject([{ action: 'release', outcome: 'trial' }])
  })
})

describe('the release train on a red release branch', () => {
  it('records escalated and calls nothing', async () => {
    await enable('auto')
    const id = await integrated()
    await getDb()
      .insert(watch)
      .values({
        taskId: id,
        repository: REPO,
        sha: 'm'.repeat(40),
        pullRequestNumber: 9,
        status: 'red',
        detail: 'the checks of mmmmmmm failed: CI',
      })

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ escalated: 1, applied: 0 })
    expect(promotions()).toEqual([])
    expect(merges()).toEqual([])
    const [row] = await actions()
    expect(row).toMatchObject({
      exceptionKind: 'release_blocked',
      action: 'escalate',
      outcome: 'escalated',
    })
    expect(row.reason).toContain('the checks of mmmmmmm failed: CI')
  })
})

describe('a refused release', () => {
  const headMoved = () =>
    githubAnswered(
      409,
      `merging ${REPO}#1`,
      'Head branch was modified. Review and try the merge again.',
    )

  it('is retried once on the same head when the head moved between the look and the merge', async () => {
    await enable('auto')
    const id = await integrated()
    api.fail('mergePullRequest', headMoved(), { times: 1 })

    await coordinate(deps(), 'auto')
    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 1 })
    expect(merges()).toHaveLength(2)
    expect(await stageOf(id)).toBe('released')
    expect(await actions()).toMatchObject([
      { exceptionKind: 'release_ready', headSha: DEVELOP, outcome: 'refused' },
      { exceptionKind: 'release_retry', headSha: DEVELOP, outcome: 'applied' },
    ])
  })

  it('is not retried a second time on the same head', async () => {
    await enable('auto')
    const id = await integrated()
    api.fail('mergePullRequest', headMoved())

    await coordinate(deps(), 'auto')
    await coordinate(deps(), 'auto')
    await coordinate(deps(), 'auto')

    expect(merges()).toHaveLength(2)
    expect(await stageOf(id)).toBe('done')
    expect(await actions()).toMatchObject([
      { exceptionKind: 'release_ready', outcome: 'refused' },
      { exceptionKind: 'release_retry', outcome: 'refused' },
    ])
  })

  it('is not retried when it was refused for the work itself', async () => {
    await enable('auto')
    await integrated()
    api.fail('mergePullRequest', githubAnswered(405, 'merging', 'Pull Request has merge conflicts'))

    await coordinate(deps(), 'auto')
    await coordinate(deps(), 'auto')

    expect(merges()).toHaveLength(1)
    expect(await actions()).toMatchObject([{ exceptionKind: 'release_ready', outcome: 'refused' }])
  })

  it('is tried again on a new head of the pre-release branch', async () => {
    await enable('auto')
    await integrated()
    api.fail('mergePullRequest', headMoved())
    await coordinate(deps(), 'auto')
    await coordinate(deps(), 'auto')

    repo().log('develop', ['d'.repeat(40)])
    await coordinate(deps(), 'auto')

    expect(merges()).toHaveLength(3)
    expect((await actions()).at(-1)).toMatchObject({
      exceptionKind: 'release_ready',
      headSha: 'd'.repeat(40),
    })
  })
})

describe('a release that waited for the release branch checks and was refused', () => {
  /** The `integrate-after-ci` pass, run after the checks had all the time they get to report. */
  const pollLate = () =>
    pollAwaitingReleases({
      db: getDb(),
      github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
      api,
      now: () => new Date(Date.now() + CI_SILENCE_MS + 60_000),
    })
  const waits = () => getDb().select().from(releaseWait).orderBy(releaseWait.id)

  it('is retried once on the same head when the checks never reported, and a second refusal is not', async () => {
    await enable('auto')
    await integrated()
    repo().required.set('main', ['CI'])

    await coordinate(deps(), 'auto')
    await pollLate()
    await coordinate(deps(), 'auto')
    await pollLate()
    await coordinate(deps(), 'auto')

    expect(api.callsTo('enableAutoMerge')).toHaveLength(2)
    expect((await waits()).map((w) => [w.status, w.sha, w.actor])).toEqual([
      ['refused', DEVELOP, 'agent:coordinator'],
      ['refused', DEVELOP, 'agent:coordinator'],
    ])
    expect((await waits())[0].detail).toContain('never reported')
    expect(await actions()).toMatchObject([
      { exceptionKind: 'release_ready', outcome: 'applied' },
      { exceptionKind: 'release_retry', outcome: 'applied' },
    ])
  })
})

describe('the release train with work resolved elsewhere', () => {
  it('releases a repository with only resolved tasks, ships the anchor and closes its issue', async () => {
    await enable('auto')
    const { id, issue } = await resolved('resolved01')

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 1, refused: 0, failed: 0 })
    expect(merges()).toHaveLength(1)
    expect(await stageOf(id)).toBe('released')
    expect(repo().issues.get(issue)?.state).toBe('closed')
    expect(await actions()).toMatchObject([{ taskId: id, exceptionKind: 'release_ready' }])
  })

  it('leaves a resolved task alone while develop lacks its commit, and records nothing', async () => {
    await enable('auto')
    const { id, issue } = await resolved('outside01')
    repo().unreachable.add('outside01')

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 0, refused: 0, failed: 0 })
    expect(promotions()).toEqual([])
    expect(await stageOf(id)).toBe('done')
    expect(repo().issues.get(issue)?.state).toBe('open')
    expect(await actions()).toEqual([])
  })

  it('anchors on integrated work and ships a contained resolved task with it, not an absent one', async () => {
    await enable('auto')
    const absent = await resolved('outside01')
    const inside = await resolved('inside01')
    const anchor = await integrated()
    repo().unreachable.add('outside01')

    await coordinate(deps(), 'auto')

    expect(await actions()).toMatchObject([{ taskId: anchor, outcome: 'applied' }])
    expect(await stageOf(anchor)).toBe('released')
    expect(await stageOf(inside.id)).toBe('released')
    expect(await stageOf(absent.id)).toBe('done')
  })

  it('refuses a release whose pull request head lacks the resolved commit though develop holds it, and merges nothing', async () => {
    const { id, issue } = await resolved('resolved01')
    // The branch holds the commit when the pull request is opened, the head that would be merged does not.
    repo().holds('develop', ['resolved01'])
    repo().holds(DEVELOP, [])

    await expect(
      release({ db: getDb(), github: deps().github, api }, id, {
        bump: 'patch',
        actor: 'agent:coordinator',
      }),
    ).rejects.toThrow(ReleaseRefused)

    expect(merges()).toEqual([])
    expect(api.callsTo('enableAutoMerge')).toEqual([])
    expect(await stageOf(id)).toBe('done')
    expect(repo().issues.get(issue)?.state).toBe('open')
  })
})
