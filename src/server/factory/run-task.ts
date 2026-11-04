import { provisionRepo, type SandboxBackend } from '@theokit/agents/sandbox'
import { asc, eq } from 'drizzle-orm'

import type { Database } from '../db'
import { evidence, review as reviewTable, task } from '../db/schema'
import type { FetchLike, GithubApp } from '../github/app'
import { fetchIssue as defaultFetchIssue, type Issue } from '../github/issues'
import { createGithubApi, type GithubApi } from '../github/pulls'

import { DEFAULT_CHECKS, gate, runChecks, type CheckResult, type CheckSpec } from './evidence'
import { diffGuards, parseNameStatus, testScriptOf } from './guards'
import { buildPrompt, type CodingHarness, type HarnessResult } from './harness'
import {
  MAX_ATTEMPTS,
  parseVerdict,
  renderFindings,
  reviewPrompt,
  reworkPrompt,
  type Finding,
  type ReviewVerdict,
} from './review'
import {
  createIsolatedSandbox,
  type EgressRule,
  type IsolatedSandbox,
  type IsolatedSandboxProvider,
} from './sandbox'
import { enterStage } from './stages'

type HarnessChoice = CodingHarness | ((labels: string[]) => CodingHarness)

export type RunTaskDeps = {
  db: Database
  github: GithubApp
  sandbox: IsolatedSandboxProvider
  /** One agent for every task, or a function that chooses it from the issue's labels. */
  harness: HarnessChoice
  /**
   * The independent reviewer. A function may return nothing, and the builder then reviews its own
   * work in a fresh session, which is weaker: set a different agent for a real second opinion.
   */
  reviewer?: CodingHarness | ((labels: string[]) => CodingHarness | undefined)
  /** The commit author, so the pull request shows who wrote it. */
  author: { name: string; email: string }
  fetchIssue?: (repo: string, number: number, token: string, fetch?: FetchLike) => Promise<Issue>
  githubApi?: GithubApi
  /** What must pass on the pushed commit before a pull request opens. */
  checks?: CheckSpec[]
  timeouts?: { sandboxMs: number; agentMs: number; checkMs?: number; reviewMs?: number }
  /** Wait between push attempts. */
  pushRetryDelayMs?: number
}

export type RunResult =
  | { status: 'done'; branch: string; sha: string; pullRequestUrl: string; summary: string }
  | { status: 'handoff'; branch: string; sha: string; pullRequestUrl: string; reason: string }
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
 * the result to `factory/<issue>`, runs the checks on the pushed commit and has an independent
 * reviewer read it. Checks that fail or a review that asks for changes send the work back to the
 * same agent session, up to three attempts. A pull request opens only on green evidence for the
 * pushed commit plus an approval; when attempts run out after green checks, a draft pull request
 * and a comment on the issue hand the work to a person. Each stage is recorded as the run enters
 * it, the sandbox is always stopped, and a failure is recorded as `failed` with its reason.
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
    const labels = issue.labels ?? []

    // The agents come from the issue's labels, and each signs its own calls: its secret is read
    // here, on the host, and becomes a firewall rule, so the sandbox never holds one.
    const builder = typeof deps.harness === 'function' ? deps.harness(labels) : deps.harness
    const chosen = typeof deps.reviewer === 'function' ? deps.reviewer(labels) : deps.reviewer
    const reviewer = chosen ?? builder
    const agents = reviewer.name === builder.name ? [builder] : [builder, reviewer]
    const agentEgress = mergeEgress(await Promise.all(agents.map((a) => a.egress())))

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
    const git = `GIT_CONFIG_GLOBAL=${GITCONFIG} git -C ${repoDir}`
    const baseSha = (await must(backend, `git -C ${repoDir} rev-parse HEAD`)).stdout.trim()
    await must(backend, `git -C ${repoDir} checkout -b ${branch}`)
    for (const agent of agents) await agent.prepare?.(backend)

    const api = deps.githubApi ?? createGithubApi()
    const checks = deps.checks ?? DEFAULT_CHECKS
    const title = `${oneLine(issue.title)} (#${row.issueNumber})`
    let cost = 0
    let summary = ''
    let sessionId: string | undefined

    /** Runs the agent, books its cost and session, and turns a quota stop or a failure into an error. */
    const settle = (result: HarnessResult, who: CodingHarness): HarnessResult => {
      cost += result.costUsd ?? 0
      if (result.quota) {
        throw new QuotaStop(
          `the ${who.name} quota ran out${result.quota.resetsAt ? `, resets ${result.quota.resetsAt}` : ''}: ${result.quota.message}`,
          result.quota.resetsAt,
        )
      }
      return result
    }

    /** Commits whatever the agent left in the checkout and pushes it. Returns the new head. */
    const commitAndPush = async (
      message: string,
      detail: Record<string, unknown>,
    ): Promise<string> => {
      current = 'push'
      await enterStage(db, taskId, 'push', { branch, ...detail })
      const changes = await must(backend, `git -C ${repoDir} status --porcelain`)
      if (changes.stdout.trim() === '') {
        throw new StageFailure('the agent made no change to the repository')
      }
      // Text that came from outside (the issue title, the author) goes in by file, so none of it is
      // ever parsed by a shell (the SDK does not export its quoting helper: usetheokit/theokit#1131).
      await backend.uploadFile(GITCONFIG, gitConfig(deps.author))
      await backend.uploadFile(COMMIT_MESSAGE, `${message}\n`)
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
      return (await must(backend, `${git} rev-parse HEAD`)).stdout.trim()
    }

    current = 'build'
    await enterStage(db, taskId, 'build', { harness: builder.name, attempt: 1 })
    const first = settle(
      await builder.run(backend, {
        cwd: repoDir,
        timeoutMs: timeouts.agentMs,
        prompt: buildPrompt({
          repo: row.repository,
          issueNumber: row.issueNumber,
          title: issue.title,
          body: issue.body,
          branch,
        }),
      }),
      builder,
    )
    if (!first.ok) throw new StageFailure(`the agent did not finish: ${first.summary}`)
    summary = first.summary
    sessionId = first.sessionId
    let sha = await commitAndPush(title, {
      costUsd: first.costUsd,
      agentSummary: first.summary.slice(0, 4_000),
      sessionId: first.sessionId,
    })

    /** Sends the work back to the builder's own session with what was wrong, and pushes the fix. */
    const rework = async (attempt: number, findings: Finding[], failed: CheckResult[]) => {
      current = 'build'
      await enterStage(db, taskId, 'build', { harness: builder.name, attempt, rework: true })
      const result = settle(
        await builder.resume!(backend, sessionId!, {
          cwd: repoDir,
          timeoutMs: timeouts.agentMs,
          prompt: reworkPrompt({ findings, failedChecks: failed }),
        }),
        builder,
      )
      if (!result.ok)
        throw new StageFailure(`the agent did not finish the rework: ${result.summary}`)
      summary = result.summary
      sessionId = result.sessionId ?? sessionId
      return commitAndPush(`${title}: address feedback (attempt ${attempt})`, {
        attempt,
        rework: true,
        costUsd: result.costUsd,
      })
    }

    /** Has the reviewer read the commit, adds the facts about the diff, and records the outcome. */
    const reviewCommit = async (attempt: number, sha: string): Promise<ReviewVerdict> => {
      const changes = parseNameStatus(
        (await must(backend, `git -C ${repoDir} diff --name-status ${baseSha} HEAD`)).stdout,
      )
      const showScript = async (rev: string) => {
        const shown = await backend.execute(`git -C ${repoDir} show ${rev}:package.json`)
        return shown.exitCode === 0 ? testScriptOf(shown.stdout) : undefined
      }
      const guards = diffGuards({
        changes,
        baseTestScript: await showScript(baseSha),
        headTestScript: await showScript('HEAD'),
      })
      const result = settle(
        await reviewer.run(backend, {
          cwd: repoDir,
          timeoutMs: timeouts.reviewMs ?? 10 * 60_000,
          prompt: reviewPrompt({
            repo: row.repository,
            issueNumber: row.issueNumber,
            title: issue.title,
            body: issue.body,
            branch,
            baseSha,
          }),
        }),
        reviewer,
      )
      // The reviewer reads and does not write. If it wrote anyway, none of it counts.
      await must(backend, `git -C ${repoDir} reset --hard ${sha}`)
      await must(backend, `git -C ${repoDir} clean -fd`)

      const read: ReviewVerdict = result.ok
        ? parseVerdict(result.summary)
        : { verdict: 'invalid', summary: `the reviewer failed: ${result.summary}`, findings: [] }
      // A fact about the diff that an agent could bend outranks an approval.
      const blocked = read.verdict === 'approve' && guards.some((g) => g.severity !== 'minor')
      const merged: ReviewVerdict = {
        verdict: blocked ? 'changes' : read.verdict,
        summary: read.summary,
        findings: [...guards, ...read.findings],
      }
      await db.insert(reviewTable).values({
        taskId,
        round: attempt,
        sha,
        reviewer: reviewer.name,
        verdict: merged.verdict,
        summary: merged.summary,
        findings: merged.findings,
      })
      return merged
    }

    for (let attempt = 1; ; attempt++) {
      const canRework = attempt < MAX_ATTEMPTS && builder.resume !== undefined && !!sessionId

      current = 'verify'
      await enterStage(
        db,
        taskId,
        'verify',
        { sha, attempt, checks: checks.map((c) => c.name) },
        { headSha: sha },
      )
      // The checks must run on the commit that was pushed and nothing else.
      const head = (await must(backend, `git -C ${repoDir} rev-parse HEAD`)).stdout.trim()
      const dirty = (await must(backend, `git -C ${repoDir} status --porcelain`)).stdout.trim()
      if (head !== sha || dirty !== '') {
        throw new StageFailure(`the checkout is not the pushed commit ${sha.slice(0, 7)}`)
      }
      const results = await runChecks(backend, repoDir, checks, timeouts.checkMs ?? 10 * 60_000)
      for (const check of results) await db.insert(evidence).values({ taskId, sha, ...check })
      const rows = await db
        .select()
        .from(evidence)
        .where(eq(evidence.taskId, taskId))
        .orderBy(asc(evidence.id))
      const verdict = gate({ headSha: sha, required: checks.map((c) => c.name), evidence: rows })
      const here = rows.filter((r) => r.sha === sha)
      await api.createCheckRun(row.repository, token, {
        name: 'aifactory/verify',
        headSha: sha,
        conclusion: verdict.open ? 'success' : 'failure',
        title: verdict.open ? 'All checks passed' : 'Checks did not pass',
        summary: checkSummary(here),
      })

      if (!verdict.open) {
        if (!canRework) {
          throw new StageFailure(
            `no pull request: ${verdict.reasons.join('; ')}${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`,
          )
        }
        sha = await rework(
          attempt + 1,
          [],
          results.filter((r) => !r.passed),
        )
        continue
      }

      current = 'review'
      await enterStage(db, taskId, 'review', { sha, attempt, reviewer: reviewer.name })
      const outcome = await reviewCommit(attempt, sha)

      if (outcome.verdict === 'approve') {
        current = 'pr'
        await enterStage(db, taskId, 'pr', { branch, sha })
        const pull = await api.openPullRequest(row.repository, token, {
          head: branch,
          title,
          body: pullRequestBody({
            issueNumber: row.issueNumber,
            sha,
            rows: here,
            agentSummary: summary,
            review: { reviewer: reviewer.name, attempt, outcome },
          }),
        })
        await enterStage(
          db,
          taskId,
          'done',
          { branch, sha, pullRequestUrl: pull.url, costUsd: cost, attempts: attempt },
          { pullRequestUrl: pull.url },
        )
        return { status: 'done', branch, sha, pullRequestUrl: pull.url, summary }
      }

      if (outcome.verdict === 'changes' && canRework) {
        sha = await rework(attempt + 1, outcome.findings, [])
        continue
      }

      // No approval and no attempts left (or no verdict to act on): a person takes it from here.
      const reason =
        outcome.verdict === 'invalid'
          ? `the review gave no usable verdict: ${outcome.summary}`
          : `the reviewer still asked for changes after ${attempt} attempt${attempt === 1 ? '' : 's'}`
      current = 'pr'
      const pull = await api.openPullRequest(row.repository, token, {
        head: branch,
        title: `[needs a person] ${title}`,
        draft: true,
        body: pullRequestBody({
          issueNumber: row.issueNumber,
          sha,
          rows: here,
          agentSummary: summary,
          review: { reviewer: reviewer.name, attempt, outcome },
          handoff: reason,
        }),
      })
      await api.commentOnIssue(
        row.repository,
        token,
        row.issueNumber,
        [
          `The factory could not get this approved: ${reason}.`,
          '',
          `Its work is in the draft pull request ${pull.url}, with the checks that passed and what the reviewer still found.`,
          '',
          outcome.findings.length > 0 ? renderFindings(outcome.findings) : outcome.summary,
        ].join('\n'),
      )
      await enterStage(
        db,
        taskId,
        'handoff',
        {
          branch,
          sha,
          reason,
          pullRequestUrl: pull.url,
          findings: outcome.findings,
          costUsd: cost,
          attempts: attempt,
        },
        { pullRequestUrl: pull.url },
      )
      return { status: 'handoff', branch, sha, pullRequestUrl: pull.url, reason }
    }
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

/**
 * One list of firewall rules from several agents. A domain two agents share must be signed the same
 * way by both, because the firewall holds one rule per domain.
 */
export function mergeEgress(lists: EgressRule[][]): EgressRule[] {
  const byDomain = new Map<string, EgressRule>()
  for (const rule of lists.flat()) {
    const known = byDomain.get(rule.domain)
    if (known && JSON.stringify(known.headers ?? null) !== JSON.stringify(rule.headers ?? null)) {
      throw new Error(`two agents sign ${rule.domain} differently`)
    }
    byDomain.set(rule.domain, rule)
  }
  return [...byDomain.values()]
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

function pullRequestBody(input: {
  issueNumber: number
  sha: string
  rows: StoredCheck[]
  agentSummary: string
  review: { reviewer: string; attempt: number; outcome: ReviewVerdict }
  handoff?: string
}): string {
  const { review } = input
  const remaining = review.outcome.findings
  return [
    `Closes #${input.issueNumber}`,
    '',
    ...(input.handoff ? [`**This needs a person:** ${input.handoff}.`, ''] : []),
    `Checks the factory ran on \`${input.sha.slice(0, 7)}\`:`,
    '',
    checkSummary(input.rows),
    '',
    `Independent review by ${review.reviewer}, attempt ${review.attempt}: ${review.outcome.verdict}. ${review.outcome.summary}`,
    ...(remaining.length > 0 ? ['', renderFindings(remaining)] : []),
    '',
    '<details><summary>What the agent said</summary>',
    '',
    input.agentSummary.slice(0, 3_000),
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
