import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getDb, getPool } from '../db'
import { storageFromEnv } from '../db/config'
import { ingress, question, stageEvent, task } from '../db/schema'
import { createGithubApp } from '../github/app'
import { deletePreReleases } from '../../test/playground'
import { createGithubApi } from '../github/pulls'

import { DEFAULT_HARNESS, harnessRegistry, pickHarness } from './harness-registry'
import { resumeTask, runTask } from './run-task'
import { vercelSandboxProvider } from './vercel-sandbox'
import { pollAnswers } from './waiting'

// The whole round trip, for real: Claude Code is told to ask before it writes anything, the sandbox is
// snapshotted on Vercel, the question goes to a GitHub issue, a person answers it (the `gh` login of
// the repository owner), the answer is found by the poller, and the same Claude session resumes in
// a sandbox restored from the snapshot and finishes the work. Opt in with FACTORY_LIVE=1.
const live = process.env.FACTORY_LIVE === '1'
const REPO = 'paulohenriquevn/aifactory-playground'

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set (see .env.local)`)
  return value
}

describe.skipIf(!live)('a task that waits for an answer, with the real agent', () => {
  const github = live
    ? createGithubApp({
        appId: required('GITHUB_APP_ID'),
        privateKey: readFileSync(required('GITHUB_APP_PRIVATE_KEY_PATH'), 'utf8'),
      })
    : undefined
  let issueNumber = 0

  async function app(path: string, init: RequestInit = {}) {
    const { token } = await github!.installationToken(REPO)
    return fetch(`https://api.github.com/repos/${REPO}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    })
  }

  beforeAll(async () => {
    getStorageManager().configure(storageFromEnv()!)
    await migrate(getDb(), { migrationsFolder: 'drizzle' })
    await getPool().query(
      'truncate table question, review, evidence, stage_event, task, ingress restart identity cascade',
    )
    const created = await app('/issues', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Add a clamp(n, min, max) helper',
        body: 'Add `clamp(n, min, max)` to `src/clamp.js`, with tests.\n\nThe issue does not say what clamp should do when min is greater than max. Do not guess: ask which behavior is wanted before you write any code.',
      }),
    })
    issueNumber = ((await created.json()) as { number: number }).number
  })
  afterAll(async () => {
    await app(`/git/refs/heads/factory/${issueNumber}`, { method: 'DELETE' })
    await deletePreReleases((await github!.installationToken(REPO)).token, REPO, issueNumber)
    await app(`/issues/${issueNumber}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    })
    await getStorageManager().dispose()
  })

  it('asks, waits across a snapshot, takes the answer and finishes the pull request', async () => {
    const db = getDb()
    const [delivery] = await db
      .insert(ingress)
      .values({
        deliveryId: 'live-waiting',
        event: 'issues',
        payload: {},
        outcome: 'task_created',
        code: 'issue_labeled',
        reason: 'live',
      })
      .returning({ id: ingress.id })
    const [created] = await db
      .insert(task)
      .values({
        ingressId: delivery.id,
        repository: REPO,
        issueNumber,
        issueTitle: 'Add a clamp(n, min, max) helper',
      })
      .returning({ id: task.id })
    const sandbox = vercelSandboxProvider()
    const deps = {
      db,
      github: github!,
      sandbox,
      harness: (labels: string[]) =>
        pickHarness(
          harnessRegistry(process.env),
          process.env.FACTORY_HARNESS ?? DEFAULT_HARNESS,
          labels,
        ),
      author: {
        name: 'aifactory-paulohenriquevn[bot]',
        email: 'aifactory@users.noreply.github.com',
      },
    }

    const parked = await runTask(deps, created.id)
    console.log(
      JSON.stringify({
        event: 'live_waiting',
        status: parked.status,
        question: parked.status === 'waiting' ? parked.question.slice(0, 300) : undefined,
      }),
    )
    expect(parked.status).toBe('waiting')
    const [asked] = await db.select().from(question).where(eq(question.taskId, created.id))
    expect(asked.sessionId).toMatch(/^[0-9a-f-]{36}$/)

    // The factory's own comment is on the issue.
    const comments = (await (await app(`/issues/${issueNumber}/comments`)).json()) as {
      id: number
      body: string
    }[]
    expect(
      comments.some(
        (c) => String(c.id) === asked.commentId && c.body.includes('aifactory:question'),
      ),
    ).toBe(true)

    // A person answers: the owner's own login, through `gh`.
    const owner = execFileSync('gh', ['auth', 'token', '--user', 'paulohenriquevn'], {
      encoding: 'utf8',
    }).trim()
    const reply = await fetch(
      `https://api.github.com/repos/${REPO}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${owner}`, accept: 'application/vnd.github+json' },
        body: JSON.stringify({ body: 'Throw a RangeError when min is greater than max.' }),
      },
    )
    expect(reply.status).toBe(201)

    const queued: number[] = []
    const polled = await pollAnswers({
      db,
      github: github!,
      api: createGithubApi(),
      inTransaction: (work) =>
        db.transaction((tx) =>
          work(tx as never, async (_t, questionId) => void queued.push(questionId)),
        ),
      deleteSnapshot: (id) => sandbox.deleteSnapshot!(id),
      ttlMs: 7 * 86_400_000,
    })
    expect(polled.answered).toHaveLength(1)

    const result = await resumeTask(deps, created.id)
    console.log(
      JSON.stringify({
        event: 'live_resumed',
        status: result.status,
        pr: result.status === 'done' ? result.pullRequestUrl : undefined,
      }),
    )
    expect(result).toMatchObject({ status: 'done' })

    const stages = (
      await db
        .select()
        .from(stageEvent)
        .where(eq(stageEvent.taskId, created.id))
        .orderBy(stageEvent.id)
    ).map((e) => e.stage)
    expect(stages.slice(0, 3)).toEqual(['sandbox', 'build', 'waiting'])
    expect(stages.at(-1)).toBe('done')

    // The answer shaped the work: the file exists and it throws on an inverted range.
    const file = (await (
      await app(`/contents/src/clamp.js?ref=factory/${issueNumber}`)
    ).json()) as { content: string }
    expect(Buffer.from(file.content, 'base64').toString()).toMatch(/RangeError/)
  }, 1_700_000)
})
