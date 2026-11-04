import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import {
  decision,
  delivery,
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
  releaseTask,
  requestChanges,
  retry,
  type ActionDeps,
} from './actions'
import { inbox, listTasks, taskDetail } from './queries'
import { stageStream } from './stream'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table watch, delivery, decision, question, review, evidence, stage_event, task, ingress restart identity cascade',
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
    })
    expect(cards.find((c) => c.id !== id)?.column).toBe('attention')
    expect(new Set(cards.map((c) => c.column))).toEqual(new Set(['review', 'attention']))
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
})

describe('actions', () => {
  const queued: { input: object; key: string }[] = []
  const deleted: string[] = []
  const api = {
    deleteBranch: async (_repo: string, _token: string, branch: string) =>
      void deleted.push(branch),
  } as unknown as GithubApi
  const deps = (): ActionDeps => ({
    db: getDb(),
    github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
    api,
    inTransaction: (work) =>
      getDb().transaction((tx) =>
        work(tx as never, async (input, key) => void queued.push({ input, key })),
      ),
  })
  beforeEach(() => {
    queued.length = 0
    deleted.length = 0
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
