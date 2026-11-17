import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, promotionWait, repository, review, stageEvent, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import { FakeGithub } from '../../test/fake-github'

import { pollAwaitingIntegrations, type AwaitCiDeps } from './await-ci'
import { advancePreRelease } from './integration'
import { PROMOTION_HOLD_MS } from './promotion-hold'
import { adoptPromotions, pollPromotionWaits } from './promotion-merge'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
afterAll(() => getStorageManager().dispose())

const REPO = 'paulo/app'
const NOW = new Date('2026-11-16T12:00:00Z')
/** Where workspace is once the integration merged: the head the factory sees on the promotion. */
const INTEGRATED = 'e'.repeat(40)
const MOVED = 'f'.repeat(40)
const DEVELOP = 'c'.repeat(40)

let api = new FakeGithub()
const repo = () => api.repo(REPO)
const github = {
  installationToken: async () => ({ token: 't', expiresAt: new Date() }),
} as unknown as GithubApp

const pinned = () => api.answered('enableAutoMerge').map(([number, sha]) => ({ number, sha }))
const merges = () =>
  api.answered('mergePullRequest').map(([number, sha, how]) => ({ number, sha, how }))
const waits = () => getDb().select().from(promotionWait).orderBy(promotionWait.id)

beforeEach(async () => {
  await getPool().query(
    'truncate table promotion_wait, delivery, decision, review, evidence, stage_event, task, ingress, repository restart identity cascade',
  )
  api = new FakeGithub()
  repo().prepare()
  repo().heads.set('workspace', INTEGRATED)
  repo().restricted.add('develop')
  repo().required.set('develop', ['CI'])
  repo().nextNumber = 13
})

const advance = (at = NOW) =>
  advancePreRelease(
    { api, db: getDb(), now: () => at },
    { repository: REPO, token: 't', integration: 'workspace', mergedSha: INTEGRATED },
  )

describe('advancePreRelease into a develop that takes only pull requests', () => {
  it('records a wait pinned to the head it saw, with a hold of PROMOTION_HOLD_MS', async () => {
    const advanced = await advance()

    expect(advanced).toMatchObject({ developAutoMerge: INTEGRATED })
    expect(pinned()).toEqual([{ number: 13, sha: INTEGRATED }])
    const [wait] = await waits()
    expect(wait).toMatchObject({ sha: INTEGRATED, status: 'waiting' })
    expect(wait.holdUntil).toEqual(new Date(NOW.getTime() + PROMOTION_HOLD_MS))
  })

  it('merges nothing when the head moved after the factory looked, and records the head it saw', async () => {
    api.before(
      'enableAutoMerge',
      (_call, on) => {
        on.heads.set('workspace', MOVED)
      },
      { once: true },
    )

    const advanced = await advance()

    expect(advanced.developAutoMergeError).toContain('expected head')
    expect(pinned()).toEqual([])
    expect(merges()).toEqual([])
    expect(repo().heads.get('develop')).toBe(DEVELOP)
    const [wait] = await waits()
    expect(wait).toMatchObject({ sha: INTEGRATED, status: 'waiting' })
  })

  it('pins the new head on the next pass after the head moved', async () => {
    api.before(
      'enableAutoMerge',
      (_call, on) => {
        on.heads.set('workspace', MOVED)
      },
      { once: true },
    )
    await advance()

    const pass = await pollPromotionWaits({ db: getDb(), api, github })

    expect(pass.repinned).toEqual([REPO])
    expect(pinned()).toEqual([{ number: 13, sha: MOVED }])
    const [wait] = await waits()
    expect(wait).toMatchObject({ sha: MOVED, status: 'waiting', detail: null })
  })

  it('records no wait and holds nothing when GitHub refuses auto-merge on the head it saw', async () => {
    repo().allowAutoMerge = false

    const advanced = await advance()

    expect(advanced.developAutoMergeError).toContain('not allowed')
    expect(await waits()).toEqual([])
  })

  it('merges a promotion GitHub finds clean at once, with a merge commit pinned to the same head', async () => {
    repo().required.delete('develop')

    const advanced = await advance()

    expect(merges()).toEqual([{ number: 13, sha: INTEGRATED, how: { method: 'merge' } }])
    expect(advanced.developSha).toBe(repo().heads.get('develop'))
    expect(await waits()).toEqual([])
  })

  it('keeps the hold that runs when a later integration pins a new head', async () => {
    await advance()
    repo().heads.set('workspace', MOVED)

    await advancePreRelease(
      { api, db: getDb(), now: () => new Date(NOW.getTime() + 60_000) },
      { repository: REPO, token: 't', integration: 'workspace', mergedSha: MOVED },
    )

    const all = await waits()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ sha: MOVED })
    expect(all[0].holdUntil).toEqual(new Date(NOW.getTime() + PROMOTION_HOLD_MS))
  })
})

describe('pollPromotionWaits', () => {
  it('ends the wait, and with it the hold, once GitHub merged the promotion', async () => {
    await advance()
    repo().mergePull(repo().pull(13)!, { method: 'merge' })

    const pass = await pollPromotionWaits({ db: getDb(), api, github })

    expect(pass.merged).toEqual([REPO])
    expect((await waits())[0]).toMatchObject({ status: 'merged' })
  })

  it('ends the wait when a person closed the promotion', async () => {
    await advance()
    repo().pull(13)!.state = 'closed'

    const pass = await pollPromotionWaits({ db: getDb(), api, github })

    expect(pass.closed).toEqual([REPO])
    expect((await waits())[0]).toMatchObject({ status: 'closed' })
  })

  it('changes nothing while the pinned head waits for its checks', async () => {
    await advance()

    const pass = await pollPromotionWaits({ db: getDb(), api, github })

    expect(pass.waiting).toBe(1)
    expect(pinned()).toHaveLength(1)
  })
})

describe('adoptPromotions', () => {
  /** A repository with integrated work, whose promotion was opened before promotions were pinned. */
  async function integratedWork(stage: 'done' | 'released' = 'done') {
    const db = getDb()
    await db.insert(repository).values({ fullName: REPO, enabled: true })
    const [i] = await db
      .insert(ingress)
      .values({
        deliveryId: 'd-adopt',
        event: 'issues',
        payload: {},
        outcome: 'task_created',
        code: 'issue_labeled',
        reason: 'r',
      })
      .returning({ id: ingress.id })
    await db.insert(task).values({
      ingressId: i.id,
      repository: REPO,
      issueNumber: 7,
      issueTitle: 'Add truncate',
      stage,
      headSha: INTEGRATED,
      mergedSha: INTEGRATED,
    })
  }
  const unpinnedPromotion = () =>
    api.openPullRequest(REPO, 't', {
      head: 'workspace',
      base: 'develop',
      title: 'Promote',
      body: '',
    })
  const adopt = () => adoptPromotions({ db: getDb(), github, api, now: () => NOW })

  it('pins a promotion nothing waits on, for a repository with integrated work, and records its wait', async () => {
    await integratedWork()
    await unpinnedPromotion()
    api.calls.length = 0

    expect(await adopt()).toEqual({ adopted: [REPO], errors: [] })
    expect(pinned()).toEqual([{ number: 13, sha: INTEGRATED }])
    expect(await waits()).toMatchObject([{ repository: REPO, sha: INTEGRATED, status: 'waiting' }])
  })

  it('merges at once a promotion GitHub finds clean, pinned to its head', async () => {
    await integratedWork()
    await unpinnedPromotion()
    repo().required.delete('develop')

    expect(await adopt()).toEqual({ adopted: [REPO], errors: [] })
    expect(merges()).toEqual([{ number: 13, sha: INTEGRATED, how: { method: 'merge' } }])
  })

  it('leaves alone a repository whose promotion already waits', async () => {
    await integratedWork()
    await unpinnedPromotion()
    await adopt()
    api.calls.length = 0

    expect(await adopt()).toEqual({ adopted: [], errors: [] })
    expect(pinned()).toEqual([])
  })

  it('pins nothing for a repository with no integrated work waiting for a release', async () => {
    await integratedWork('released')
    await unpinnedPromotion()

    expect(await adopt()).toEqual({ adopted: [], errors: [] })
    expect(pinned()).toEqual([])
  })

  it('pins nothing when no promotion is open, and says nothing', async () => {
    await integratedWork()

    expect(await adopt()).toEqual({ adopted: [], errors: [] })
    expect(pinned()).toEqual([])
  })
})

describe('an integration a promotion held out', () => {
  const VERIFIED = 'abc1234def'
  const TASK_PR = 'https://github.com/paulo/app/pull/12'

  async function heldTask() {
    const db = getDb()
    const [i] = await db
      .insert(ingress)
      .values({
        deliveryId: 'd-1',
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
        repository: REPO,
        issueNumber: 7,
        issueTitle: 'Add truncate',
        stage: 'done',
        headSha: VERIFIED,
        pullRequestUrl: TASK_PR,
        awaitingCiSha: VERIFIED,
        integrationHeld: true,
      })
      .returning({ id: task.id })
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
      at: new Date(NOW.getTime() - 60_000),
      detail: { sha: VERIFIED, pullRequestUrl: TASK_PR, attempts: 1, agentSummary: 'added' },
    })
    repo().pullRequest({
      number: 12,
      url: TASK_PR,
      headRef: 'factory/7',
      baseRef: 'workspace',
      headSha: VERIFIED,
    })
    // The promotion that holds it, pinned to where workspace is.
    repo().pullRequest({ number: 13, headRef: 'workspace', baseRef: 'develop' })
    await db.insert(promotionWait).values({
      repository: REPO,
      pullRequestNumber: 13,
      pullRequestUrl: 'https://github.com/paulo/app/pull/13',
      sha: INTEGRATED,
      holdUntil: new Date(NOW.getTime() + 10 * 60_000),
    })
    return t.id
  }

  const deps = (at: Date): AwaitCiDeps => ({
    db: getDb(),
    github,
    api,
    checks: {
      failedChecks: async () => [],
      jobLog: async () => '',
      annotations: async () => [],
      jobAttempt: async () => ({ runId: 1, attempt: 1 }),
    },
    releaseMode: undefined,
    now: () => at,
    sendBack: async () => {},
    startOver: async () => {},
    mergeBase: async () => {},
  })
  const row = async (id: number) => (await getDb().select().from(task).where(eq(task.id, id)))[0]

  it('stays out of workspace while the hold runs', async () => {
    const id = await heldTask()

    const pass = await pollAwaitingIntegrations(deps(new Date(NOW.getTime() + 60_000)))

    expect(pass.waiting).toBe(1)
    expect(merges()).toEqual([])
    expect(await row(id)).toMatchObject({ awaitingCiSha: VERIFIED, integrationHeld: true })
  })

  it('is integrated on the next pass past the hold, and its promotion pinned to the new head', async () => {
    const id = await heldTask()

    const pass = await pollAwaitingIntegrations(deps(new Date(NOW.getTime() + 11 * 60_000)))

    expect(pass.merged).toEqual([id])
    expect(merges()).toEqual([
      { number: 12, sha: VERIFIED, how: { method: 'squash', title: 'Add truncate (#7)' } },
    ])
    const integrated = repo().heads.get('workspace')
    expect(pinned()).toEqual([{ number: 13, sha: integrated }])
    expect(await row(id)).toMatchObject({
      awaitingCiSha: null,
      integrationHeld: false,
      mergedSha: integrated,
    })
  })

  it('waits for the required checks of workspace when it requires them, past the hold', async () => {
    repo().required.set('workspace', ['CI'])
    const id = await heldTask()

    const pass = await pollAwaitingIntegrations(deps(new Date(NOW.getTime() + 11 * 60_000)))

    expect(pass.merged).toEqual([])
    expect(pinned()).toEqual([{ number: 12, sha: VERIFIED }])
    expect(await row(id)).toMatchObject({ awaitingCiSha: VERIFIED, integrationHeld: false })
  })
})
