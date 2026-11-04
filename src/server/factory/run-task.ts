import { provisionRepo, type SandboxBackend } from '@theokit/agents/sandbox'
import { asc, eq } from 'drizzle-orm'

import type { Database } from '../db'
import { evidence, task } from '../db/schema'
import type { FetchLike, GithubApp } from '../github/app'
import { fetchIssue as defaultFetchIssue, type Issue } from '../github/issues'
import { createGithubApi, type GithubApi } from '../github/pulls'

import { DEFAULT_CHECKS, gate, runChecks, type CheckResult, type CheckSpec } from './evidence'
import { buildPrompt, type CodingHarness } from './harness'
import {
  createIsolatedSandbox,
  type IsolatedSandbox,
  type IsolatedSandboxProvider,
} from './sandbox'
import { enterStage } from './stages'

export type RunTaskDeps = {
  db: Database
  github: GithubApp
  sandbox: IsolatedSandboxProvider
  /** One agent for every task, or a function that chooses it from the issue's labels. */
  harness: CodingHarness | ((labels: string[]) => CodingHarness)
  /** The commit author, so the pull request shows who wrote it. */
  author: { name: string; email: string }
  fetchIssue?: (repo: string, number: number, token: string, fetch?: FetchLike) => Promise<Issue>
  githubApi?: GithubApi
  /** What must pass on the pushed commit before a pull request opens. */
  checks?: CheckSpec[]
  timeouts?: { sandboxMs: number; agentMs: number; checkMs?: number }
  /** Wait between push attempts. */
  pushRetryDelayMs?: number
}

export type RunResult =
  | { status: 'done'; branch: string; sha: string; pullRequestUrl: string; summary: string }
  | { status: 'failed'; stage: string; error: string }

const INSTANCE = 'work'
const GITCONFIG = '/tmp/factory.gitconfig'
const COMMIT_MESSAGE = '/tmp/factory-commit-message.txt'

/** Thrown inside a stage so the run can report which stage failed. */
class StageFailure extends Error {}

/** The agent's account is out of quota. It is recorded as such, because waiting fixes it. */
class QuotaStop extends StageFailure {
  constructor(
    message: string,
    readonly resetsAt?: string,
  ) {
    super(message)
  }
}

/**
 * Runs one task: reads the issue, starts an isolated sandbox, has the agent implement it, pushes
 * the result to `factory/<issue>`, runs the checks on the pushed commit, and opens a pull request
 * only if the evidence for that commit is green. Each stage is recorded as the run enters it. The
 * sandbox is always stopped, and a failure is recorded as the `failed` stage with its reason.
 */
export async function runTask(
  deps: RunTaskDeps,
  taskId: number,
  /** Aborts when the job's lease expires: the sandbox is stopped so the run does not outlive it. */
  signal?: AbortSignal,
): Promise<RunResult> {
  const { db } = deps
  const [row] = await db.select().from(task).where(eq(task.id, taskId))
  if (!row) throw new Error(`task ${taskId} does not exist`)

  const timeouts = deps.timeouts ?? { sandboxMs: 30 * 60_000, agentMs: 25 * 60_000 }
  const branch = `factory/${row.issueNumber}`
  let current = 'sandbox'
  let sandbox: IsolatedSandbox | undefined

  try {
    await enterStage(db, taskId, 'sandbox', { provider: deps.sandbox.name })

    // One token, limited to this task's repository. It is used here and in the firewall rule,
    // and nothing below hands it to the sandbox.
    const { token } = await deps.github.installationToken(row.repository)
    const issue = await (deps.fetchIssue ?? defaultFetchIssue)(
      row.repository,
      row.issueNumber,
      token,
    )

    // The agent comes from the issue's labels, and signs its own calls: its secret is read here, on
    // the host, and becomes a firewall rule, so the sandbox never holds one.
    const harness =
      typeof deps.harness === 'function' ? deps.harness(issue.labels ?? []) : deps.harness
    const agentEgress = await harness.egress()

    sandbox = await createIsolatedSandbox(deps.sandbox, {
      timeoutMs: timeouts.sandboxMs,
      egress: [
        {
          domain: 'github.com',
          headers: {
            authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
          },
        },
        ...agentEgress,
        { domain: 'registry.npmjs.org' },
      ],
    })
    const { backend } = sandbox
    const running = sandbox
    signal?.addEventListener('abort', () => void running.stop().catch(() => {}), { once: true })

    // The SDK's provisioner clones with `--` and the `ext::` transport off. `HEAD` is the
    // repository's default branch, so the factory does not need to know its name.
    const { repoDir } = await provisionRepo(backend, {
      repoUrl: `https://github.com/${row.repository}.git`,
      ref: 'HEAD',
      instanceId: INSTANCE,
    })
    await must(backend, `git -C ${repoDir} checkout -b ${branch}`)
    await harness.prepare?.(backend)

    current = 'build'
    await enterStage(db, taskId, 'build', { harness: harness.name })
    const result = await harness.run(backend, {
      cwd: repoDir,
      timeoutMs: timeouts.agentMs,
      prompt: buildPrompt({
        repo: row.repository,
        issueNumber: row.issueNumber,
        title: issue.title,
        body: issue.body,
        branch,
      }),
    })
    if (result.quota) {
      throw new QuotaStop(
        `the ${harness.name} quota ran out${result.quota.resetsAt ? `, resets ${result.quota.resetsAt}` : ''}: ${result.quota.message}`,
        result.quota.resetsAt,
      )
    }
    if (!result.ok) throw new StageFailure(`the agent did not finish: ${result.summary}`)

    current = 'push'
    await enterStage(db, taskId, 'push', {
      branch,
      costUsd: result.costUsd,
      agentSummary: result.summary,
      sessionId: result.sessionId,
    })
    const changes = await must(backend, `git -C ${repoDir} status --porcelain`)
    if (changes.stdout.trim() === '') {
      throw new StageFailure('the agent made no change to the repository')
    }
    // Text that came from outside (the issue title, the author) goes in by file, so none of it is
    // ever parsed by a shell (the SDK does not export its quoting helper: usetheokit/theokit#1131).
    await backend.uploadFile(GITCONFIG, gitConfig(deps.author))
    await backend.uploadFile(COMMIT_MESSAGE, `${oneLine(issue.title)} (#${row.issueNumber})\n`)
    const git = `GIT_CONFIG_GLOBAL=${GITCONFIG} git -C ${repoDir}`
    await must(backend, `${git} add -A`)
    await must(backend, `${git} commit -F ${COMMIT_MESSAGE}`)
    // What is about to leave the sandbox, kept so a refused push can be explained.
    const files = (await must(backend, `${git} diff --name-status HEAD~1 HEAD`)).stdout.trim()
    try {
      await pushWithRetry(backend, `${git} push origin ${branch}`, deps.pushRetryDelayMs ?? 2_000)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new StageFailure(`${reason}\ncommit being pushed:\n${files.slice(0, 1500)}`)
    }
    const sha = (await must(backend, `${git} rev-parse HEAD`)).stdout.trim()

    current = 'verify'
    const checks = deps.checks ?? DEFAULT_CHECKS
    await enterStage(
      db,
      taskId,
      'verify',
      { sha, checks: checks.map((c) => c.name) },
      { headSha: sha },
    )
    // The checks must run on the commit that was pushed and nothing else.
    const head = (await must(backend, `git -C ${repoDir} rev-parse HEAD`)).stdout.trim()
    const dirty = (await must(backend, `git -C ${repoDir} status --porcelain`)).stdout.trim()
    if (head !== sha || dirty !== '') {
      throw new StageFailure(`the checkout is not the pushed commit ${sha.slice(0, 7)}`)
    }
    const api = deps.githubApi ?? createGithubApi()
    for (const check of await runChecks(
      backend,
      repoDir,
      checks,
      timeouts.checkMs ?? 10 * 60_000,
    )) {
      await db.insert(evidence).values({ taskId, sha, ...check })
    }
    const rows = await db
      .select()
      .from(evidence)
      .where(eq(evidence.taskId, taskId))
      .orderBy(asc(evidence.id))
    const verdict = gate({ headSha: sha, required: checks.map((c) => c.name), evidence: rows })
    await api.createCheckRun(row.repository, token, {
      name: 'aifactory/verify',
      headSha: sha,
      conclusion: verdict.open ? 'success' : 'failure',
      title: verdict.open ? 'All checks passed' : 'Checks did not pass',
      summary: checkSummary(rows.filter((r) => r.sha === sha)),
    })
    if (!verdict.open) {
      throw new StageFailure(`no pull request: ${verdict.reasons.join('; ')}`)
    }

    current = 'pr'
    await enterStage(db, taskId, 'pr', { branch, sha })
    const pull = await api.openPullRequest(row.repository, token, {
      head: branch,
      title: `${oneLine(issue.title)} (#${row.issueNumber})`,
      body: pullRequestBody(
        row.issueNumber,
        sha,
        rows.filter((r) => r.sha === sha),
        result.summary,
      ),
    })

    await enterStage(
      db,
      taskId,
      'done',
      { branch, sha, pullRequestUrl: pull.url, costUsd: result.costUsd },
      { pullRequestUrl: pull.url },
    )
    return { status: 'done', branch, sha, pullRequestUrl: pull.url, summary: result.summary }
  } catch (error) {
    const message = signal?.aborted
      ? 'the job lease expired before the run finished'
      : error instanceof Error
        ? error.message
        : String(error)
    await enterStage(db, taskId, 'failed', {
      failedAt: current,
      error: message,
      ...(error instanceof QuotaStop ? { quota: true, resetsAt: error.resetsAt } : {}),
    })
    return { status: 'failed', stage: current, error: message }
  } finally {
    await sandbox?.stop().catch(() => {})
  }
}

const PUSH_ATTEMPTS = 3

/**
 * Pushes the same commit up to three times. GitHub now and then answers a push with an internal
 * `fatal error in commit_refs` that a second try does not repeat (seen once in three live pushes), and
 * the push is idempotent: it sends one commit to one branch the run created. Only the push is retried.
 */
async function pushWithRetry(backend: SandboxBackend, command: string, delayMs: number) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await must(backend, command)
    } catch (error) {
      if (attempt >= PUSH_ATTEMPTS) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

async function must(backend: SandboxBackend, command: string) {
  const result = await backend.execute(command)
  if (result.exitCode !== 0) {
    const output = (result.stderr || result.stdout).trim().slice(-500)
    throw new StageFailure(`\`${command}\` exited ${result.exitCode}: ${output}`)
  }
  return result
}

type StoredCheck = Pick<CheckResult, 'name' | 'command' | 'passed' | 'durationMs' | 'output'>

function checkSummary(rows: StoredCheck[]): string {
  return rows
    .map((r) => `- ${r.passed ? 'passed' : 'failed'}: \`${r.command}\` (${seconds(r.durationMs)})`)
    .join('\n')
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

function pullRequestBody(
  issueNumber: number,
  sha: string,
  rows: StoredCheck[],
  agentSummary: string,
): string {
  return [
    `Closes #${issueNumber}`,
    '',
    `Checks the factory ran on \`${sha.slice(0, 7)}\`:`,
    '',
    checkSummary(rows),
    '',
    '<details><summary>What the agent said</summary>',
    '',
    agentSummary.slice(0, 3_000),
    '',
    '</details>',
    '',
  ].join('\n')
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The commit identity as a git config file. Newlines would start a new setting, so refuse them. */
function gitConfig(author: { name: string; email: string }): string {
  if (/[\r\n]/.test(author.name + author.email)) {
    throw new StageFailure('the commit author must be a single line')
  }
  return `[user]\n\tname = ${author.name}\n\temail = ${author.email}\n`
}
