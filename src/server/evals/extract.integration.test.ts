import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { evidence, ingress, stageEvent, task } from '../db/schema'

import { deliveredCandidates, toCase } from './extract'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table finding, agent_run, watch, delivery, decision, question, review, evidence, stage_event, task, ingress restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

const T0 = new Date('2026-11-10T10:00:00Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)

let seeded = 0
async function seedTask(input: {
  stage?: 'done' | 'released' | 'failed'
  events: { stage: string; minute: number; detail?: Record<string, unknown> }[]
  checks?: { name: string; command: string; sha: string }[]
}) {
  const [row] = await getDb()
    .insert(ingress)
    .values({
      deliveryId: `d-${++seeded}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'c',
      reason: 'r',
    })
    .returning()
  const [created] = await getDb()
    .insert(task)
    .values({
      ingressId: row.id,
      repository: 'o/r',
      issueNumber: 40 + seeded,
      issueTitle: 'title',
      stage: input.stage ?? 'done',
      mergedSha: 'merged',
    })
    .returning()
  for (const e of input.events) {
    await getDb()
      .insert(stageEvent)
      .values({
        taskId: created.id,
        stage: e.stage as never,
        detail: e.detail ?? null,
        at: at(e.minute),
      })
  }
  for (const c of input.checks ?? []) {
    await getDb()
      .insert(evidence)
      .values({
        taskId: created.id,
        ...c,
        exitCode: 0,
        timedOut: false,
        passed: true,
        output: '',
        durationMs: 1,
      })
  }
  return created.id
}

const straightRun = (start: number) => [
  { stage: 'sandbox', minute: start },
  { stage: 'verify', minute: start + 5, detail: { sha: 'first', attempt: 1 } },
  { stage: 'verify', minute: start + 9, detail: { sha: 'second', attempt: 2 } },
  { stage: 'done', minute: start + 12, detail: { costUsd: 0.42, attempts: 2 } },
]

describe('deliveredCandidates', () => {
  it('reads the last run of a delivered task: its first commit, cost, attempts, duration and checks', async () => {
    const id = await seedTask({
      events: [{ stage: 'sandbox', minute: -60 }, ...straightRun(0)],
      checks: [
        { name: 'install', command: 'pnpm i', sha: 'first' },
        { name: 'tests', command: 'pnpm test', sha: 'first' },
        { name: 'tests', command: 'pnpm test', sha: 'first' },
        { name: 'tests', command: 'pnpm test', sha: 'second' },
      ],
    })

    const [found] = await deliveredCandidates(getDb())

    expect(found).toEqual({
      taskId: id,
      repository: 'o/r',
      issueNumber: expect.any(Number),
      firstSha: 'first',
      mergedSha: 'merged',
      costUsd: 0.42,
      durationMs: 12 * 60_000,
      attempts: 2,
      checks: [
        { name: 'install', command: 'pnpm i' },
        { name: 'tests', command: 'pnpm test' },
      ],
    })
  })

  it('leaves out a task that is not delivered and a run resumed after a question', async () => {
    await seedTask({ stage: 'failed', events: straightRun(0) })
    await seedTask({
      events: [
        { stage: 'sandbox', minute: 0 },
        { stage: 'build', minute: 1, detail: { resumed: true } },
        ...straightRun(2).slice(1),
      ],
    })

    expect(await deliveredCandidates(getDb())).toEqual([])
  })
})

describe('toCase', () => {
  it('starts the case from the parent of the first commit, with the issue as it reads now', async () => {
    const asked: string[] = []
    const made = await toCase(
      {
        taskId: 3,
        repository: 'o/r',
        issueNumber: 9,
        firstSha: 'f'.repeat(40),
        mergedSha: 'm',
        costUsd: 0.4,
        durationMs: 60_000,
        attempts: 1,
        checks: [{ name: 'tests', command: 'pnpm test' }],
      },
      {
        issue: async (repo, n) => {
          asked.push(`${repo}#${n}`)
          return { title: 'Fix it', body: 'Broken', labels: ['factory', 'bug'] }
        },
        parentOf: async (_repo, sha) => (sha === 'f'.repeat(40) ? 'b'.repeat(40) : 'wrong'),
        config: async () => ({ integrationBranch: 'workspace', egress: ['example.org'] }),
      },
    )

    expect(asked).toEqual(['o/r#9'])
    expect(made).toEqual({
      id: 'o/r#9',
      repository: 'o/r',
      issueNumber: 9,
      title: 'Fix it',
      body: 'Broken',
      labels: ['factory', 'bug'],
      kind: 'bug',
      integrationBranch: 'workspace',
      baseSha: 'b'.repeat(40),
      checks: [{ name: 'tests', command: 'pnpm test' }],
      egress: ['example.org'],
      original: { taskId: 3, costUsd: 0.4, durationMs: 60_000, attempts: 1, mergedSha: 'm' },
    })
  })
})
