import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, stageEvent, task } from '../db/schema'
import { createGithubApp } from '../github/app'

import { DEFAULT_HARNESS, harnessRegistry, pickHarness } from './harness-registry'
import { runTask } from './run-task'
import { vercelSandboxProvider } from './vercel-sandbox'

// The real thing: Claude Code inside a Vercel Sandbox, with the Anthropic key and the GitHub token
// attached by the firewall, implementing issue #1 of the playground. It costs money (the agent bills
// per token), so it only runs with FACTORY_LIVE=1: `FACTORY_LIVE=1 pnpm test:e2e -t live`.
const live = process.env.FACTORY_LIVE === '1'
const REPO = 'paulohenriquevn/aifactory-playground'
const ISSUE = 1

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set (see .env.local)`)
  return value
}

describe.skipIf(!live)('the factory with the real agent', () => {
  const github = live
    ? createGithubApp({
        appId: required('GITHUB_APP_ID'),
        privateKey: readFileSync(required('GITHUB_APP_PRIVATE_KEY_PATH'), 'utf8'),
      })
    : undefined

  async function api(path: string, init: RequestInit = {}) {
    const { token } = await github!.installationToken(REPO)
    return fetch(`https://api.github.com/repos/${REPO}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    })
  }
  const deleteBranch = () => api(`/git/refs/heads/factory/${ISSUE}`, { method: 'DELETE' })

  beforeAll(async () => {
    getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
    await migrate(getDb(), { migrationsFolder: 'drizzle' })
    await getPool().query('truncate table stage_event, task, ingress restart identity cascade')
    await deleteBranch()
  })
  afterAll(async () => {
    await deleteBranch()
    await getStorageManager().dispose()
  })

  it('implements issue #1, pushes factory/1, and what it pushed passes its own tests outside the sandbox', async () => {
    const db = getDb()
    const [delivery] = await db
      .insert(ingress)
      .values({
        deliveryId: 'live-1',
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
        issueNumber: ISSUE,
        issueTitle: 'Add a truncate(text, max) helper',
      })
      .returning({ id: task.id })

    const result = await runTask(
      {
        db,
        github: github!,
        sandbox: vercelSandboxProvider(),
        harness: (labels) =>
          pickHarness(
            harnessRegistry(process.env),
            process.env.FACTORY_HARNESS ?? DEFAULT_HARNESS,
            labels,
          ),
        author: {
          name: 'aifactory-paulohenriquevn[bot]',
          email: 'aifactory@users.noreply.github.com',
        },
      },
      created.id,
    )
    console.log(
      JSON.stringify({
        event: 'live_run',
        ...result,
        summary: result.status === 'done' ? result.summary.slice(0, 400) : undefined,
      }),
    )
    expect(result).toMatchObject({ status: 'done', branch: 'factory/1' })
    expect(result.status === 'done' && result.pullRequestUrl).toMatch(/\/pull\/\d+$/)

    const events = await db
      .select()
      .from(stageEvent)
      .where(eq(stageEvent.taskId, created.id))
      .orderBy(stageEvent.id)
    expect(events.map((e) => e.stage)).toEqual([
      'sandbox',
      'build',
      'push',
      'verify',
      'review',
      'pr',
      'done',
    ])
    const done = events.at(-1)!.detail as { costUsd?: number }
    console.log(JSON.stringify({ event: 'live_cost', costUsd: done.costUsd }))

    // The factory checks the work itself: the files the agent pushed, run here, outside the sandbox.
    const ref = (await (await api('/git/ref/heads/factory/1')).json()) as {
      object: { sha: string }
    }
    expect(ref.object.sha).toBe(result.status === 'done' ? result.sha : '')
    const tree = (await (await api(`/git/trees/${ref.object.sha}?recursive=1`)).json()) as {
      tree: { path: string; type: string }[]
    }
    const paths = tree.tree.filter((e) => e.type === 'blob').map((e) => e.path)
    expect(paths).toEqual(expect.arrayContaining(['src/truncate.js', 'src/truncate.test.js']))

    const dir = mkdtempSync(join(tmpdir(), 'factory-verify-'))
    try {
      for (const path of paths.filter((p) => p.endsWith('.js') || p === 'package.json')) {
        const file = (await (await api(`/contents/${path}?ref=${ref.object.sha}`)).json()) as {
          content: string
        }
        const target = join(dir, path)
        execFileSync('/bin/mkdir', ['-p', join(target, '..')])
        writeFileSync(target, Buffer.from(file.content, 'base64'))
      }
      const output = execFileSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8' })
      expect(output).toMatch(/# fail 0/)
      // Every test from the seed project plus the ones the agent added.
      expect(Number(/# tests (\d+)/.exec(output)?.[1])).toBeGreaterThan(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 1_700_000)
  it('sends the work back to the same Claude Code session when the reviewer asks for a change', async () => {
    const db = getDb()
    await getPool().query(
      'truncate table review, evidence, stage_event, task, ingress restart identity cascade',
    )
    await deleteBranch()
    const [delivery] = await db
      .insert(ingress)
      .values({
        deliveryId: 'live-rework',
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
        issueNumber: ISSUE,
        issueTitle: 'Add a truncate(text, max) helper',
      })
      .returning({ id: task.id })

    // The reviewer is scripted so the change it asks for is known; the builder is the real agent.
    const answers = [
      {
        verdict: 'changes',
        summary: 'One case is not tested.',
        findings: [
          {
            severity: 'major',
            file: 'src/truncate.test.js',
            issue:
              "Add a test named 'returns text unchanged when it is exactly max long' for truncate('abcde', 5).",
          },
        ],
      },
      { verdict: 'approve', summary: 'The missing test is there.', findings: [] },
    ]
    let asked = 0
    const reviewer = {
      name: 'scripted-reviewer',
      egress: async () => [],
      run: async () => ({ ok: true, summary: JSON.stringify(answers[Math.min(asked++, 1)]) }),
    }

    const result = await runTask(
      {
        db,
        github: github!,
        sandbox: vercelSandboxProvider(),
        harness: (labels) =>
          pickHarness(
            harnessRegistry(process.env),
            process.env.FACTORY_HARNESS ?? DEFAULT_HARNESS,
            labels,
          ),
        reviewer,
        author: {
          name: 'aifactory-paulohenriquevn[bot]',
          email: 'aifactory@users.noreply.github.com',
        },
      },
      created.id,
    )
    console.log(JSON.stringify({ event: 'live_rework', status: result.status }))
    expect(result).toMatchObject({ status: 'done' })

    const events = await db
      .select()
      .from(stageEvent)
      .where(eq(stageEvent.taskId, created.id))
      .orderBy(stageEvent.id)
    expect(events.map((e) => e.stage)).toEqual([
      'sandbox',
      'build',
      'push',
      'verify',
      'review',
      'build',
      'push',
      'verify',
      'review',
      'pr',
      'done',
    ])
    // Two commits on the branch, the second made by the resumed session, and the test exists.
    const commits = (await (await api('/commits?sha=factory/1&per_page=5')).json()) as {
      sha: string
      commit: { message: string }
    }[]
    expect(commits[0].commit.message).toContain('address feedback')
    const file = (await (await api('/contents/src/truncate.test.js?ref=factory/1')).json()) as {
      content: string
    }
    expect(Buffer.from(file.content, 'base64').toString()).toContain('exactly max long')
  }, 1_700_000)
})
