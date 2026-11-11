import { type SandboxBackend } from '@theokit/agents/sandbox'
import { asc, eq } from 'drizzle-orm'

import {
  agentRun,
  decision,
  evidence,
  question as questionTable,
  review as reviewTable,
  task,
} from '../db/schema'
import type { Issue } from '../github/issues'
import type { GithubApi } from '../github/pulls'
import { KnowledgeFeed } from '../knowledge/feed'
import { parseLearned, withoutLearned } from '../knowledge/format'

import { cloneRepository } from './clone'
import { ensureBranches, integrationBranch, PRE_RELEASE_BRANCH } from './branches'
import { githubEgress, renewGithubCredential } from './credential-renewal'
import { createPreRelease, release } from './deliver'
import {
  DEFAULT_CHECKS,
  failingChecks,
  gate,
  runChecks,
  type CheckResult,
  type Verdict,
} from './evidence'
import { diffGuards, parseNameStatus, testScriptOf } from './guards'
import { buildPrompt, type CodingHarness, type HarnessResult } from './harness'
import {
  MAX_ATTEMPTS,
  notResolvedPrompt,
  parseVerdict,
  renderFindings,
  resolvedPrompt,
  reviewPrompt,
  reworkPrompt,
  type Finding,
  type ReviewVerdict,
} from './review'
import {
  COMMIT_MESSAGE,
  GITCONFIG,
  INSTANCE,
  checkSummary,
  gitConfig,
  mergeEgress,
  must,
  oneLine,
  pullRequestBody,
  pushWithRetry,
  resolvedComment,
  Asked,
  QuotaStop,
  StageFailure,
  type StoredCheck,
} from './run-support'
import { agentTimeLeft, DEFAULT_CHECK_MS, DEFAULT_REVIEW_MS, NoTimeForAgent } from './agent-time'
import type { RepoConfig } from './repo-config'
import { labelsWithRepoChoice } from './repo-config'
import type { Parked, RunResult, RunTaskDeps } from './run-types'
import {
  createIsolatedSandbox,
  restoreIsolatedSandbox,
  type IsolatedSandbox,
  type SandboxSpec,
} from './sandbox'
import { enterStage } from './stages'
import type { AgentEvent } from './transcript'
import { Transcript } from './transcript-store'
import { answerPrompt, parseQuestion, questionComment } from './waiting'

/** Where a run is, kept outside it so a failure before the run exists is still reported at a stage. */
export type RunState = { current: string; sandbox: IsolatedSandbox | undefined }

export type RunContext = {
  deps: RunTaskDeps
  taskId: number
  row: typeof task.$inferSelect
  issue: Issue
  /** What the owner set for this repository. */
  repo: RepoConfig
  token: string
  api: GithubApi
  branch: string
  state: RunState
  signal?: AbortSignal
  resuming?: Parked
  continuation?: { feedback: string }
}

type Timeouts = NonNullable<RunTaskDeps['timeouts']>
/**
 * The sandbox stops a run after `sandboxMs`. A run is a builder (up to `agentMs`, cut by `agentTimeLeft` so the
 * checks and a review still fit), the checks, a review, and
 * at times a rework and the checks again. In a repository whose checks take twenty minutes on a busy machine
 * that is more than 50 minutes, and 8 runs were cut at 50 on 2026-11-11 (paulohenriquevn/aifactory#4). The
 * GitHub token is renewed while the run works (`renewGithubCredential`), so the limit is set by what a run
 * needs, not by the hour a token lasts. A first build that adds a package needs more than 25 minutes, and four
 * were cut at 25 on 2026-11-11 (paulohenriquevn/aifactory#23), so a pass may take 45.
 */
export const DEFAULT_TIMEOUTS: Timeouts = { sandboxMs: 90 * 60_000, agentMs: 45 * 60_000 }

/** What the factory handed over, or why it could not. A failure to hand over never fails the task. */
type Handed = { tag: string; url: string } | { error: string }

/** What the integration did, or why it did not happen. Nothing set means it did not run. */
type Integrated = {
  /** The pull request was merged, and this is the commit on the integration branch. */
  mergedSha?: string
  /** The pre-release branch advanced, and this is where it is. */
  developSha?: string
  developError?: string
  /**
   * Where the work waits to reach the pre-release branch when GitHub would not let the factory advance it
   * (a protected branch): a pull request from the integration branch, which the factory only opens.
   */
  developPullRequest?: string
  /** GitHub refused to merge the pull request, which stays open for a person. */
  error?: string
}

const describeIntegration = (integrated: Integrated) => ({
  ...(integrated.error ? { integrationError: integrated.error } : {}),
  ...(integrated.mergedSha ? { mergedSha: integrated.mergedSha } : {}),
  ...(integrated.developSha ? { developSha: integrated.developSha } : {}),
  ...(integrated.developError ? { developError: integrated.developError } : {}),
  ...(integrated.developPullRequest ? { developPullRequest: integrated.developPullRequest } : {}),
})

const describeDelivery = (handed: Handed) =>
  'tag' in handed
    ? { preRelease: handed.tag, preReleaseUrl: handed.url }
    : { preReleaseError: handed.error }

/** The result of running the checks on a commit: what ran, what it adds up to, and what to show. */
type Checked = { results: CheckResult[]; here: StoredCheck[]; verdict: Verdict }

/**
 * One run of a task, from the sandbox to the pull request. It holds what changes as the run goes
 * (what it has cost, what the agent last said, the agent's session) and has a method for each step, so
 * no step has to be read inside another. `openRun` builds it, `start` does the first pass, and `loop`
 * checks, reviews and reworks until the work is approved or handed over.
 */
export class Run {
  cost: number
  summary = ''
  sessionId: string | undefined
  /** The knowledge base in the sandbox, kept current while the run goes; the same for every agent. */
  feed?: KnowledgeFeed
  /**
   * What the run expects `factory/<issue>` to hold on GitHub: the commit there when the run started (empty
   * when there was none), then each commit the run pushed. A push replaces exactly that and nothing else.
   */
  remoteHead = ''
  /** What the agents of this task do, written while they work. Opened by the first agent run. */
  private transcript: Transcript | undefined

  private constructor(
    private readonly c: RunContext,
    private readonly builder: CodingHarness,
    private readonly reviewer: CodingHarness,
    private readonly sandbox: IsolatedSandbox,
    private readonly repoDir: string,
    private readonly baseSha: string,
    /** When the sandbox started, which is when its time began to run out. */
    private readonly startedAt: number,
  ) {
    this.cost = c.resuming?.costUsd ?? 0
    this.sessionId = c.resuming?.sessionId
  }

  private get backend(): SandboxBackend {
    return this.sandbox.backend
  }
  private get git() {
    // The repository's own hooks (a pre-commit scanner, say) are for people working by hand: they may need
    // tools this sandbox does not have, and they are not this factory's gate, which is the checks and the
    // review. `-c` outranks the repository's own `core.hooksPath`.
    return `GIT_CONFIG_GLOBAL=${GITCONFIG} git -c core.hooksPath=/dev/null -C ${this.repoDir}`
  }
  private get timeouts(): Timeouts {
    return this.c.deps.timeouts ?? DEFAULT_TIMEOUTS
  }
  /** How long the next agent pass may take; throws when the sandbox has too little time left for one. */
  private agentTimeout(): number {
    try {
      return agentTimeLeft(this.timeouts, Date.now() - this.startedAt)
    } catch (error) {
      if (error instanceof NoTimeForAgent) throw new StageFailure(error.message)
      throw error
    }
  }
  private get title() {
    return `${oneLine(this.c.issue.title)} (#${this.c.row.issueNumber})`
  }
  private get checks() {
    return this.c.repo.checks ?? this.c.deps.checks ?? DEFAULT_CHECKS
  }

  /**
   * Starts the sandbox (new, or restored from a snapshot), puts the repository on the branch, and
   * prepares the agents. The agents come from the issue's labels, and each signs its own calls: its
   * secret is read here, on the host, and becomes a firewall rule, so the sandbox never holds one.
   */
  static async open(c: RunContext): Promise<Run> {
    const { deps, issue, resuming } = c
    // Before any sandbox exists: a repository without the integration and pre-release branches gets them.
    if (!resuming) {
      await ensureBranches(c.api, c.row.repository, c.token, {
        integration: integrationBranch(c.repo),
        release: c.repo.releaseBranch,
      })
    }
    const labels = labelsWithRepoChoice(issue.labels ?? [], c.repo)
    const builder = typeof deps.harness === 'function' ? deps.harness(labels) : deps.harness
    const chosen = typeof deps.reviewer === 'function' ? deps.reviewer(labels) : deps.reviewer
    const reviewer = chosen ?? builder
    const agents = reviewer.name === builder.name ? [builder] : [builder, reviewer]
    const agentEgress = mergeEgress(await Promise.all(agents.map((a) => a.egress())))

    const spec: SandboxSpec = {
      timeoutMs: (deps.timeouts ?? DEFAULT_TIMEOUTS).sandboxMs,
      cacheKey: c.row.repository,
      egress: [
        githubEgress(c.token),
        ...agentEgress,
        { domain: 'registry.npmjs.org' },
        ...c.repo.egress.map((domain) => ({ domain })),
      ],
    }
    const startedAt = Date.now()
    const started = resuming
      ? await restoreIsolatedSandbox(deps.sandbox, resuming.snapshotId, spec)
      : await createIsolatedSandbox(deps.sandbox, spec)
    c.state.sandbox = started
    // A run may outlast the hour its first token lasts, so the token is renewed while it works.
    const sandbox = renewGithubCredential(started, spec.egress, {
      mint: async () => (await deps.github.installationToken(c.row.repository)).token,
      onToken: (token) => {
        c.token = token
      },
      onFailure: (error) =>
        console.warn(
          JSON.stringify({
            event: 'credential_renewal_failed',
            taskId: c.taskId,
            repository: c.row.repository,
            error: String(error),
          }),
        ),
    })
    c.state.sandbox = sandbox
    // The snapshot did its job; keeping it only costs storage.
    if (resuming) await deps.sandbox.deleteSnapshot?.(resuming.snapshotId).catch(() => {})
    c.signal?.addEventListener('abort', () => void sandbox.stop().catch(() => {}), { once: true })

    const { repoDir, baseSha } = await Run.checkout(c, sandbox.backend)
    for (const agent of agents) await agent.prepare?.(sandbox.backend)
    const feed = await KnowledgeFeed.open(deps.knowledge, sandbox.backend, c.row.repository, {
      taskId: c.taskId,
    })
    // Stopping the sandbox stops the feed first, so no copy goes into a sandbox that is gone.
    c.state.sandbox = feed.attachTo(sandbox)
    const run = new Run(c, builder, reviewer, sandbox, repoDir, baseSha, startedAt)
    run.feed = feed
    run.remoteHead = await Run.remoteHeadOf(sandbox.backend, repoDir, c.branch)
    return run
  }

  /**
   * Puts the repository on the task's branch. A resumed run already has its checkout, on its branch,
   * inside the snapshot. The SDK's provisioner clones with `--` and the `ext::` transport off. The work
   * starts from the integration branch: `workspace`, or the one the owner chose for the repository.
   */
  private static async checkout(c: RunContext, backend: SandboxBackend) {
    const { resuming, continuation, branch, row } = c
    if (resuming) return { repoDir: resuming.repoDir, baseSha: resuming.baseSha }
    const { repoDir } = await cloneRepository(backend, {
      repoUrl: `https://github.com/${row.repository}.git`,
      ref: integrationBranch(c.repo),
      instanceId: INSTANCE,
    })
    const baseSha = (await must(backend, `git -C ${repoDir} rev-parse HEAD`)).stdout.trim()
    if (continuation) {
      // The agent's earlier work is on the remote branch; start from it, not from the default branch.
      await must(backend, `git -C ${repoDir} fetch origin ${branch}`)
      await must(backend, `git -C ${repoDir} checkout -B ${branch} FETCH_HEAD`)
    } else {
      await must(backend, `git -C ${repoDir} checkout -b ${branch}`)
    }
    return { repoDir, baseSha }
  }

  /**
   * The commit on GitHub's `branch`, or empty when the branch does not exist. A run started again after its
   * process died finds the dead run's commits there; it replaces them, as a Retry does, but keeps the pull
   * request open (paulohenriquevn/aifactory#2).
   */
  private static async remoteHeadOf(backend: SandboxBackend, repoDir: string, branch: string) {
    const listed = await must(backend, `git -C ${repoDir} ls-remote origin refs/heads/${branch}`)
    return listed.stdout.trim().split(/\s/)[0] ?? ''
  }

  /** Runs the agent, books its cost and session, and turns a quota stop into its own error. */
  private async settle(
    who: CodingHarness,
    role: 'builder' | 'reviewer',
    attempt: number,
    call: (onEvent: (event: AgentEvent) => void) => Promise<HarnessResult>,
  ): Promise<HarnessResult> {
    const { db } = this.c.deps
    const { taskId } = this.c
    this.transcript ??= await Transcript.open(db, taskId)
    const started = Date.now()
    let result: HarnessResult
    try {
      result = await call(this.transcript.sink(role, attempt))
    } catch (error) {
      await this.transcript.drain()
      // The agent did not come back (the sandbox died, say). It still ran, and that is on record.
      await db.insert(agentRun).values({
        taskId,
        role,
        harness: who.name,
        attempt,
        durationMs: Date.now() - started,
        ok: false,
      })
      throw error
    }
    await this.transcript.flush()
    this.cost += result.costUsd ?? 0
    await db.update(task).set({ costUsd: this.cost }).where(eq(task.id, taskId))
    await db.insert(agentRun).values({
      taskId,
      role,
      harness: who.name,
      attempt,
      costUsd: result.costUsd ?? null,
      durationMs: Date.now() - started,
      ok: result.ok,
      quota: result.quota !== undefined,
      sessionId: result.sessionId ?? null,
    })
    if (result.quota) {
      const resets = result.quota.resetsAt ? `, resets ${result.quota.resetsAt}` : ''
      throw new QuotaStop(
        `the ${who.name} quota ran out${resets}: ${result.quota.message}`,
        result.quota.resetsAt,
      )
    }
    return result
  }

  /**
   * Parks the run. The disk is saved to a snapshot (which stops the sandbox), the question goes to the
   * issue, and everything a resume needs is stored. Never returns: the run ends here.
   */
  private async ask(text: string, attempt: number): Promise<never> {
    const { deps, taskId, row, api, state } = this.c
    if (!this.sandbox.snapshot || !deps.sandbox.restore) {
      throw new StageFailure(
        `the agent asked a question, but ${deps.sandbox.name} cannot save a sandbox to wait: ${text}`,
      )
    }
    if (!this.sessionId) {
      throw new StageFailure(`the agent asked a question but gave no session to resume: ${text}`)
    }
    state.current = 'waiting'
    const snapshotId = await this.sandbox.snapshot()
    let commentId: string
    try {
      commentId = await api.commentOnIssue(
        row.repository,
        this.c.token,
        row.issueNumber,
        questionComment(taskId, text),
      )
    } catch (error) {
      await deps.sandbox.deleteSnapshot?.(snapshotId).catch(() => {})
      throw error
    }
    await deps.db.insert(questionTable).values({
      taskId,
      body: text,
      commentId,
      snapshotId,
      sessionId: this.sessionId,
      harness: this.builder.name,
      repoDir: this.repoDir,
      baseSha: this.baseSha,
      attempt,
      costUsd: this.cost,
    })
    await enterStage(deps.db, taskId, 'waiting', {
      question: text,
      commentId,
      attempt,
      costUsd: this.cost,
    })
    throw new Asked({ status: 'waiting', question: text })
  }

  /** The facts the builder left with `LEARNED:`, kept for the knowledge base of this project. */
  private async keepLearned(summary: string): Promise<void> {
    const facts = parseLearned(summary)
    if (facts.length === 0 || !this.feed?.delivered) return
    const { deps, taskId, row } = this.c
    await deps.knowledge?.keep(
      facts.map((body) => ({
        repository: row.repository,
        kind: 'learned',
        body,
        taskId,
        issueNumber: row.issueNumber,
        baseSha: this.baseSha,
      })),
    )
  }

  /**
   * A run that found nothing to change in an issue is worth remembering: the next run on the same issue
   * starts from what this one found, instead of finding it again.
   */
  private async keepNoChange(): Promise<void> {
    const { deps, taskId, row, issue, continuation } = this.c
    if (continuation || !this.feed?.delivered) return
    const said = this.summary ? ` The agent said: ${oneLine(this.summary).slice(0, 1500)}` : ''
    await deps.knowledge?.keep([
      {
        repository: row.repository,
        kind: 'no-change',
        body: `Issue #${row.issueNumber} (${oneLine(issue.title)}): a run starting from ${this.baseSha} found nothing to change.${said}`,
        taskId,
        issueNumber: row.issueNumber,
        baseSha: this.baseSha,
      },
    ])
  }

  /** Commits whatever the agent left in the checkout and pushes it. Returns the new head. */
  private async commitAndPush(message: string, detail: Record<string, unknown>): Promise<string> {
    const { deps, taskId, branch, state } = this.c
    const { backend, git } = this
    state.current = 'push'
    await enterStage(deps.db, taskId, 'push', { branch, ...detail })
    const changes = await must(backend, `git -C ${this.repoDir} status --porcelain`)
    if (changes.stdout.trim() === '') {
      // A rework that changed nothing is the reviewer's business, not a fact about the issue.
      if (!detail.rework) await this.keepNoChange()
      throw new StageFailure(
        `the agent made no change to the repository${
          this.summary ? `. The agent said: ${oneLine(this.summary).slice(0, 700)}` : ''
        }`,
      )
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
      // The lease makes the push fail, instead of overwriting, when someone else pushed during the run.
      const lease = `--force-with-lease=refs/heads/${branch}:${this.remoteHead}`
      await pushWithRetry(
        backend,
        `${git} push origin ${branch} ${lease}`,
        deps.pushRetryDelayMs ?? 5_000,
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new StageFailure(`${reason}\ncommit being pushed:\n${files.slice(0, 1500)}`)
    }
    this.remoteHead = (await must(backend, `${git} rev-parse HEAD`)).stdout.trim()
    return this.remoteHead
  }

  /** The first pass of the builder: a new one, or the session resumed with the answer it was waiting for. */
  private async firstPass(): Promise<HarnessResult> {
    const { deps, taskId, row, issue, branch, resuming, continuation } = this.c
    const { builder, backend, repoDir } = this
    if (resuming) {
      if (!builder.resume) throw new StageFailure(`${builder.name} cannot resume a session`)
      await enterStage(deps.db, taskId, 'build', {
        harness: builder.name,
        attempt: resuming.attempt,
        resumed: true,
      })
      const prompt = answerPrompt(
        resuming.body,
        resuming.answer ?? '',
        resuming.answeredBy ?? 'a person',
      )
      return this.settle(builder, 'builder', resuming.attempt, (onEvent) =>
        builder.resume!(backend, resuming.sessionId, {
          onEvent,
          cwd: repoDir,
          timeoutMs: this.agentTimeout(),
          prompt,
        }),
      )
    }
    await enterStage(deps.db, taskId, 'build', {
      harness: builder.name,
      attempt: 1,
      ...(this.feed?.delivered ? { knowledge: this.feed.delivered } : {}),
    })
    return this.settle(builder, 'builder', 1, (onEvent) =>
      builder.run(backend, {
        onEvent,
        cwd: repoDir,
        timeoutMs: this.agentTimeout(),
        prompt: buildPrompt({
          repo: row.repository,
          issueNumber: row.issueNumber,
          title: issue.title,
          body: issue.body,
          branch,
          feedback: continuation?.feedback,
          askQuestions: this.c.repo.askQuestions,
          knowledgeDir: this.feed?.dir,
          checks: this.checks,
        }),
      }),
    )
  }

  private firstMessage(): string {
    if (this.c.resuming) return `${this.title}: continue after an answer`
    if (this.c.continuation) return `${this.title}: address requested changes`
    return this.title
  }

  /**
   * A person asked for a change and the agent found nothing to change (the test was already there,
   * say). That is an answer, not a failure: the pull request stays as it was, and the person reads why.
   */
  private async answeredWithNoChange(first: HarnessResult): Promise<RunResult | undefined> {
    const { deps, taskId, row, api, branch, continuation } = this.c
    if (!continuation || !row.pullRequestUrl || !row.headSha) return undefined
    const pending = await must(this.backend, `git -C ${this.repoDir} status --porcelain`)
    if (pending.stdout.trim() !== '') return undefined
    await api.commentOnIssue(
      row.repository,
      this.c.token,
      row.issueNumber,
      `You asked for changes. The agent left the pull request as it is:\n\n${first.summary.slice(0, 3_000)}`,
    )
    await enterStage(deps.db, taskId, 'done', {
      branch,
      sha: row.headSha,
      pullRequestUrl: row.pullRequestUrl,
      unchanged: true,
      agentSummary: first.summary.slice(0, 4_000),
      costUsd: this.cost,
    })
    return {
      status: 'done',
      branch,
      sha: row.headSha,
      pullRequestUrl: row.pullRequestUrl,
      summary: first.summary,
    }
  }

  /**
   * The builder changed nothing on a new issue and says the code already does what it asks. That is a claim:
   * the checks run at the commit the run started from and the reviewer checks it against the code. When
   * both agree, the issue is closed with that evidence and the task is delivered without a pull request;
   * otherwise it goes to a person with what did not hold.
   */
  private async resolvedAlready(first: HarnessResult): Promise<RunResult | undefined> {
    const { deps, taskId, row, api, continuation, state } = this.c
    if (continuation) return undefined
    const pending = await must(this.backend, `git -C ${this.repoDir} status --porcelain`)
    if (pending.stdout.trim() !== '') return undefined
    await this.keepNoChange()
    const said = `The agent said: ${oneLine(first.summary).slice(0, 700)}`
    const at = this.baseSha.slice(0, 7)
    const checked = await this.verify(this.baseSha, 1, { publish: false })
    if (!checked.verdict.open) {
      throw new StageFailure(
        `the agent made no change to the repository, and the checks did not pass at ${at}: ${checked.verdict.reasons.join('; ')}. ${said}`,
      )
    }
    const outcome = await this.reviewClaim(first.summary)
    const refuted = `the agent made no change to the repository, and the reviewer did not confirm the issue is resolved: ${outcome.summary}.`
    if (outcome.verdict === 'changes' && this.builder.resume && this.sessionId) {
      const after = await this.buildAfterRefutedClaim(outcome)
      if (after.changed) return undefined
      throw new StageFailure(
        `${refuted} Sent back with the review, the agent still changed nothing and said: ${oneLine(withoutLearned(after.summary)).slice(0, 700)}`,
      )
    }
    if (outcome.verdict !== 'approve') throw new StageFailure(`${refuted} ${said}`)
    state.current = 'done'
    await api.commentOnIssue(
      row.repository,
      this.c.token,
      row.issueNumber,
      resolvedComment({
        sha: this.baseSha,
        claim: first.summary,
        reviewer: this.reviewer.name,
        review: outcome.summary,
        rows: checked.here,
      }),
    )
    await api.closeIssue(row.repository, this.c.token, row.issueNumber)
    await enterStage(
      deps.db,
      taskId,
      'done',
      {
        sha: this.baseSha,
        resolved: true,
        agentSummary: first.summary.slice(0, 4_000),
        review: outcome.summary,
        costUsd: this.cost,
      },
      { headSha: this.baseSha, resolvedSha: this.baseSha },
    )
    return { status: 'resolved', sha: this.baseSha, summary: first.summary }
  }

  /**
   * The builder said nothing needed changing and the reviewer found the issue is not resolved: the
   * review goes back to the builder's own session, once. A change it then makes takes the normal way
   * (push, checks, review); no change ends the run with what it said.
   */
  private async buildAfterRefutedClaim(
    outcome: ReviewVerdict,
  ): Promise<{ changed: boolean; summary: string }> {
    const { deps, taskId, state } = this.c
    state.current = 'build'
    await enterStage(deps.db, taskId, 'build', {
      harness: this.builder.name,
      attempt: 1,
      refuted: true,
    })
    const result = await this.settle(this.builder, 'builder', 1, (onEvent) =>
      this.builder.resume!(this.backend, this.sessionId!, {
        onEvent,
        cwd: this.repoDir,
        timeoutMs: this.agentTimeout(),
        prompt: notResolvedPrompt({
          summary: outcome.summary,
          findings: outcome.findings,
          checks: this.checks,
        }),
      }),
    )
    if (!result.ok) throw new StageFailure(`the agent did not finish: ${result.summary}`)
    await this.keepLearned(result.summary)
    this.sessionId = result.sessionId ?? this.sessionId
    const asked = parseQuestion(withoutLearned(result.summary))
    if (asked) await this.ask(asked, 1)
    this.summary = result.summary
    const pending = await must(this.backend, `git -C ${this.repoDir} status --porcelain`)
    return { changed: pending.stdout.trim() !== '', summary: result.summary }
  }

  /** Has the reviewer check, without changing anything, that the code already resolves the issue. */
  private async reviewClaim(claim: string): Promise<ReviewVerdict> {
    const { deps, taskId, row, issue, state } = this.c
    state.current = 'review'
    await enterStage(deps.db, taskId, 'review', {
      sha: this.baseSha,
      attempt: 1,
      reviewer: this.reviewer.name,
      resolved: true,
    })
    const result = await this.settle(this.reviewer, 'reviewer', 1, (onEvent) =>
      this.reviewer.run(this.backend, {
        onEvent,
        cwd: this.repoDir,
        timeoutMs: this.timeouts.reviewMs ?? DEFAULT_REVIEW_MS,
        prompt: resolvedPrompt({
          repo: row.repository,
          issueNumber: row.issueNumber,
          title: issue.title,
          body: issue.body,
          baseSha: this.baseSha,
          claim: claim.slice(0, 6_000),
          knowledgeDir: this.feed?.dir,
        }),
      }),
    )
    // The reviewer reads and does not write. If it wrote anyway, none of it counts.
    await must(this.backend, `git -C ${this.repoDir} reset --hard ${this.baseSha}`)
    await must(this.backend, `git -C ${this.repoDir} clean -fd`)
    const read: ReviewVerdict = result.ok
      ? parseVerdict(result.summary)
      : { verdict: 'invalid', summary: `the reviewer failed: ${result.summary}`, findings: [] }
    await deps.db.insert(reviewTable).values({
      taskId,
      round: 1,
      sha: this.baseSha,
      reviewer: this.reviewer.name,
      verdict: read.verdict,
      summary: read.summary,
      findings: read.findings,
    })
    return read
  }

  /**
   * The builder's first pass, up to the first push. It ends the run early when the agent asked
   * something (the run parks) or when a person's requested change needed no change.
   */
  async start(): Promise<{ result: RunResult } | { sha: string }> {
    this.c.state.current = 'build'
    const first = await this.firstPass()
    if (!first.ok) throw new StageFailure(`the agent did not finish: ${first.summary}`)
    await this.keepLearned(first.summary)
    // A fact the agent left is not part of its question, wherever it put it.
    const asked = parseQuestion(withoutLearned(first.summary))
    this.sessionId = first.sessionId ?? this.sessionId
    if (asked) await this.ask(asked, this.c.resuming?.attempt ?? 1)
    this.summary = first.summary

    const unchanged = await this.answeredWithNoChange(first)
    if (unchanged) return { result: unchanged }
    const resolved = await this.resolvedAlready(first)
    if (resolved) return { result: resolved }
    const sha = await this.commitAndPush(this.firstMessage(), {
      costUsd: first.costUsd,
      agentSummary: first.summary.slice(0, 4_000),
      sessionId: this.sessionId,
    })
    return { sha }
  }

  /** Sends the work back to the builder's own session with what was wrong, and pushes the fix. */
  private async rework(
    attempt: number,
    findings: Finding[],
    failed: CheckResult[],
  ): Promise<string> {
    const { deps, taskId, state } = this.c
    state.current = 'build'
    await enterStage(deps.db, taskId, 'build', {
      harness: this.builder.name,
      attempt,
      rework: true,
    })
    const result = await this.settle(this.builder, 'builder', attempt, (onEvent) =>
      this.builder.resume!(this.backend, this.sessionId!, {
        onEvent,
        cwd: this.repoDir,
        timeoutMs: this.agentTimeout(),
        prompt: reworkPrompt({ findings, failedChecks: failed, checks: this.checks }),
      }),
    )
    if (!result.ok) throw new StageFailure(`the agent did not finish the rework: ${result.summary}`)
    this.sessionId = result.sessionId ?? this.sessionId
    const asked = parseQuestion(result.summary)
    if (asked) await this.ask(asked, attempt)
    this.summary = result.summary
    return this.commitAndPush(`${this.title}: address feedback (attempt ${attempt})`, {
      attempt,
      rework: true,
      costUsd: result.costUsd,
    })
  }

  /**
   * Runs the checks on the pushed commit and nothing else, stores each result, and publishes what they
   * add up to as a check run on the commit.
   */
  private async verify(
    sha: string,
    attempt: number,
    options: { publish: boolean } = { publish: true },
  ): Promise<Checked> {
    const { deps, taskId, row, api, state } = this.c
    const { db } = deps
    state.current = 'verify'
    await enterStage(
      db,
      taskId,
      'verify',
      { sha, attempt, checks: this.checks.map((c) => c.name) },
      { headSha: sha },
    )
    const head = (await must(this.backend, `git -C ${this.repoDir} rev-parse HEAD`)).stdout.trim()
    const dirty = (
      await must(this.backend, `git -C ${this.repoDir} status --porcelain`)
    ).stdout.trim()
    if (head !== sha || dirty !== '') {
      throw new StageFailure(`the checkout is not the pushed commit ${sha.slice(0, 7)}`)
    }
    // The checks judge the commit, not what the agent left in ignored files: a builder that installed with
    // --ignore-scripts left a node_modules without its native binaries, and the install check took it as done.
    await must(this.backend, `git -C ${this.repoDir} clean -fdxq`)
    const results = await runChecks(
      this.backend,
      this.repoDir,
      this.checks,
      this.timeouts.checkMs ?? DEFAULT_CHECK_MS,
    )
    for (const check of results) await db.insert(evidence).values({ taskId, sha, ...check })
    const rows = await db
      .select()
      .from(evidence)
      .where(eq(evidence.taskId, taskId))
      .orderBy(asc(evidence.id))
    const verdict = gate({ headSha: sha, required: this.checks.map((c) => c.name), evidence: rows })
    const here = rows.filter((r) => r.sha === sha)
    // A commit of the integration branch that the run did not make gets no check run of the factory.
    if (!options.publish) return { results, here, verdict }
    await api.createCheckRun(row.repository, this.c.token, {
      name: 'aifactory/verify',
      headSha: sha,
      conclusion: verdict.open ? 'success' : 'failure',
      title: verdict.open ? 'All checks passed' : 'Checks did not pass',
      summary: checkSummary(here),
    })
    return { results, here, verdict }
  }

  /** What the diff says about itself, without a model: facts an agent could bend. */
  private async diffFacts(): Promise<Finding[]> {
    const { backend, repoDir, baseSha } = this
    const changes = parseNameStatus(
      (await must(backend, `git -C ${repoDir} diff --name-status ${baseSha} HEAD`)).stdout,
    )
    const showScript = async (rev: string) => {
      const shown = await backend.execute(`git -C ${repoDir} show ${rev}:package.json`)
      return shown.exitCode === 0 ? testScriptOf(shown.stdout) : undefined
    }
    return diffGuards({
      changes,
      baseTestScript: await showScript(baseSha),
      headTestScript: await showScript('HEAD'),
    })
  }

  /** Has the reviewer read the commit, adds the facts about the diff, and records the outcome. */
  private async review(sha: string, attempt: number): Promise<ReviewVerdict> {
    const { deps, taskId, row, issue, branch, state } = this.c
    state.current = 'review'
    await enterStage(deps.db, taskId, 'review', { sha, attempt, reviewer: this.reviewer.name })
    const guards = await this.diffFacts()
    const result = await this.settle(this.reviewer, 'reviewer', attempt, (onEvent) =>
      this.reviewer.run(this.backend, {
        onEvent,
        cwd: this.repoDir,
        timeoutMs: this.timeouts.reviewMs ?? DEFAULT_REVIEW_MS,
        prompt: reviewPrompt({
          repo: row.repository,
          issueNumber: row.issueNumber,
          title: issue.title,
          body: issue.body,
          branch,
          baseSha: this.baseSha,
          knowledgeDir: this.feed?.dir,
        }),
      }),
    )
    // The reviewer reads and does not write. If it wrote anyway, none of it counts.
    await must(this.backend, `git -C ${this.repoDir} reset --hard ${sha}`)
    await must(this.backend, `git -C ${this.repoDir} clean -fd`)

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
    await deps.db.insert(reviewTable).values({
      taskId,
      round: attempt,
      sha,
      reviewer: this.reviewer.name,
      verdict: merged.verdict,
      summary: merged.summary,
      findings: merged.findings,
    })
    return merged
  }

  /**
   * The factory's delivery. It is made for any commit with green checks that reached a pull request,
   * approved or handed over, and a failure here never fails the task: the pull request is the work,
   * and the pre-release is how it is handed over.
   */
  /**
   * Integrates the approved work: the pull request is merged into the integration branch, pinned to the
   * commit that was verified and reviewed, and the pre-release branch then advances to include it. Nobody
   * is asked, because the checks and the review are the decision. A merge GitHub refuses (a conflict, a
   * protected branch) leaves the pull request open for a person and does not fail the task.
   */
  private async integrate(sha: string, pullNumber: number): Promise<Integrated> {
    const { deps, taskId, row, api, branch } = this.c
    let merged: { sha: string }
    try {
      merged = await api.mergePullRequest(row.repository, this.c.token, pullNumber, sha, {
        method: 'squash',
        title: this.title,
      })
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
    await deps.db.update(task).set({ mergedSha: merged.sha }).where(eq(task.id, taskId))
    await api.deleteBranch(row.repository, this.c.token, branch).catch(() => {})
    try {
      const develop = await api.mergeBranch(
        row.repository,
        this.c.token,
        PRE_RELEASE_BRANCH,
        merged.sha,
      )
      return { mergedSha: merged.sha, developSha: develop.sha }
    } catch (error) {
      return {
        mergedSha: merged.sha,
        developError: error instanceof Error ? error.message : String(error),
        developPullRequest: await this.proposePreRelease(),
      }
    }
  }

  /**
   * A protected pre-release branch only takes a pull request, so the factory opens one from the
   * integration branch, or finds the one already open, and leaves the merge to whoever the branch's rules
   * ask. It is one standing pull request: later integrations add to it. Failing to open it is not an error:
   * the work is integrated either way.
   */
  private async proposePreRelease(): Promise<string | undefined> {
    const { row, api } = this.c
    const from = integrationBranch(this.c.repo)
    try {
      return (
        await api.openPullRequest(row.repository, this.c.token, {
          head: from,
          base: PRE_RELEASE_BRANCH,
          title: `Pre-release: ${from} into ${PRE_RELEASE_BRANCH}`,
          body: `${PRE_RELEASE_BRANCH} accepts changes only through a pull request, so the factory could not advance it. Merging this pull request publishes what has been integrated into ${from}.`,
        })
      ).url
    } catch {
      return undefined
    }
  }

  private async deliver(
    sha: string,
    pullRequestUrl: string,
    attempts: number,
    integrated?: Integrated,
  ): Promise<Handed> {
    const { deps, taskId, row, issue, api } = this.c
    try {
      return await createPreRelease(
        { db: deps.db, api },
        {
          taskId,
          repository: row.repository,
          token: this.c.token,
          issueNumber: row.issueNumber,
          title: issue.title,
          sha,
          tagSha:
            integrated && 'mergedSha' in integrated
              ? (integrated.developSha ?? integrated.mergedSha)
              : undefined,
          pullRequestUrl,
          attempts,
          costUsd: this.cost,
          agentSummary: this.summary,
        },
      )
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * What the release mode says to do once a commit is delivered and approved. `trial` records what an
   * agent would have released; `auto` releases it, and records why when that is refused. It returns the
   * tag of a release that was made.
   */
  private async releaseByMode(sha: string): Promise<string | undefined> {
    const { deps, taskId, api } = this.c
    const actor = `agent:${this.reviewer.name}`
    const record = (note: string) =>
      deps.db.insert(decision).values({ taskId, kind: 'would_release', sha, note })
    const mode = this.c.repo.releaseMode ?? deps.releaseMode
    if (mode === 'trial') {
      await record(`${actor}: checks green and the review approved`)
      return undefined
    }
    if (mode !== 'auto') return undefined
    try {
      return (
        await release({ db: deps.db, github: deps.github, api }, taskId, { bump: 'patch', actor })
      ).tag
    } catch (error) {
      await record(
        `an automatic release was refused: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  /** The work was approved: open the pull request, hand it over as a pre-release, and finish. */
  private async approved(
    sha: string,
    attempt: number,
    here: StoredCheck[],
    outcome: ReviewVerdict,
  ): Promise<RunResult> {
    const { deps, taskId, row, api, branch, state } = this.c
    state.current = 'pr'
    await enterStage(deps.db, taskId, 'pr', { branch, sha })
    const pull = await api.openPullRequest(row.repository, this.c.token, {
      head: branch,
      base: integrationBranch(this.c.repo),
      title: this.title,
      body: pullRequestBody({
        issueNumber: row.issueNumber,
        sha,
        rows: here,
        agentSummary: this.summary,
        review: { reviewer: this.reviewer.name, attempt, outcome },
      }),
    })
    const integrated = await this.integrate(sha, pull.number)
    const handed = await this.deliver(sha, pull.url, attempt, integrated)
    await enterStage(
      deps.db,
      taskId,
      'done',
      {
        branch,
        sha,
        pullRequestUrl: pull.url,
        costUsd: this.cost,
        attempts: attempt,
        ...describeIntegration(integrated),
        ...describeDelivery(handed),
      },
      { pullRequestUrl: pull.url },
    )
    const preRelease = 'tag' in handed ? handed.tag : undefined
    // A release follows only a delivery that was made.
    const released = preRelease ? await this.releaseByMode(sha) : undefined
    return {
      status: 'done',
      branch,
      sha,
      pullRequestUrl: pull.url,
      summary: this.summary,
      preRelease,
      released,
    }
  }

  /**
   * No approval and no attempts left (or no verdict to act on): a person takes it from here, with a
   * draft pull request, a comment on the issue and a pre-release of what the factory did get done.
   */
  private async handOver(
    sha: string,
    attempt: number,
    here: StoredCheck[],
    outcome: ReviewVerdict,
  ): Promise<RunResult> {
    const { deps, taskId, row, api, branch, state } = this.c
    const reason =
      outcome.verdict === 'invalid'
        ? `the review gave no usable verdict: ${outcome.summary}`
        : `the reviewer still asked for changes after ${attempt} attempt${attempt === 1 ? '' : 's'}`
    state.current = 'pr'
    const pull = await api.openPullRequest(row.repository, this.c.token, {
      head: branch,
      base: integrationBranch(this.c.repo),
      title: `[needs a person] ${this.title}`,
      draft: true,
      body: pullRequestBody({
        issueNumber: row.issueNumber,
        sha,
        rows: here,
        agentSummary: this.summary,
        review: { reviewer: this.reviewer.name, attempt, outcome },
        handoff: reason,
      }),
    })
    await api.commentOnIssue(
      row.repository,
      this.c.token,
      row.issueNumber,
      [
        `The factory could not get this approved: ${reason}.`,
        '',
        `Its work is in the draft pull request ${pull.url}, with the checks that passed and what the reviewer still found.`,
        '',
        outcome.findings.length > 0 ? renderFindings(outcome.findings) : outcome.summary,
      ].join('\n'),
    )
    const handed = await this.deliver(sha, pull.url, attempt)
    await enterStage(
      deps.db,
      taskId,
      'handoff',
      {
        branch,
        sha,
        reason,
        pullRequestUrl: pull.url,
        findings: outcome.findings,
        costUsd: this.cost,
        attempts: attempt,
        ...describeDelivery(handed),
      },
      { pullRequestUrl: pull.url },
    )
    return {
      status: 'handoff',
      branch,
      sha,
      pullRequestUrl: pull.url,
      reason,
      preRelease: 'tag' in handed ? handed.tag : undefined,
    }
  }

  /**
   * Checks the commit and has it reviewed, up to three attempts. Failing checks and a review that
   * asks for changes send the work back to the same agent session; an approval opens the pull request,
   * and running out of attempts after green checks hands the work to a person.
   */
  async loop(pushed: string): Promise<RunResult> {
    let sha = pushed
    for (let attempt = this.c.resuming?.attempt ?? 1; ; attempt++) {
      const canRework =
        attempt < MAX_ATTEMPTS && this.builder.resume !== undefined && !!this.sessionId
      const checked = await this.verify(sha, attempt)

      if (!checked.verdict.open) {
        if (!canRework) {
          const after = attempt > 1 ? ` (after ${attempt} attempts)` : ''
          throw new StageFailure(`no pull request: ${checked.verdict.reasons.join('; ')}${after}`)
        }
        sha = await this.rework(attempt + 1, [], failingChecks(checked.results))
        continue
      }

      const outcome = await this.review(sha, attempt)
      if (outcome.verdict === 'approve') return this.approved(sha, attempt, checked.here, outcome)
      if (outcome.verdict === 'changes' && canRework) {
        sha = await this.rework(attempt + 1, outcome.findings, [])
        continue
      }
      return this.handOver(sha, attempt, checked.here, outcome)
    }
  }
}
