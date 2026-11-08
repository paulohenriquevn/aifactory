import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import {
  agentEvent,
  agentRun,
  decision,
  delivery,
  finding,
  evidence,
  ingress,
  question,
  review,
  stageEvent,
  task,
  watch,
} from '../db/schema'
import type { GithubApi } from '../github/pulls'
import { COLUMNS } from '../../shared/panel'

import {
  ActionRefused,
  approve,
  acknowledgeWatch,
  resolveFinding,
  type FindingAction,
  releaseTask,
  requestChanges,
  retry,
  type ActionDeps,
} from './actions'
import { health, inbox, listTasks, taskDetail } from './queries'
import { retryWaiting, runDueRetries } from './retry-waiting'
import { stageStream } from './stream'
import { eventsOf, pruneTranscripts } from '../factory/transcript-store'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table agent_event, finding, agent_run, watch, delivery, decision, question, review, evidence, stage_event, task, ingress restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

let seeded = 0
async function seed(
  stage: string,
  fields: Partial<typeof task.$inferInsert> = {},
  events: { stage: string; detail?: object }[] = [],
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
      issueNumber: seeded,
      issueTitle: `Issue ${seeded}`,
      stage: stage as never,
      ...fields,
    })
    .returning({ id: task.id })
  for (const e of events) {
    await db
      .insert(stageEvent)
      .values({ taskId: t.id, stage: e.stage as never, detail: e.detail ?? null })
  }
  return t.id
}

describe('listTasks', () => {
  it('builds a card per task with its column, attempts, cost and last activity', async () => {
    const id = await seed(
      'done',
      { headSha: 'abc', pullRequestUrl: 'https://github.com/paulo/app/pull/1', costUsd: 0.21 },
      [{ stage: 'verify' }, { stage: 'review' }, { stage: 'verify' }, { stage: 'done' }],
    )
    await seed('failed')

    const cards = await listTasks(getDb())

    const card = cards.find((c) => c.id === id)!
    expect(card).toMatchObject({
      stage: 'done',
      column: 'review',
      attempts: 2,
      costUsd: 0.21,
      pullRequestUrl: 'https://github.com/paulo/app/pull/1',
      approved: false,
      integrated: false,
      resolved: false,
      retryable: null,
    })
    expect(cards.find((c) => c.id !== id)?.column).toBe('attention')
    expect(new Set(cards.map((c) => c.column))).toEqual(new Set(['review', 'attention']))
  })

  it('counts the attempts of the current run, not the ones a retry started over', async () => {
    const id = await seed('verify', {}, [
      { stage: 'intake' },
      { stage: 'verify' },
      { stage: 'verify' },
      { stage: 'verify' },
      { stage: 'failed' },
      { stage: 'intake', detail: { decision: 'retry' } },
      { stage: 'verify' },
    ])

    const [card] = await listTasks(getDb())

    expect(card.id).toBe(id)
    expect(card.attempts).toBe(1)
  })

  it('puts every stage in a column that exists on the board', async () => {
    for (const stage of [
      'intake',
      'sandbox',
      'build',
      'push',
      'verify',
      'review',
      'pr',
      'waiting',
      'done',
      'handoff',
      'failed',
    ]) {
      await seed(stage)
    }
    const cards = await listTasks(getDb())
    const known = new Set(COLUMNS.map((c) => c.id))
    expect(cards).toHaveLength(11)
    for (const card of cards) expect(known.has(card.column), card.stage).toBe(true)
  })

  it('shows an approval only for the commit the person approved', async () => {
    const id = await seed('done', { headSha: 'sha-1' })
    await getDb().insert(decision).values({ taskId: id, kind: 'approve', sha: 'sha-1' })
    expect((await listTasks(getDb()))[0].approved).toBe(true)

    await getDb().update(task).set({ headSha: 'sha-2' }).where(eq(task.id, id))
    expect((await listTasks(getDb()))[0].approved).toBe(false)
  })

  it('puts a failure that passes by itself in its own column, by what the last failure said', async () => {
    const quota = await seed('failed', {}, [{ stage: 'failed', detail: { quota: true } }])
    const network = await seed('failed', {}, [
      { stage: 'failed', detail: { error: 'git push: remote rejected' } },
    ])
    const work = await seed('failed', {}, [
      { stage: 'failed', detail: { error: 'the agent made no change' } },
    ])
    const healed = await seed('failed', {}, [
      { stage: 'failed', detail: { quota: true } },
      { stage: 'failed', detail: { error: 'the agent made no change' } },
    ])
    const running = await seed('build', {}, [{ stage: 'failed', detail: { quota: true } }])

    const cards = new Map((await listTasks(getDb())).map((c) => [c.id, c]))

    expect(cards.get(quota)).toMatchObject({ column: 'retrying', retryable: 'quota' })
    expect(cards.get(network)).toMatchObject({ column: 'retrying', retryable: 'environment' })
    expect(cards.get(work)).toMatchObject({ column: 'attention', retryable: null })
    expect(cards.get(healed)).toMatchObject({ column: 'attention', retryable: null })
    expect(cards.get(running)).toMatchObject({ column: 'working', retryable: null })
  })
})

describe('listTasks and the retries the factory makes on its own', () => {
  const environment = { stage: 'failed', detail: { error: 'git push: remote rejected' } }
  const automatic = { stage: 'intake', detail: { decision: 'retry', automatic: true } }

  it('says when a failure that passes by itself runs again', async () => {
    const id = await seed('failed', {}, [
      {
        stage: 'failed',
        detail: { quota: true, resetsAt: '3:39 AM', resumesAt: '2026-11-06T03:39:00.000Z' },
      },
    ])

    const [card] = await listTasks(getDb())

    expect(card).toMatchObject({ id, column: 'retrying', retryAt: '2026-11-06T03:40:00.000Z' })
  })

  it('hands an environment failure to a person once every automatic retry failed too', async () => {
    const id = await seed('failed', {}, [
      environment,
      automatic,
      environment,
      automatic,
      environment,
      automatic,
      environment,
    ])

    const [card] = await listTasks(getDb())

    expect(card).toMatchObject({ id, column: 'attention', retryable: null, retryAt: null })
  })

  it('counts the automatic retries again from zero after a person starts the task', async () => {
    await seed('failed', {}, [
      environment,
      automatic,
      environment,
      automatic,
      environment,
      automatic,
      environment,
      { stage: 'intake', detail: { decision: 'retry' } },
      environment,
    ])

    const [card] = await listTasks(getDb())

    expect(card).toMatchObject({ column: 'retrying', retryable: 'environment' })
  })
})

describe('taskDetail', () => {
  it('returns the timeline, the evidence, the reviews, the questions and the decisions', async () => {
    const id = await seed('done', { headSha: 'abc' }, [
      { stage: 'sandbox' },
      { stage: 'build', detail: { harness: 'claude-code' } },
      { stage: 'done', detail: { costUsd: 0.1 } },
    ])
    await getDb().insert(evidence).values({
      taskId: id,
      name: 'test',
      command: 'npm test',
      sha: 'abc',
      exitCode: 0,
      timedOut: false,
      passed: true,
      output: 'ok',
      durationMs: 1200,
    })
    await getDb()
      .insert(review)
      .values({
        taskId: id,
        round: 1,
        sha: 'abc',
        reviewer: 'claude-code',
        verdict: 'approve',
        summary: 'fine',
        findings: [{ severity: 'minor', issue: 'nit' }],
      })
    await getDb().insert(question).values({
      taskId: id,
      body: 'A or B?',
      commentId: '1',
      snapshotId: 's',
      sessionId: 'x',
      harness: 'h',
      repoDir: '/r',
      baseSha: 'b',
      attempt: 1,
      costUsd: 0,
      answer: 'B',
      answeredBy: 'paulo',
    })
    await getDb().insert(decision).values({ taskId: id, kind: 'approve', sha: 'abc' })

    const detail = (await taskDetail(getDb(), id))!

    expect(detail.timeline.map((e) => e.stage)).toEqual(['sandbox', 'build', 'done'])
    expect(detail.timeline[1].detail).toEqual({ harness: 'claude-code' })
    expect(detail.evidence).toMatchObject([{ name: 'test', passed: true, durationMs: 1200 }])
    expect(detail.reviews).toMatchObject([{ verdict: 'approve', findings: [{ issue: 'nit' }] }])
    expect(detail.questions).toMatchObject([{ body: 'A or B?', answer: 'B', answeredBy: 'paulo' }])
    expect(detail.decisions).toMatchObject([{ kind: 'approve', sha: 'abc' }])
    expect(detail.task.approved).toBe(true)
  })

  it('is nothing for a task that does not exist', async () => {
    expect(await taskDetail(getDb(), 999)).toBeUndefined()
  })
})

describe('inbox', () => {
  it('lists what waits for a person, with why, oldest first, and leaves the rest out', async () => {
    await seed('build', {}, [{ stage: 'build' }])
    const failed = await seed('failed', {}, [
      { stage: 'failed', detail: { error: 'the codex quota ran out', quota: true } },
    ])
    await new Promise((r) => setTimeout(r, 5))
    const asking = await seed('waiting', {}, [
      { stage: 'waiting', detail: { question: 'A or B?' } },
    ])
    await new Promise((r) => setTimeout(r, 5))
    const handed = await seed('handoff', {}, [
      { stage: 'handoff', detail: { reason: 'three attempts' } },
    ])
    await new Promise((r) => setTimeout(r, 5))
    const ready = await seed('done', { headSha: 'abc' }, [{ stage: 'done' }])
    const approved = await seed('done', { headSha: 'def' }, [{ stage: 'done' }])
    await getDb().insert(decision).values({ taskId: approved, kind: 'approve', sha: 'def' })

    const items = await inbox(getDb())

    expect(items.map((i) => [i.task.id, i.kind])).toEqual([
      [failed, 'failed'],
      [asking, 'question'],
      [handed, 'handoff'],
      [ready, 'review'],
    ])
    expect(items[0].summary).toBe('Out of quota. the codex quota ran out')
    expect(items[1].summary).toBe('A or B?')
  })

  it('leaves out an issue delivered as already resolved, which has no pull request to review', async () => {
    const resolved = await seed('done', { headSha: 'abc', resolvedSha: 'abc' }, [
      { stage: 'done', detail: { resolved: true, sha: 'abc' } },
    ])

    expect(await inbox(getDb())).toEqual([])
    const [card] = await listTasks(getDb())
    expect(card).toMatchObject({ id: resolved, column: 'review', resolved: true })
  })
})

describe('actions', () => {
  const queued: { input: object; key: string }[] = []
  const resumed: { input: object; key: string }[] = []
  const snapshotsDeleted: string[] = []
  const deleted: string[] = []
  const api = {
    deleteBranch: async (_repo: string, _token: string, branch: string) =>
      void deleted.push(branch),
  } as unknown as GithubApi
  const deps = (): ActionDeps => ({
    db: getDb(),
    github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
    api,
    enqueueResume: async (input, key) => void resumed.push({ input, key }),
    deleteSnapshot: async (id) => void snapshotsDeleted.push(id),
    inTransaction: (work) =>
      getDb().transaction((tx) =>
        work(tx as never, async (input, key) => void queued.push({ input, key })),
      ),
  })
  beforeEach(() => {
    queued.length = 0
    deleted.length = 0
    resumed.length = 0
    snapshotsDeleted.length = 0
  })

  it('approves the commit the pull request is at, and only a task that has one', async () => {
    const id = await seed('done', { headSha: 'abc' })
    expect(await approve(deps(), id)).toMatchObject({ sha: 'abc' })
    expect(await getDb().select().from(decision)).toMatchObject([{ kind: 'approve', sha: 'abc' }])

    const running = await seed('build')
    await expect(approve(deps(), running)).rejects.toThrow(ActionRefused)
    await expect(approve(deps(), 999)).rejects.toThrow(/does not exist/)
  })

  it('sends a pull request back with a note, starts a run, and refuses a second click', async () => {
    const id = await seed('done', { headSha: 'abc' })

    const result = await requestChanges(deps(), id, '  Rename the helper.  ')

    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row.stage).toBe('intake')
    expect(await getDb().select().from(decision)).toMatchObject([
      { kind: 'request_changes', note: 'Rename the helper.', sha: 'abc' },
    ])
    expect(queued).toEqual([
      {
        input: { taskId: id, decisionId: result.decisionId },
        key: `task-${id}-d${result.decisionId}`,
      },
    ])
    await expect(requestChanges(deps(), id, 'again')).rejects.toThrow(ActionRefused)
    expect(queued).toHaveLength(1)
  })

  it('refuses to send back work that is already integrated, and says to open a new job', async () => {
    const id = await seed('done', { headSha: 'abc', mergedSha: 'merged1' })
    await expect(requestChanges(deps(), id, 'Rename it.')).rejects.toThrow(
      /already integrated.*open a new job/,
    )
    expect(queued).toEqual([])
    expect((await getDb().select().from(task).where(eq(task.id, id)))[0].stage).toBe('done')
  })

  it('refuses an empty note, and a task that is not at a pull request', async () => {
    const id = await seed('done', { headSha: 'abc' })
    await expect(requestChanges(deps(), id, '   ')).rejects.toThrow(/say what should change/)
    const failed = await seed('failed')
    await expect(requestChanges(deps(), failed, 'x')).rejects.toThrow(/pull request/)
    expect(queued).toEqual([])
  })

  it('retries a failed or handed-over task from the start, after deleting its branch', async () => {
    const failed = await seed('failed', { issueNumber: 41 })
    const handed = await seed('handoff', { issueNumber: 42 })

    await retry(deps(), failed)
    await retry(deps(), handed)

    expect(deleted).toEqual(['factory/41', 'factory/42'])
    expect(queued).toHaveLength(2)
    expect((await getDb().select().from(task).where(eq(task.id, failed)))[0].stage).toBe('intake')
    const decisions = await getDb().select().from(decision)
    expect(decisions.map((d) => d.kind)).toEqual(['retry', 'retry'])
  })

  it('does not retry a task that is running, waiting or done', async () => {
    for (const stage of ['build', 'waiting', 'done']) {
      const id = await seed(stage)
      await expect(retry(deps(), id)).rejects.toThrow(ActionRefused)
    }
    expect(deleted).toEqual([])
    expect(queued).toEqual([])
  })

  it('starts again every task that failed for a reason that passes, and no other', async () => {
    const quota = await seed('failed', { issueNumber: 51 }, [
      { stage: 'failed', detail: { quota: true } },
    ])
    const outage = await seed('failed', { issueNumber: 52 }, [
      { stage: 'failed', detail: { error: 'GitHub answered 502' } },
    ])
    const work = await seed('failed', { issueNumber: 53 }, [
      { stage: 'failed', detail: { error: 'the tests failed' } },
    ])

    expect(await retryWaiting(deps())).toEqual({ started: 2, skipped: 0 })

    const stages = new Map((await getDb().select().from(task)).map((t) => [t.id, t.stage] as const))
    expect([stages.get(quota), stages.get(outage), stages.get(work)]).toEqual([
      'intake',
      'intake',
      'failed',
    ])
    expect(deleted.sort()).toEqual(['factory/51', 'factory/52'])
  })

  it('runs again on its own each task whose time came, oldest first and a few at a time', async () => {
    const past = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    const due = (issueNumber: number, minutes: number) =>
      seed('failed', { issueNumber }, [
        { stage: 'failed', detail: { quota: true, resumesAt: past(minutes) } },
      ])
    const newest = await due(71, 5)
    const oldest = await due(72, 50)
    const middle = await due(73, 20)
    const notYet = await seed('failed', { issueNumber: 74 }, [
      {
        stage: 'failed',
        detail: { quota: true, resumesAt: new Date(Date.now() + 3600_000).toISOString() },
      },
    ])
    const work = await seed('failed', { issueNumber: 75 }, [
      { stage: 'failed', detail: { error: 'the tests failed' } },
    ])

    expect(await runDueRetries(deps(), { limit: 2 })).toEqual({ started: 2, skipped: 0 })

    const stages = new Map((await getDb().select().from(task)).map((t) => [t.id, t.stage] as const))
    expect([oldest, middle, newest, notYet, work].map((id) => stages.get(id))).toEqual([
      'intake',
      'intake',
      'failed',
      'failed',
      'failed',
    ])
    expect(deleted.sort()).toEqual(['factory/72', 'factory/73'])
    // Nobody decided it: the run is marked as the factory's own, and no decision is made up for it.
    expect(await getDb().select().from(decision)).toEqual([])
    const intake = await getDb().select().from(stageEvent).where(eq(stageEvent.taskId, oldest))
    expect(intake.at(-1)?.detail).toMatchObject({ decision: 'retry', automatic: true })
    expect(queued.map((q) => q.input)).toEqual([{ taskId: oldest }, { taskId: middle }])
  })

  it('counts a task that moved on since the board was read, and starts the rest', async () => {
    const moved = await seed('failed', { issueNumber: 61 }, [
      { stage: 'failed', detail: { quota: true } },
    ])
    const waiting = await seed('failed', { issueNumber: 62 }, [
      { stage: 'failed', detail: { quota: true } },
    ])
    const racing: ActionDeps = {
      ...deps(),
      github: {
        installationToken: async () => {
          // Another click started the first task while this one was on its way.
          await getDb().update(task).set({ stage: 'build' }).where(eq(task.id, moved))
          return { token: 't', expiresAt: new Date() }
        },
      },
    }

    expect(await retryWaiting(racing)).toEqual({ started: 1, skipped: 1 })
    expect((await getDb().select().from(task).where(eq(task.id, waiting)))[0].stage).toBe('intake')
  })

  it('fails loudly when GitHub refuses, instead of counting the task as skipped', async () => {
    await seed('failed', { issueNumber: 71 }, [{ stage: 'failed', detail: { quota: true } }])
    const broken: ActionDeps = {
      ...deps(),
      api: {
        deleteBranch: async () => {
          throw new Error('GitHub answered 401')
        },
      } as unknown as GithubApi,
    }

    await expect(retryWaiting(broken)).rejects.toThrow(/GitHub answered 401/)
    expect(queued).toEqual([])
  })
})

describe('stageStream', () => {
  async function readFrames(response: Response, until: (text: string) => boolean) {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && !until(text)) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value)
    }
    await reader.cancel().catch(() => {})
    return text
  }

  it('sends the stage changes that happen after it connects, not the old ones', async () => {
    const id = await seed('build', {}, [{ stage: 'sandbox' }])
    const abort = new AbortController()
    const response = stageStream(getDb(), abort.signal, { intervalMs: 40, pingMs: 10_000 })
    expect(response.headers.get('content-type')).toBe('text/event-stream')

    const reading = readFrames(response, (t) => t.includes('"stage":"review"'))
    await new Promise((r) => setTimeout(r, 120))
    await getDb().insert(stageEvent).values({ taskId: id, stage: 'review', detail: null })
    const text = await reading
    abort.abort()

    expect(text).toContain(': connected')
    expect(text).toContain(`data: {"type":"stage","taskId":${id},"stage":"review"`)
    expect(text).not.toContain('"stage":"sandbox"')
  })

  it("sends each step an agent takes after it connects, with the task's id, and not the old ones", async () => {
    const id = await seed('build')
    const step = (seq: number, content: string) => ({
      taskId: id,
      role: 'builder' as const,
      attempt: 1,
      seq,
      kind: 'message' as const,
      content,
    })
    await getDb().insert(agentEvent).values(step(1, 'old step'))
    const abort = new AbortController()
    const response = stageStream(getDb(), abort.signal, { intervalMs: 40, pingMs: 10_000 })

    const reading = readFrames(response, (t) => t.includes('new step'))
    await new Promise((r) => setTimeout(r, 120))
    await getDb().insert(agentEvent).values(step(2, 'new step'))
    const text = await reading
    abort.abort()

    expect(text).toContain(`"type":"agent","taskId":${id},"event":{"seq":2,"role":"builder"`)
    expect(text).not.toContain('old step')
  })

  it('pings when nothing happens, and stops when the client leaves', async () => {
    const abort = new AbortController()
    const response = stageStream(getDb(), abort.signal, { intervalMs: 20, pingMs: 60 })
    const text = await readFrames(response, (t) => t.includes(': ping'))
    abort.abort()
    expect(text).toContain(': ping')
  })
})

describe('deliveries on the panel', () => {
  it('shows the pre-release of the commit the task is at, and the release once there is one', async () => {
    const id = await seed('done', { headSha: 'sha-2' })
    const add = (kind: 'prerelease' | 'release', tag: string, sha: string, actor = 'factory') =>
      getDb()
        .insert(delivery)
        .values({ taskId: id, kind, tag, url: `https://x/${tag}`, sha, actor })
    await add('prerelease', 'pre/1-sha-1', 'sha-1')
    await add('prerelease', 'pre/1-sha-2', 'sha-2')

    let [card] = await listTasks(getDb())
    expect(card.preRelease).toEqual({ tag: 'pre/1-sha-2', url: 'https://x/pre/1-sha-2' })
    expect(card.release).toBeNull()

    await getDb().update(task).set({ headSha: 'sha-3' }).where(eq(task.id, id))
    ;[card] = await listTasks(getDb())
    expect(card.preRelease).toBeNull() // the commit it is at now was not delivered

    // Once the work is integrated its pre-release is a tag on the pre-release branch, at a commit of its
    // own, so it counts whatever commit the task is at.
    await getDb().update(task).set({ mergedSha: 'merged-1' }).where(eq(task.id, id))
    ;[card] = await listTasks(getDb())
    expect(card).toMatchObject({ integrated: true, preRelease: { tag: 'pre/1-sha-2' } })

    await getDb().update(task).set({ headSha: 'sha-2', stage: 'released' }).where(eq(task.id, id))
    await add('release', 'v0.1.0', 'merge1', 'human')
    ;[card] = await listTasks(getDb())
    expect(card).toMatchObject({ column: 'released', release: { tag: 'v0.1.0' } })

    const detail = (await taskDetail(getDb(), id))!
    expect(detail.deliveries.map((d) => [d.kind, d.tag, d.actor])).toEqual([
      ['prerelease', 'pre/1-sha-1', 'factory'],
      ['prerelease', 'pre/1-sha-2', 'factory'],
      ['release', 'v0.1.0', 'human'],
    ])
  })

  it('does not count a released task as waiting for a person', async () => {
    await seed('released', { headSha: 'abc' }, [{ stage: 'released' }])
    expect(await inbox(getDb())).toEqual([])
  })

  it('turns a refused release into a refusal the panel can show', async () => {
    const id = await seed('build')
    const deps = {
      db: getDb(),
      github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
      api: {} as never,
      inTransaction: async () => undefined as never,
      enqueueResume: async () => {},
      deleteSnapshot: async () => {},
    } as ActionDeps
    await expect(releaseTask(deps, id, 'patch')).rejects.toThrow(ActionRefused)
    await expect(releaseTask(deps, id, 'patch')).rejects.toThrow(/only a finished task/)
    await expect(releaseTask(deps, 999, 'patch')).rejects.toThrow(/does not exist/)
  })
})

describe('a red default branch on the panel', () => {
  const noDeps = () =>
    ({
      db: getDb(),
      github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
      api: {} as never,
      inTransaction: async () => undefined as never,
      enqueueResume: async () => {},
      deleteSnapshot: async () => {},
    }) as ActionDeps

  async function red(over: Partial<typeof watch.$inferInsert> = {}) {
    const id = await seed('released', { headSha: 'abc' }, [{ stage: 'released' }])
    const [w] = await getDb()
      .insert(watch)
      .values({
        taskId: id,
        repository: 'paulo/app',
        sha: 'merge1',
        pullRequestNumber: 3,
        tag: 'v0.1.0',
        status: 'red',
        revertUrl: 'https://github.com/paulo/app/pull/9',
        detail: 'failing: ci',
        endedAt: new Date(),
        ...over,
      })
      .returning({ id: watch.id })
    return { taskId: id, watchId: w.id }
  }

  it('flags the task, shows the watch, and puts it in the inbox with the revert', async () => {
    const { taskId } = await red()

    const [card] = await listTasks(getDb())
    expect(card.mainRed).toBe(true)
    const detail = (await taskDetail(getDb(), taskId))!
    expect(detail.watches).toMatchObject([
      {
        status: 'red',
        revertUrl: 'https://github.com/paulo/app/pull/9',
        acknowledged: false,
        tag: 'v0.1.0',
      },
    ])
    const items = await inbox(getDb())
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('main_red')
    expect(items[0].summary).toContain('went red after v0.1.0')
    expect(items[0].summary).toContain('A revert pull request is open.')
    expect(items[0].summary).toContain('failing: ci')
  })

  it('says there is no revert when GitHub would not open one', async () => {
    await red({ revertUrl: null, detail: 'failing: ci; no revert was opened: conflicts' })
    expect((await inbox(getDb()))[0].summary).toContain('No revert pull request could be opened.')
  })

  it('leaves the inbox when a person says they dealt with it, and only then', async () => {
    const { watchId } = await red()
    await acknowledgeWatch(noDeps(), watchId)

    expect(await inbox(getDb())).toEqual([])
    expect((await listTasks(getDb()))[0].mainRed).toBe(false)
    await expect(acknowledgeWatch(noDeps(), watchId)).rejects.toThrow(ActionRefused)
  })

  it('has nothing to acknowledge on a green, silent or watching one, or on one that is not there', async () => {
    for (const status of ['green', 'silent', 'watching'] as const) {
      const { watchId } = await red({ status, revertUrl: null })
      await expect(acknowledgeWatch(noDeps(), watchId)).rejects.toThrow(/no red default branch/)
    }
    await expect(acknowledgeWatch(noDeps(), 999)).rejects.toThrow(ActionRefused)
    expect(await inbox(getDb())).toEqual([])
  })
})

describe('health', () => {
  const NOW = new Date('2026-11-04T12:00:00Z')
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)

  async function run(taskId: number, over: Partial<typeof agentRun.$inferInsert> = {}) {
    await getDb()
      .insert(agentRun)
      .values({
        taskId,
        role: 'builder',
        harness: 'claude-code',
        attempt: 1,
        costUsd: 0.1,
        durationMs: 1000,
        ok: true,
        at: hoursAgo(1),
        ...over,
      })
  }

  it('tells the cost over time and per agent and role, counting an agent with no cost as runs', async () => {
    const id = await seed('done', { costUsd: 0.5 })
    await run(id, { costUsd: 0.2, at: hoursAgo(2) })
    await run(id, { role: 'reviewer', costUsd: 0.05, at: hoursAgo(3), durationMs: 3000 })
    await run(id, { costUsd: 0.4, at: hoursAgo(24 * 3) })
    await run(id, { costUsd: 1, at: hoursAgo(24 * 20) })
    await run(id, { harness: 'codex', costUsd: null, ok: false, quota: true, at: hoursAgo(1) })
    await run(id, { harness: 'codex', costUsd: null, ok: true, at: hoursAgo(1) })

    const report = await health(getDb(), NOW)

    expect(report.cost.last24HoursUsd).toBeCloseTo(0.25)
    expect(report.cost.last7DaysUsd).toBeCloseTo(0.65)
    expect(report.cost.totalUsd).toBeCloseTo(1.65)
    expect(report.cost.groups).toEqual([
      {
        harness: 'claude-code',
        role: 'builder',
        runs: 3,
        reportedRuns: 3,
        costUsd: expect.closeTo(1.6),
        avgDurationMs: 1000,
        failed: 0,
        quota: 0,
      },
      {
        harness: 'claude-code',
        role: 'reviewer',
        runs: 1,
        reportedRuns: 1,
        costUsd: expect.closeTo(0.05),
        avgDurationMs: 3000,
        failed: 0,
        quota: 0,
      },
      {
        harness: 'codex',
        role: 'builder',
        runs: 2,
        reportedRuns: 0,
        costUsd: 0,
        avgDurationMs: 1000,
        failed: 0,
        quota: 1,
      },
    ])
  })

  it('averages what a task costs over the tasks that cost anything', async () => {
    await seed('done', { costUsd: 0.3 })
    await seed('done', { costUsd: 0.1 })
    await seed('intake', { costUsd: 0 })
    const { cost } = await health(getDb(), NOW)
    expect(cost.tasks).toBe(2)
    expect(cost.avgPerTaskUsd).toBeCloseTo(0.2)
  })

  it('is all zeros, not an error, when nothing has run', async () => {
    const { cost, findings } = await health(getDb(), NOW)
    expect(cost).toEqual({
      last24HoursUsd: 0,
      last7DaysUsd: 0,
      totalUsd: 0,
      tasks: 0,
      avgPerTaskUsd: 0,
      groups: [],
    })
    expect(findings).toEqual([])
  })

  it('lists the open findings, oldest first, with the task they are about, and not the resolved ones', async () => {
    const id = await seed('build', { issueTitle: 'Stuck one' as never })
    const add = (key: string, over: Partial<typeof finding.$inferInsert>) =>
      getDb()
        .insert(finding)
        .values({ key, kind: 'stalled', subject: 'run', detail: key, taskId: id, ...over })
    await add('b', { firstSeenAt: hoursAgo(1) })
    await add('a', { firstSeenAt: hoursAgo(5) })
    await add('gone', { resolvedAt: hoursAgo(1) })
    await add('snap', { kind: 'orphaned', subject: 'snapshot', taskId: null, ref: 'snap-1' })

    const { findings } = await health(getDb(), NOW)

    expect(findings.map((f) => f.detail)).toEqual(['a', 'b', 'snap'])
    expect(findings.find((f) => f.detail === 'a')?.taskTitle).toBeTruthy()
    expect(findings.find((f) => f.detail === 'snap')).toMatchObject({
      taskId: null,
      taskTitle: null,
      ref: 'snap-1',
    })
  })

  it('shows the executions of a task on its detail', async () => {
    const id = await seed('done')
    await run(id)
    await run(id, { role: 'reviewer', harness: 'codex', costUsd: null })
    expect(
      (await taskDetail(getDb(), id))!.runs.map((r) => [r.role, r.harness, r.costUsd]),
    ).toEqual([
      ['builder', 'claude-code', 0.1],
      ['reviewer', 'codex', null],
    ])
  })
})

describe('resolving a finding', () => {
  const resumed: { input: object; key: string }[] = []
  const snapshotsDeleted: string[] = []
  const queued: object[] = []
  const deleted: string[] = []
  const deps = (): ActionDeps => ({
    db: getDb(),
    github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
    api: {
      deleteBranch: async (_r: string, _t: string, b: string) => void deleted.push(b),
    } as never,
    enqueueResume: async (input, key) => void resumed.push({ input, key }),
    deleteSnapshot: async (id) => void snapshotsDeleted.push(id),
    inTransaction: (work) =>
      getDb().transaction((tx) => work(tx as never, async (input) => void queued.push(input))),
  })
  beforeEach(() => {
    resumed.length = 0
    snapshotsDeleted.length = 0
    queued.length = 0
    deleted.length = 0
  })

  const open = async (over: Partial<typeof finding.$inferInsert>) => {
    const [f] = await getDb()
      .insert(finding)
      .values({ key: `k-${Math.random()}`, kind: 'stalled', subject: 'run', detail: 'd', ...over })
      .returning({ id: finding.id })
    return f.id
  }
  const isOpen = async (id: number) =>
    (await getDb().select().from(finding).where(eq(finding.id, id)))[0].resolvedAt === null

  it('retries a task whose run stalled, though it is in a working stage, and closes the finding', async () => {
    const taskId = await seed('build', { issueNumber: 31 })
    const id = await open({ taskId, subject: 'run' })

    await resolveFinding(deps(), id, 'retry')

    expect((await getDb().select().from(task).where(eq(task.id, taskId)))[0].stage).toBe('intake')
    expect(deleted).toEqual(['factory/31'])
    expect(queued).toHaveLength(1)
    expect(await isOpen(id)).toBe(false)
  })

  it('does not retry a working task on a plain retry, only when a finding says it is stuck', async () => {
    const taskId = await seed('build')
    await expect(retry(deps(), taskId)).rejects.toThrow(ActionRefused)
  })

  it('queues the resume again for an answer whose job was lost', async () => {
    const taskId = await seed('waiting')
    const [q] = await getDb()
      .insert(question)
      .values({
        taskId,
        body: 'q',
        commentId: '1',
        snapshotId: 's',
        sessionId: 'x',
        harness: 'h',
        repoDir: '/r',
        baseSha: 'b',
        attempt: 1,
        costUsd: 0,
        answer: 'B',
        answeredBy: 'paulo',
      })
      .returning({ id: question.id })
    const id = await open({ taskId, kind: 'orphaned', subject: 'answer_resume', ref: String(q.id) })

    await resolveFinding(deps(), id, 'resume')

    expect(resumed).toHaveLength(1)
    expect(resumed[0].input).toEqual({ taskId, questionId: q.id })
    expect(resumed[0].key).toMatch(new RegExp(`^resume-${q.id}-again-`))
    expect(await isOpen(id)).toBe(false)
  })

  it('deletes the snapshot a finding names, and no other', async () => {
    const id = await open({ kind: 'orphaned', subject: 'snapshot', ref: 'snap-orphan' })
    await resolveFinding(deps(), id, 'delete_snapshot')
    expect(snapshotsDeleted).toEqual(['snap-orphan'])
    expect(await isOpen(id)).toBe(false)
  })

  it('turns a stuck revert into a red one that says to look at the repository', async () => {
    const taskId = await seed('released')
    const [w] = await getDb()
      .insert(watch)
      .values({
        taskId,
        repository: 'paulo/app',
        sha: 'm',
        pullRequestNumber: 1,
        status: 'reverting',
      })
      .returning({ id: watch.id })
    const id = await open({ taskId, kind: 'orphaned', subject: 'revert', ref: String(w.id) })

    await resolveFinding(deps(), id, 'mark_revert_unknown')

    const [stored] = await getDb().select().from(watch).where(eq(watch.id, w.id))
    expect(stored.status).toBe('red')
    expect(stored.detail).toContain('check the repository for a revert pull request')
    const items = await inbox(getDb())
    expect(items[0].kind).toBe('main_red')
  })

  it('refuses an action the finding does not allow, a finding that is closed, and one that is not there', async () => {
    const snap = await open({ kind: 'orphaned', subject: 'snapshot', ref: 'snap-1' })
    for (const action of ['retry', 'resume', 'mark_revert_unknown'] as FindingAction[]) {
      await expect(resolveFinding(deps(), snap, action)).rejects.toThrow(
        /is not something to do about a snapshot/,
      )
    }
    const closed = await open({
      kind: 'orphaned',
      subject: 'snapshot',
      ref: 's',
      resolvedAt: new Date(),
    })
    await expect(resolveFinding(deps(), closed, 'delete_snapshot')).rejects.toThrow(/not open/)
    await expect(resolveFinding(deps(), 999, 'retry')).rejects.toThrow(ActionRefused)
    expect(snapshotsDeleted).toEqual([])
    expect(await isOpen(snap)).toBe(true)
  })

  it('refuses to resume a question that has no answer or was already resumed', async () => {
    const taskId = await seed('waiting')
    const [q] = await getDb()
      .insert(question)
      .values({
        taskId,
        body: 'q',
        commentId: '1',
        snapshotId: 's',
        sessionId: 'x',
        harness: 'h',
        repoDir: '/r',
        baseSha: 'b',
        attempt: 1,
        costUsd: 0,
      })
      .returning({ id: question.id })
    const id = await open({ taskId, kind: 'orphaned', subject: 'answer_resume', ref: String(q.id) })
    await expect(resolveFinding(deps(), id, 'resume')).rejects.toThrow(/nothing to resume/)
    expect(resumed).toEqual([])
  })
})

describe('a long transcript', () => {
  it('of more than 5 thousand steps is read from where the client is, a page at a time', async () => {
    const id = await seed('build')
    const rows = Array.from({ length: 5_200 }, (_, i) => ({
      taskId: id,
      role: 'builder' as const,
      attempt: 1,
      seq: i + 1,
      kind: 'tool_result' as const,
      content: `line ${i + 1}`,
    }))
    for (let i = 0; i < rows.length; i += 1_000) {
      await getDb()
        .insert(agentEvent)
        .values(rows.slice(i, i + 1_000))
    }

    const after = await eventsOf(getDb(), id, { afterSeq: 5_190 })
    expect(after.map((e) => e.seq)).toEqual([
      5191, 5192, 5193, 5194, 5195, 5196, 5197, 5198, 5199, 5200,
    ])
    expect(await eventsOf(getDb(), id, { afterSeq: 0, limit: 3 })).toHaveLength(3)
  })

  it('keeps 30 days of steps and deletes the older ones', async () => {
    const id = await seed('done')
    const now = new Date('2026-11-07T12:00:00Z')
    const day = 86_400_000
    const at = (days: number) => new Date(now.getTime() - days * day)
    await getDb()
      .insert(agentEvent)
      .values([
        {
          taskId: id,
          role: 'builder',
          attempt: 1,
          seq: 1,
          kind: 'message',
          content: 'a',
          at: at(31),
        },
        {
          taskId: id,
          role: 'builder',
          attempt: 1,
          seq: 2,
          kind: 'message',
          content: 'b',
          at: at(29),
        },
      ])

    expect(await pruneTranscripts(getDb(), now)).toBe(1)
    expect((await eventsOf(getDb(), id)).map((e) => e.content)).toEqual(['b'])
  })
})
