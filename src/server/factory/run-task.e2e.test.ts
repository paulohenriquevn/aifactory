import { readFileSync } from 'node:fs'

import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, stageEvent, task } from '../db/schema'
import { createGithubApp } from '../github/app'
import { deletePreReleases, resetIntegrationBranches } from '../../test/playground'

import type { CodingHarness } from './harness'
import { runTask } from './run-task'
import { vercelSandboxProvider } from './vercel-sandbox'

// Runs the whole pipeline against the real services, with a scripted agent in place of Claude:
// the GitHub App token, the Vercel Sandbox and its firewall, a clone and a push of a private
// repository, and the stage history in Postgres. `pnpm test:e2e` fails fast when a credential is
// missing, because a skipped suite reads as a passing one.
const REPO = 'paulohenriquevn/aifactory-playground'
const ISSUE = 1

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set (see .env.local)`)
  return value
}

const github = createGithubApp({
  appId: required('GITHUB_APP_ID'),
  privateKey: readFileSync(required('GITHUB_APP_PRIVATE_KEY_PATH'), 'utf8'),
})

/** The issue asks for `truncate(text, max)`; this plays the agent that writes it. */
const scriptedAgent: CodingHarness = {
  name: 'scripted-agent',
  egress: async () => [],
  async run(backend, { cwd }) {
    await backend.uploadFile(
      `${cwd}/src/truncate.js`,
      `/** Cuts text to max characters, ending with an ellipsis when it was cut. */
export function truncate(text, max) {
  if (max < 1) throw new RangeError('max must be at least 1')
  return text.length <= max ? text : \`\${text.slice(0, max - 1)}…\`
}
`,
    )
    await backend.uploadFile(
      `${cwd}/src/truncate.test.js`,
      `import assert from 'node:assert/strict'
import { test } from 'node:test'

import { truncate } from './truncate.js'

test('leaves short text alone', () => assert.equal(truncate('abc', 5), 'abc'))
test('cuts long text to exactly max characters', () => assert.equal(truncate('abcdef', 4), 'abc…'))
test('rejects max below 1', () => assert.throws(() => truncate('abc', 0), RangeError))
`,
    )
    const tests = await backend.execute(`cd ${cwd} && npm test 2>&1 | tail -12`)
    return { ok: tests.exitCode === 0, summary: tests.stdout.trim() }
  },
}

/** The reviewer: reads nothing and approves, so the pipeline's real services are what is tested. */
const scriptedReviewer: CodingHarness = {
  name: 'scripted-reviewer',
  egress: async () => [],
  run: async () => ({
    ok: true,
    summary: JSON.stringify({ verdict: 'approve', summary: 'scripted approval', findings: [] }),
  }),
}

async function deleteBranch(branch: string) {
  const { token } = await github.installationToken(REPO)
  await deletePreReleases(token, REPO, ISSUE)
  await resetIntegrationBranches(token, REPO)
  await fetch(`https://api.github.com/repos/${REPO}/git/refs/heads/${branch}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  })
}

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  await getPool().query('truncate table stage_event, task, ingress restart identity cascade')
  await deleteBranch(`factory/${ISSUE}`)
})
afterAll(async () => {
  await deleteBranch(`factory/${ISSUE}`)
  await getStorageManager().dispose()
})

describe('the factory against the real services', () => {
  it('turns issue #1 into a pushed factory/1 branch, with the stages recorded in order', async () => {
    const db = getDb()
    const [delivery] = await db
      .insert(ingress)
      .values({
        deliveryId: 'e2e-1',
        event: 'issues',
        payload: {},
        outcome: 'task_created',
        code: 'issue_labeled',
        reason: 'e2e',
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
        github,
        sandbox: vercelSandboxProvider(),
        harness: scriptedAgent,
        reviewer: scriptedReviewer,
        author: {
          name: 'aifactory-paulohenriquevn[bot]',
          email: 'aifactory@users.noreply.github.com',
        },
      },
      created.id,
    )

    expect(result).toMatchObject({ status: 'done', branch: 'factory/1' })
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

    // The factory merged the pull request into workspace and advanced develop, so the agent's change is on
    // both, and the branch the agent worked on is gone.
    const { token } = await github.installationToken(REPO)
    const api = (path: string) =>
      fetch(`https://api.github.com/repos/${REPO}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      }).then((r) => r.json())
    const onWorkspace = (await api('/contents/src/truncate.js?ref=workspace')) as { name: string }
    const onDevelop = (await api('/contents/src/truncate.js?ref=develop')) as { name: string }
    expect(onWorkspace.name).toBe('truncate.js')
    expect(onDevelop.name).toBe('truncate.js')
    const onMain = (await api('/contents/src/truncate.js?ref=main')) as { message?: string }
    expect(onMain.message).toBe('Not Found') // only a release reaches the default branch
    const gone = (await api('/git/ref/heads/factory/1')) as { message?: string }
    expect(gone.message).toBe('Not Found')

    // The factory ran the tests on the commit it pushed, said so as a check run, and opened the pull
    // request against workspace, which it then merged.
    const sha = result.status === 'done' ? result.sha : ''
    const checks = (await api(`/commits/${sha}/check-runs`)) as {
      check_runs: { name: string; conclusion: string }[]
    }
    expect(checks.check_runs).toContainEqual(
      expect.objectContaining({ name: 'aifactory/verify', conclusion: 'success' }),
    )
    const pulls = (await api('/pulls?state=all&head=paulohenriquevn:factory/1')) as {
      html_url: string
      head: { sha: string }
      base: { ref: string }
      merged_at: string | null
      body: string
    }[]
    // The playground keeps the pull requests of earlier runs, so this one is found by its commit.
    const mine = pulls.filter((p) => p.head.sha === sha)
    expect(mine).toHaveLength(1)
    expect(mine[0].base.ref).toBe('workspace')
    expect(mine[0].merged_at).not.toBeNull()
    expect(mine[0].html_url).toBe(result.status === 'done' ? result.pullRequestUrl : '')
    expect(mine[0].body).toContain('Closes #1')

    // The pre-release is a tag on the commit develop is at now.
    const developHead = (await api('/git/ref/heads/develop')) as { object: { sha: string } }
    const releases = (await api('/releases?per_page=30')) as {
      tag_name: string
      prerelease: boolean
    }[]
    expect(releases).toContainEqual(
      expect.objectContaining({
        tag_name: `pre/1-${developHead.object.sha.slice(0, 7)}`,
        prerelease: true,
      }),
    )

    const [row] = await db
      .select()
      .from(task)
      .where(and(eq(task.id, created.id)))
    expect(row.stage).toBe('done')
    expect(row.mergedSha).not.toBeNull()
  })
})
