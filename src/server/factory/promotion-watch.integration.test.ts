import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { promotionFinding, repository } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { NewIssue } from '../github/issues-api'
import type { FailedRun, PromotionApi } from '../github/promotion-api'

import { pollPromotions, type PromotionWatchDeps } from './promotion-watch'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
afterAll(() => getStorageManager().dispose())

const LOG = [
  '2026-11-11T17:30:19.5Z Unused devDependencies (1)',
  '2026-11-11T17:30:19.5Z onnxruntime-node  packages/sdk/package.json:455:6',
  '2026-11-11T17:30:19.5Z ##[error]Process completed with exit code 1.',
].join('\n')

type World = {
  head: string
  runs: FailedRun[]
  attempts: Record<number, number>
  logs: Record<number, string>
  issueOpen: boolean
  /** Set when GitHub refuses to rerun a run: the refusal it answers with. */
  rerunRefusal?: string
}
let world: World
let created: (NewIssue & { repo: string })[]
let comments: { number: number; body: string }[]
let reruns: number[]

const actionsRun = (id: number, name: string): FailedRun => ({
  id,
  name,
  url: `https://github.com/paulo/app/actions/runs/9/job/${id}`,
  summary: '',
  actions: true,
})

beforeEach(async () => {
  await getPool().query('truncate table promotion_finding, repository restart identity cascade')
  await getDb().insert(repository).values({ fullName: 'paulo/app', enabled: true })
  world = {
    head: 'sha0001aaaa',
    runs: [actionsRun(1, 'validate')],
    attempts: { 1: 2 },
    logs: { 1: LOG },
    issueOpen: true,
  }
  created = []
  comments = []
  reruns = []
})

const api: PromotionApi = {
  openPullRequest: async (_repo, _token, head, base) =>
    head === 'workspace' && base === 'develop'
      ? { number: 979, url: 'https://github.com/paulo/app/pull/979', headSha: world.head }
      : undefined,
  failedChecks: async () => world.runs,
  jobAttempt: async (_repo, _token, jobId) => ({ runId: 9, attempt: world.attempts[jobId] ?? 1 }),
  jobLog: async (_repo, _token, jobId) => world.logs[jobId] ?? '',
  annotations: async () => ['apps/a.ts:118 Server-side request forgery: depends on user input.'],
  rerunFailedJobs: async (_repo, _token, runId) => {
    reruns.push(runId)
    return world.rerunRefusal === undefined
      ? { started: true }
      : { started: false, refusal: world.rerunRefusal }
  },
  issueOpen: async () => world.issueOpen,
}

const app: GithubApp = { installationToken: async () => ({ token: 't', expiresAt: new Date() }) }

function deps(overrides: Partial<PromotionWatchDeps> = {}): PromotionWatchDeps {
  return {
    db: getDb(),
    app,
    api,
    github: {
      defaultBranch: async () => 'main',
      commentOnIssue: async (_repo, _token, number, body) => {
        comments.push({ number, body })
        return 'https://github.com/paulo/app/issues/50#c'
      },
    },
    issues: {
      ensureLabel: async () => {},
      createIssue: async (repo, _token, issue) => {
        created.push({ repo, ...issue })
        return {
          number: 50 + created.length,
          url: `https://github.com/${repo}/issues/${50 + created.length}`,
        }
      },
    },
    maxNewIssuesPerRepository: 3,
    ...overrides,
  }
}

describe('the promotion watch', () => {
  it('reruns a job that failed on its first attempt, and files nothing yet', async () => {
    world.attempts = { 1: 1 }
    const result = await pollPromotions(deps())
    expect(reruns).toEqual([9])
    expect(created).toEqual([])
    expect(result.reruns).toBe(1)
  })

  describe('when GitHub refuses to rerun a job that failed on its first attempt', () => {
    const REFUSAL =
      'GitHub answered 403 rerunning the failed jobs of run 9 on paulo/app: {"message":"Resource not accessible by integration"}'

    beforeEach(() => {
      world.attempts = { 1: 1 }
      world.rerunRefusal = REFUSAL
    })

    it('files the failure from the first attempt in the same pass', async () => {
      const result = await pollPromotions(deps())
      expect(created).toHaveLength(1)
      expect(created[0].body).toContain('onnxruntime-node  packages/sdk/package.json:455:6')
      expect(result.opened).toEqual(['https://github.com/paulo/app/issues/51'])
    })

    it('says in the issue that the job could not be rerun', async () => {
      await pollPromotions(deps())
      expect(created[0].body).toContain('could not be rerun')
      expect(created[0].body).not.toContain('after a rerun')
    })

    it('keeps the refusal in the errors and counts no rerun', async () => {
      const result = await pollPromotions(deps())
      expect(result.errors).toEqual([`paulo/app: ${REFUSAL}`])
      expect(result.reruns).toBe(0)
    })

    it('asks once per run and files every refused job of it', async () => {
      world.runs = [actionsRun(1, 'validate'), actionsRun(2, 'unit')]
      world.attempts = { 1: 1, 2: 1 }
      world.logs = { 1: LOG, 2: 'AssertionError: two' }
      const result = await pollPromotions(deps())
      expect(reruns).toEqual([9])
      expect(created).toHaveLength(2)
      expect(result.errors).toHaveLength(1)
    })
  })

  it('keeps failing the pass when the rerun fails for a reason other than a refusal', async () => {
    world.attempts = { 1: 1 }
    const failing = deps({
      api: {
        ...api,
        rerunFailedJobs: async () => {
          throw new Error('GitHub answered 502 rerunning the failed jobs of run 9 on paulo/app')
        },
      },
    })
    const result = await pollPromotions(failing)
    expect(result.errors).toEqual([
      'paulo/app: GitHub answered 502 rerunning the failed jobs of run 9 on paulo/app',
    ])
    expect(created).toEqual([])
  })

  it('reruns a run once, even when several of its jobs failed', async () => {
    world.runs = [actionsRun(1, 'validate'), actionsRun(2, 'unit')]
    world.attempts = { 1: 1, 2: 1 }
    await pollPromotions(deps())
    expect(reruns).toEqual([9])
  })

  it('files an issue for the factory when the job failed again after the rerun', async () => {
    const result = await pollPromotions(deps())
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ repo: 'paulo/app', labels: ['factory'] })
    expect(created[0].title).toBe('promotion: `validate` fails on workspace -> develop')
    expect(created[0].body).toContain('https://github.com/paulo/app/actions/runs/9/job/1')
    expect(created[0].body).toContain('onnxruntime-node  packages/sdk/package.json:455:6')
    expect(result.opened).toEqual(['https://github.com/paulo/app/issues/51'])
    const [row] = await getDb().select().from(promotionFinding)
    expect(row).toMatchObject({ issueNumber: 51, lastSha: 'sha0001aaaa', forFactory: true })
  })

  it('says nothing more on a second pass over the same commit', async () => {
    await pollPromotions(deps())
    const second = await pollPromotions(deps())
    expect(created).toHaveLength(1)
    expect(comments).toEqual([])
    expect(second.opened).toEqual([])
  })

  it('comments on the open issue when the same failure is back on a new commit', async () => {
    await pollPromotions(deps())
    world.head = 'sha0002bbbb'
    const result = await pollPromotions(deps())
    expect(created).toHaveLength(1)
    expect(comments).toHaveLength(1)
    expect(comments[0].number).toBe(51)
    expect(comments[0].body).toContain('`sha0002`')
    expect(result.commented).toEqual(['paulo/app#51'])
  })

  it('opens a new issue when the issue for the same failure was closed', async () => {
    await pollPromotions(deps())
    world.head = 'sha0002bbbb'
    world.issueOpen = false
    await pollPromotions(deps())
    expect(created).toHaveLength(2)
    const [row] = await getDb().select().from(promotionFinding)
    expect(row).toMatchObject({ issueNumber: 52, lastSha: 'sha0002bbbb' })
  })

  it('leaves a secret scanner to a person: an issue without the factory label', async () => {
    world.runs = [actionsRun(1, 'trufflehog / TruffleHog')]
    world.logs = { 1: '##[warning]Found unverified Postgres result' }
    await pollPromotions(deps())
    expect(created).toHaveLength(1)
    expect(created[0].labels).toEqual([])
    const [row] = await getDb().select().from(promotionFinding)
    expect(row.forFactory).toBe(false)
  })

  it('reads the annotations of a check that is not an Actions job, without rerunning it', async () => {
    world.runs = [
      {
        id: 7,
        name: 'CodeQL',
        url: 'https://github.com/paulo/app/runs/7',
        summary: '1 new alert',
        actions: false,
      },
    ]
    await pollPromotions(deps())
    expect(reruns).toEqual([])
    expect(created[0].body).toContain('apps/a.ts:118 Server-side request forgery')
    expect(created[0].body).toContain('was not rerun')
  })

  it('opens no more new issues in a pass than the cap allows', async () => {
    world.runs = [actionsRun(1, 'validate'), actionsRun(2, 'unit')]
    world.attempts = { 1: 2, 2: 2 }
    world.logs = { 1: LOG, 2: 'AssertionError: two' }
    const result = await pollPromotions(deps({ maxNewIssuesPerRepository: 1 }))
    expect(created).toHaveLength(1)
    expect(result.capped).toBe(1)
    await pollPromotions(deps({ maxNewIssuesPerRepository: 1 }))
    expect(created).toHaveLength(2)
  })

  it('watches only the repositories the owner enabled', async () => {
    await getPool().query('update repository set enabled = false')
    await pollPromotions(deps())
    expect(created).toEqual([])
  })

  it('takes the issue back when GitHub refuses to open it, so the next pass tries again', async () => {
    const refusing = deps({
      issues: {
        ensureLabel: async () => {},
        createIssue: async () => {
          throw new Error('GitHub answered 410 creating an issue on paulo/app: issues are disabled')
        },
      },
    })
    const result = await pollPromotions(refusing)
    expect(result.errors).toEqual([
      'paulo/app: GitHub answered 410 creating an issue on paulo/app: issues are disabled',
    ])
    expect(await getDb().select().from(promotionFinding)).toEqual([])
    await pollPromotions(deps())
    expect(created).toHaveLength(1)
  })
})
