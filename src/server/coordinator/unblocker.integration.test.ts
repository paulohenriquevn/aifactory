import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { coordinatorAction, ingress, question, review, stageEvent, task } from '../db/schema'
import { FakeGithub } from '../../test/fake-github'
import { jobBackend } from '../factory/job-backend'
import { pickAnswer, QUESTION_MARKER } from '../factory/waiting'
import type { FailedRun } from '../github/promotion-api'
import { UNBLOCKER_AUTHOR } from '../panel/actions'

import { coordinate, type CoordinatorDeps } from './coordinate'
import { QUESTION_WAIT_MS, UNBLOCKER_MAX_APPLIED } from './unblocker'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  await jobBackend().migrate()
})
beforeEach(async () => {
  await getPool().query(
    'truncate table theokit_jobs, coordinator_action, failure_signature, finding, decision, review, change_plan, question, stage_event, task, ingress, repository restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

const SHA = 'c'.repeat(40)
const NOW = new Date('2026-11-18T12:00:00Z')
const REPO = 'paulo/app'

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
      deliveryId: `u-${++seeded}`,
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
      issueNumber: 40 + seeded,
      issueTitle: 'T',
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

const issueOf = async (id: number) =>
  (await getDb().select().from(task).where(eq(task.id, id)))[0].issueNumber

/** A task handed over for a cause the coordinator has no playbook for, so it would escalate it. */
async function handedOver() {
  const id = await seed('handoff', { headSha: SHA }, [
    { stage: 'intake' },
    {
      stage: 'handoff',
      detail: { reason: 'GitHub answered 403 creating the pull request', cause: 'other' },
    },
  ])
  const number = await issueOf(id)
  api.repo(REPO).issue(number, { title: 'Add a flag', body: 'Add --dry-run.' })
  api.repo(REPO).comment(number, { body: 'The flag goes in packages/cli.' })
  api.repo(REPO).heads.set(`factory/${number}`, SHA)
  return id
}

/** A task whose builder asked a question `ago` milliseconds before now. */
async function asking(ago: number) {
  const id = await seed('waiting', { headSha: SHA }, [{ stage: 'intake' }, { stage: 'waiting' }])
  api.repo(REPO).issue(await issueOf(id), { body: 'Add --dry-run to the CLI in packages/cli.' })
  const [q] = await getDb()
    .insert(question)
    .values({
      taskId: id,
      body: 'Which package owns the CLI?',
      commentId: 'asked-1',
      askedAt: new Date(NOW.getTime() - ago),
      costUsd: 0.4,
    })
    .returning({ id: question.id })
  return { id, questionId: q.id }
}

const queued: { input: Record<string, unknown>; key: string }[] = []
const resumed: { taskId: number; questionId: number }[] = []
let api = new FakeGithub()
/** What the fake unblocker was asked, and what it answers next. */
const model = { asked: [] as string[], answer: '', fails: '' }
const reruns = { failed: [] as FailedRun[], reran: [] as number[], refuse: false }

const deps = (): CoordinatorDeps => ({
  db: getDb(),
  github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
  api,
  issues: api,
  readIssue: (repo, number) => api.readIssue(repo, number),
  drafter: async () => {
    throw new Error('the scope drafter is not asked here')
  },
  unblocker: async (message) => {
    model.asked.push(message)
    if (model.fails) throw new Error(model.fails)
    return { response: model.answer, cost: 0.05 }
  },
  releaseMode: 'manual',
  now: () => NOW,
  enqueueResume: async () => undefined,
  deleteSnapshot: async () => undefined,
  inTransaction: (work) =>
    getDb().transaction((tx) =>
      work(tx as never, async (input, key) => void queued.push({ input, key })),
    ),
  answerInTransaction: (work) =>
    getDb().transaction((tx) =>
      work(
        tx as never,
        async (taskId, questionId) => void resumed.push({ taskId, questionId }),
        async () => undefined,
      ),
    ),
  checkReruns: {
    failedChecks: async () => reruns.failed,
    jobAttempt: async (_repo, _token, jobId) => ({ runId: jobId * 10, attempt: 1 }),
    rerunFailedJobs: async (_repo, _token, runId) => {
      if (reruns.refuse) return { started: false, refusal: 'GitHub answered 403' }
      reruns.reran.push(runId)
      return { started: true }
    },
  },
})
beforeEach(() => {
  queued.length = 0
  resumed.length = 0
  api = new FakeGithub()
  Object.assign(model, { asked: [], answer: '', fails: '' })
  Object.assign(reruns, { failed: [], reran: [], refuse: false })
})

const stageOf = async (id: number) =>
  (await getDb().select({ stage: task.stage }).from(task).where(eq(task.id, id)))[0].stage
const actions = () => getDb().select().from(coordinatorAction).orderBy(coordinatorAction.id)
const answers = (verdict: object) => {
  model.answer = `Looked at it.\n${JSON.stringify(verdict)}`
}

describe('the unblocker on what the coordinator would escalate', () => {
  it('reads the issue, its comments, the history and the reviews before it decides', async () => {
    const id = await handedOver()
    await getDb()
      .insert(review)
      .values({
        taskId: id,
        round: 1,
        sha: SHA,
        reviewer: 'codex',
        verdict: 'changes',
        summary: 'Missing a test',
        findings: [{ severity: 'major', file: 'src/cli.ts', issue: 'no test for --dry-run' }],
      })
    answers({
      action: 'escalate',
      category: 'repository_settings',
      reason: 'the App may not write',
    })

    await coordinate(deps(), 'auto')

    expect(model.asked).toHaveLength(1)
    const [message] = model.asked
    expect(message).toContain('<issue-body>\nAdd --dry-run.\n</issue-body>')
    expect(message).toContain('The flag goes in packages/cli.')
    expect(message).toContain('handoff: GitHub answered 403 creating the pull request')
    expect(message).toContain('no test for --dry-run')
    expect(message).toContain('the coordinator has no action for handoff yet')
  })

  it('reads the pull request and what its failed jobs logged', async () => {
    const id = await handedOver()
    const number = await issueOf(id)
    api
      .repo(REPO)
      .pullRequest({ number: 90, headRef: `factory/${number}`, mergeableState: 'clean' })
    await getDb()
      .update(task)
      .set({ pullRequestUrl: `https://github.com/${REPO}/pull/90` })
      .where(eq(task.id, id))
    answers({ action: 'rerun_checks', reason: 'r' })
    const run = {
      ...deps(),
      ciChecks: {
        failedChecks: async () => [
          { id: 5, name: 'unit', url: 'https://ci/5', summary: '', actions: true },
        ],
        jobLog: async () => '##[error]FAIL src/cli.test.ts > parses --dry-run\n',
        annotations: async () => [],
      },
    }

    await coordinate(run, 'trial')

    const [message] = model.asked
    expect(message).toContain(`https://github.com/${REPO}/pull/90: open, mergeable state clean`)
    expect(message).toContain('unit (https://ci/5)')
    expect(message).toContain('FAIL src/cli.test.ts > parses --dry-run')
  })

  it('decides on what it has when GitHub refuses a read, saying which', async () => {
    await handedOver()
    api.fail('listIssueComments', new Error('GitHub answered 502 listing comments'))
    answers({ action: 'retry', reason: 'r' })

    await coordinate(deps(), 'trial')

    expect(model.asked[0]).toContain('(could not read the comments of paulo/app#')
    expect(model.asked[0]).toContain('GitHub answered 502 listing comments)')
    expect(await actions()).toMatchObject([{ action: 'retry', outcome: 'trial' }])
  })

  it('sends the task back with its note, marking the row as its own, in auto', async () => {
    const id = await handedOver()
    answers({ action: 'send_back', note: 'Fix src/cli.ts: parse --dry-run.', reason: 'the log' })

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 1 })
    expect(await stageOf(id)).toBe('intake')
    expect(queued.map((q) => q.input)).toEqual([
      { taskId: id, feedback: 'Fix src/cli.ts: parse --dry-run.' },
    ])
    expect(await actions()).toMatchObject([
      {
        exceptionKind: 'handoff',
        headSha: SHA,
        action: 'send_back',
        outcome: 'applied',
        reason: 'the unblocker decided send back: the log',
        costUsd: 0.05,
        draft: { by: 'unblocker', unblocker: { action: 'send_back' } },
      },
    ])
  })

  it('records what it would do and applies nothing, in trial', async () => {
    const id = await handedOver()
    answers({ action: 'retry', reason: 'the rate limit passed' })

    const result = await coordinate(deps(), 'trial')
    await coordinate(deps(), 'trial')

    expect(result).toMatchObject({ trial: 1 })
    expect(await stageOf(id)).toBe('handoff')
    expect(queued).toEqual([])
    expect(model.asked).toHaveLength(1)
    expect(await actions()).toMatchObject([{ action: 'retry', outcome: 'trial' }])
  })

  it('keeps the escalation, with the parse error and the answer, when its answer does not parse', async () => {
    await handedOver()
    model.answer = 'I would merge it.'

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ escalated: 1 })
    const [row] = await actions()
    expect(row).toMatchObject({
      action: 'escalate',
      outcome: 'escalated',
      draft: { answer: 'I would merge it.' },
    })
    expect(row.reason).toContain(
      "the unblocker's answer could not be used: the answer holds no JSON object",
    )
  })

  it('refuses an escalation that names no owner category', async () => {
    await handedOver()
    answers({ action: 'escalate', category: 'unsure', reason: 'hard to say' })

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ refused: 1 })
    const [row] = await actions()
    expect(row).toMatchObject({ action: 'escalate', outcome: 'refused' })
    expect(row.reason).toContain('and this one named unsure')
  })

  it('refuses a note that names quality configuration, changing nothing', async () => {
    const id = await handedOver()
    answers({ action: 'send_back', note: 'Lower the coverage threshold.', reason: 'r' })

    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('handoff')
    expect(await actions()).toMatchObject([{ action: 'send_back', outcome: 'refused' }])
  })

  it('leaves the escalation with a person when the model fails', async () => {
    await handedOver()
    model.fails = 'the provider answered 529'

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ escalated: 1 })
    const [row] = await actions()
    expect(row.reason).toContain('the unblocker failed: the provider answered 529')
  })

  it('is not asked once it applied three actions on the commit', async () => {
    const id = await handedOver()
    for (const n of [1, 2, 3].slice(0, UNBLOCKER_MAX_APPLIED)) {
      await getDb()
        .insert(coordinatorAction)
        .values({
          taskId: id,
          exceptionKind: 'failure',
          headSha: `${SHA}@${n}`,
          action: 'send_back',
          reason: 'r',
          outcome: 'applied',
          draft: { by: 'unblocker', unblocker: { action: 'send_back' } },
        })
    }

    await coordinate(deps(), 'auto')

    expect(model.asked).toEqual([])
    const rows = await actions()
    expect(rows.at(-1)).toMatchObject({ exceptionKind: 'handoff', outcome: 'escalated' })
    expect(rows.at(-1)!.reason).toContain('the unblocker already applied 3 actions on ccccccc')
  })

  it('declares the blocker on the issue and runs the task again to wait for it', async () => {
    const id = await handedOver()
    answers({ action: 'blocked_by', issue: 'paulo/lib#7', reason: 'it needs the API of lib#7' })

    await coordinate(deps(), 'auto')

    expect(api.repo(REPO).issue(await issueOf(id)).body).toBe(
      'Add --dry-run.\n\nBlocked by paulo/lib#7',
    )
    expect(queued.map((q) => q.input)).toEqual([{ taskId: id, resume: true }])
    expect(await actions()).toMatchObject([{ action: 'blocked_by', outcome: 'applied' }])
  })

  it('re-runs the failed Actions jobs of the head once per workflow run, then runs the task again', async () => {
    const id = await handedOver()
    reruns.failed = [
      { id: 1, name: 'test', url: 'u1', summary: '', actions: true },
      { id: 1, name: 'test again', url: 'u2', summary: '', actions: true },
      { id: 2, name: 'external', url: 'u3', summary: '', actions: false },
    ]
    answers({ action: 'rerun_checks', reason: 'the runner died' })

    await coordinate(deps(), 'auto')

    expect(reruns.reran).toEqual([10])
    expect(queued.map((q) => q.input)).toEqual([{ taskId: id, resume: true }])
    const [row] = await actions()
    expect(row.reason).toContain('re-ran the failed jobs of 1 of 1 workflow runs on ccccccc')
  })

  it('refuses to re-run checks when no Actions job failed on the head', async () => {
    const id = await handedOver()
    answers({ action: 'rerun_checks', reason: 'the runner died' })

    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('handoff')
    const [row] = await actions()
    expect(row).toMatchObject({ outcome: 'refused' })
    expect(row.reason).toContain('no GitHub Actions job failed on ccccccc')
  })

  it('refuses to re-run checks GitHub would not re-run, leaving the task as it was', async () => {
    const id = await handedOver()
    reruns.failed = [{ id: 1, name: 'test', url: 'u1', summary: '', actions: true }]
    reruns.refuse = true
    answers({ action: 'rerun_checks', reason: 'the runner died' })

    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('handoff')
    expect((await actions())[0].reason).toContain('GitHub answered 403')
  })

  it('starts over a task that pushed no work', async () => {
    const id = await handedOver()
    await getDb().update(task).set({ headSha: null }).where(eq(task.id, id))
    api.repo(REPO).heads.delete(`factory/${await issueOf(id)}`)
    answers({ action: 'retry', reason: 'the rate limit passed' })

    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('intake')
    expect(queued.map((q) => q.input)).toEqual([{ taskId: id }])
  })

  it('refuses to start over a task with pushed work, keeping its branch', async () => {
    const id = await handedOver()
    answers({ action: 'retry', reason: 'start clean' })

    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('handoff')
    expect(api.repo(REPO).heads.get(`factory/${await issueOf(id)}`)).toBe(SHA)
    expect(queued).toEqual([])
    expect(await actions()).toMatchObject([{ action: 'retry', outcome: 'refused' }])
  })

  it('resolves the task elsewhere at the head of the integration branch, with the evidence', async () => {
    const id = await handedOver()
    api.repo(REPO).heads.set('workspace', 'e'.repeat(40))
    answers({ action: 'resolve_elsewhere', evidence: 'd'.repeat(40), reason: 'merged by hand' })

    await coordinate(deps(), 'auto')

    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row).toMatchObject({ stage: 'done', resolvedSha: 'e'.repeat(40) })
    expect(await actions()).toMatchObject([{ action: 'resolve_elsewhere', outcome: 'applied' }])
  })
  it('refuses a resolution whose commit the integration branch does not hold', async () => {
    const id = await handedOver()
    api.repo(REPO).heads.set('workspace', 'e'.repeat(40))
    api.repo(REPO).unreachable.add('d'.repeat(40))
    answers({ action: 'resolve_elsewhere', evidence: 'd'.repeat(40), reason: 'merged by hand' })

    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('handoff')
    const [row] = await actions()
    expect(row).toMatchObject({ action: 'resolve_elsewhere', outcome: 'refused' })
    expect(row.reason).toContain('ddddddd')
  })

  it('refuses a resolution whose only evidence is a workflow run', async () => {
    const id = await handedOver()
    api.repo(REPO).heads.set('workspace', 'e'.repeat(40))
    answers({
      action: 'resolve_elsewhere',
      evidence: 'https://github.com/paulo/app/actions/runs/123',
      reason: 'the run passed',
    })

    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('handoff')
    expect(await actions()).toMatchObject([{ action: 'resolve_elsewhere', outcome: 'refused' }])
  })
})

describe('the unblocker on a question the builder asked', () => {
  it('is not asked before the question waited fifteen minutes', async () => {
    await asking(QUESTION_WAIT_MS - 60_000)
    answers({ action: 'answer', text: 'packages/cli', reason: 'the issue says so' })

    await coordinate(deps(), 'auto')

    expect(model.asked).toEqual([])
    expect(await actions()).toEqual([])
  })

  it('stores the answer and queues the resume, then posts it on the issue for the record', async () => {
    const { id, questionId } = await asking(QUESTION_WAIT_MS + 60_000)
    answers({
      action: 'answer',
      text: 'The CLI is in packages/cli.',
      reason: 'the issue body says so',
    })

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 1 })
    expect(model.asked[0]).toContain('<question>\nWhich package owns the CLI?\n</question>')
    const [q] = await getDb().select().from(question).where(eq(question.id, questionId))
    expect(q).toMatchObject({ answer: 'The CLI is in packages/cli.', answeredBy: UNBLOCKER_AUTHOR })
    expect(resumed).toEqual([{ taskId: id, questionId }])
    const comments = api.repo(REPO).issue(await issueOf(id)).comments
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toContain(QUESTION_MARKER)
    expect(comments[0].body).toContain('The CLI is in packages/cli.')
    // The poller never takes the factory's own comment as an answer: the stored one is what resumes the run.
    expect(pickAnswer(comments, { commentId: 'asked-1', at: new Date(0) })).toBeUndefined()
    expect(await actions()).toMatchObject([
      {
        exceptionKind: 'question',
        headSha: `question:${questionId}`,
        action: 'answer',
        outcome: 'applied',
      },
    ])
  })

  it('refuses anything but an answer or an escalation for a waiting task', async () => {
    const { id } = await asking(QUESTION_WAIT_MS + 60_000)
    answers({ action: 'retry', reason: 'start again' })

    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('waiting')
    expect(await actions()).toMatchObject([{ action: 'retry', outcome: 'refused' }])
  })

  it('does not answer a question a person answered first', async () => {
    const { questionId } = await asking(QUESTION_WAIT_MS + 60_000)
    answers({ action: 'answer', text: 'packages/cli', reason: 'r' })
    const run = deps()
    const answerInTransaction = run.answerInTransaction!
    run.answerInTransaction = async (work) => {
      await getDb()
        .update(question)
        .set({ answer: 'a person did' })
        .where(eq(question.id, questionId))
      return answerInTransaction(work)
    }

    await coordinate(run, 'auto')

    expect(resumed).toEqual([])
    const [row] = await actions()
    expect(row).toMatchObject({ action: 'answer', outcome: 'refused' })
    expect(row.reason).toContain('is answered already')
  })

  it('looks at no question when the coordinator has no unblocker', async () => {
    await asking(QUESTION_WAIT_MS + 60_000)

    await coordinate({ ...deps(), unblocker: undefined }, 'auto')

    expect(await actions()).toEqual([])
  })
})
