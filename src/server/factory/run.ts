import { randomUUID } from 'node:crypto'

import { type SandboxBackend } from '@theokit/agents/sandbox'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'

import {
  agentRun,
  changePlan,
  evidence,
  question as questionTable,
  review as reviewTable,
  stageEvent,
  task,
} from '../db/schema'
import type { Issue } from '../github/issues'
import { NEEDS_A_PERSON, type GithubApi } from '../github/pulls'
import { KnowledgeFeed } from '../knowledge/feed'
import { parseLearned, withoutLearned } from '../knowledge/format'

import { cloneRepository } from './clone'
import {
  CONFLICT_NOTE_OPENING,
  conflictingFiles,
  mergeIntegration,
  withConflictFiles,
} from './merge-base'
import { evidenceOfNote } from './ci-wait'
import { BaseProbe, sameChecks } from './base-checks'
import { ensureBranches, integrationBranch } from './branches'
import { uploadChangesetCheck } from './changeset-check'
import { withChangesetCheck } from './changesets'
import { githubEgress, renewGithubCredential } from './credential-renewal'
import { deliverPreRelease, describeDelivery, type Handed } from './integration'
import { enterMerge } from './merge-task'
import { heldForEvaluation, heldForReview } from '../evals/cases'
import {
  DEFAULT_CHECKS,
  failingChecks,
  gate,
  runChecks,
  type CheckResult,
  type Verdict,
} from './evidence'
import { FIX_COMMIT_MESSAGE, fixDetail, runFixes, type FixedRound } from './fixes'
import { NO_CHANGE, NO_PULL_REQUEST } from './failure-reasons'
import { diffFacts } from './diff-facts'
import {
  changePlanPrompt,
  givenPlanPrompt,
  implementPlanPrompt,
  parseChangePlan,
  planAgainPrompt,
  renderChangePlan,
  type ChangePlan,
} from './change-plan'
import { buildPrompt, type Clarification, type CodingHarness, type HarnessResult } from './harness'
import {
  blockingCount,
  MAX_ATTEMPTS,
  notResolvedPrompt,
  OUTSIDE_THE_PLAN,
  parseVerdict,
  renderFindings,
  resolvedPrompt,
  reviewAllowsRework,
  reviewPrompt,
  reworkPrompt,
  roundsNote,
  type EarlierReview,
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
  squashTitle,
  pullRequestBody,
  pushWithRetry,
  resolvedComment,
  Asked,
  BaseConflict,
  BaseRed,
  QuotaStop,
  StageFailure,
  type Continuation,
  type StoredCheck,
} from './run-support'
import {
  fitToSession,
  planAgentPass,
  DEFAULT_CHECK_MS,
  DEFAULT_REVIEW_MS,
  NoTimeForAgent,
} from './agent-time'
import type { RepoConfig } from './repo-config'
import { labelsWithRepoChoice } from './repo-config'
import type { HandoffCause, Parked, RunResult, RunTaskDeps } from './run-types'
import {
  createIsolatedSandbox,
  restoreIsolatedSandbox,
  type IsolatedSandbox,
  type EgressRule,
  type SandboxSpec,
} from './sandbox'
import { enterRunStage } from './stages'
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
  continuation?: Continuation
  /**
   * What was asked of a run that could not continue: the task's branch is not on GitHub, so the run starts
   * from the integration branch as a first run does, and only the builder's prompt knows it was sent back.
   */
  startingOver?: Continuation
  /** The owner's answers to the questions the scheduler asked on the issue before any run. */
  clarifications?: Clarification[]
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

/** Why approved work is handed to a person instead of integrated, said on the issue and the task. */
type Held = { headline: string; reason: string; cause: HandoffCause }

/** A commit of the run that passed the checks and was reviewed without an approval, with that review. */
type Reviewed = {
  sha: string
  attempt: number
  here: StoredCheck[]
  outcome: ReviewVerdict
  counts: number[]
}

/**
 * The hold of approved work that changes the agents' configuration or the quality gates (#139), or nothing.
 * The first waits for an evaluation; the second for the owner's reading, since no evaluation measures a gate.
 */
export function heldFor(evaluated: string[], reviewed: string[]): Held | undefined {
  const steps = [
    evaluated.length > 0 &&
      `run \`pnpm evals:check\` against the recorded baseline for the agent configuration (${evaluated.join(', ')})`,
    reviewed.length > 0 &&
      `read the change to the quality gates (${reviewed.join(', ')}), which no evaluation measures`,
  ].filter((step): step is string => typeof step === 'string')
  if (steps.length === 0) return undefined
  return {
    headline: 'The reviewer approved this, and it waits for a person',
    reason: `it changes what the factory never integrates on its own: ${steps.join(', and ')}; then merge the pull request yourself, and the factory takes it to the release`,
    cause: 'agent_configuration',
  }
}

/** The stages that end a run; a task goes through them again when a person sends it back. */
const ENDING_STAGES = ['done', 'released', 'handoff', 'failed', 'cancelled'] as const

export const DEFAULT_TIMEOUTS: Timeouts = { sandboxMs: 90 * 60_000, agentMs: 45 * 60_000 }

/** The longest the planning turn may take: it reads and writes a plan, it does not build or test. */
export const PLAN_MS = 15 * 60_000

/** The result of running the checks on a commit: what ran, what it adds up to, and what to show. */
type Checked = { results: CheckResult[]; here: StoredCheck[]; verdict: Verdict }

/** Per run, keyed by its egress rules: puts one rule in the firewall through the run's queue of changes. */
const refreshers = new WeakMap<EgressRule[], (rule: EgressRule) => Promise<void>>()

/**
 * One run of a task, from the sandbox to the approval. It holds what changes as the run goes
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
  /** The clone holds `.changeset/config.json`: the repository publishes with changesets. */
  usesChangesets = false
  /** What the builder meant to change, written before it changed anything; the reviewer measures the diff by it. */
  plan: ChangePlan | undefined
  /** This run wrote the plan, so the first build pass continues the planning session. */
  private planned: { discarded: boolean } | undefined
  /** Every path the change under review touches, as the last review read it. */
  private touched: string[] = []
  /** Whether the checks the run failed fail on the base too, asking each check at most once (#219). */
  private readonly baseProbe = new BaseProbe()
  /** The last review of this run that asked for changes: the next round starts from its findings. */
  private earlier: EarlierReview | undefined
  /** What the agents of this task do, written while they work. Opened by the first agent run. */
  private transcript: Transcript | undefined

  /** When the current sandbox started; a renewed session starts its provider's clock again. */
  private sessionStartedAt: number

  /** The agent that writes the change plan: the builder, unless the owner chose another for the role. */
  private planner: CodingHarness | undefined

  /** The plan another agent wrote, which the builder's first pass is given as text. */
  private plannedBy: string | undefined

  private constructor(
    private readonly c: RunContext,
    private readonly builder: CodingHarness,
    private readonly reviewer: CodingHarness,
    private sandbox: IsolatedSandbox,
    private readonly spec: SandboxSpec,
    private readonly repoDir: string,
    private readonly baseSha: string,
    /** When the first sandbox started, which is when the run's time began to run out. */
    private readonly startedAt: number,
  ) {
    this.sessionStartedAt = startedAt
    this.cost = c.resuming?.costUsd ?? 0
    this.sessionId = c.resuming?.sessionId
  }

  /** The plan as markdown, for the pull request; nothing when the task has none. */
  private get renderedPlan(): string | undefined {
    return this.plan ? renderChangePlan(this.plan) : undefined
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
    return fitToSession(this.c.deps.timeouts ?? DEFAULT_TIMEOUTS, this.c.deps.sandbox.maxSessionMs)
  }
  /**
   * How long the next agent pass may take. When the provider's session has no room for it but the run does,
   * the disk moves to a new session first. Throws when the run has too little time left for a pass.
   */
  private async agentTimeout(): Promise<number> {
    const plan = this.planPass()
    if (plan.kind === 'pass') return plan.timeoutMs
    await this.renewSession()
    const renewed = this.planPass()
    if (renewed.kind === 'pass') return renewed.timeoutMs
    throw new StageFailure('a new sandbox session still had no room for an agent pass')
  }
  private planPass() {
    const { deps } = this.c
    const now = Date.now()
    const limits = deps.timeouts ?? DEFAULT_TIMEOUTS
    const cap = deps.sandbox.maxSessionMs
    try {
      return planAgentPass(
        limits,
        { runElapsedMs: now - this.startedAt, sessionElapsedMs: now - this.sessionStartedAt },
        cap === undefined
          ? undefined
          : { maxSessionMs: cap, renewable: !!this.sandbox.snapshot && !!deps.sandbox.restore },
      )
    } catch (error) {
      if (error instanceof NoTimeForAgent) throw new StageFailure(error.message)
      throw error
    }
  }

  /**
   * Moves the run to a new sandbox session: the disk goes to a snapshot (which stops the sandbox), comes back
   * in a new sandbox under the same egress policy, and the snapshot is deleted. The checkout, the agent's
   * session files and the knowledge base come with the disk, so the next pass continues where it was.
   */
  private async renewSession(): Promise<void> {
    const { deps, taskId, state } = this.c
    const minutes = Math.floor((Date.now() - this.sessionStartedAt) / 60_000)
    state.current = 'sandbox'
    // The same rules, with the token the run holds now rather than the one it started with.
    // In place, so the renewal of the new session and a later refusal both work on these rules.
    this.spec.egress.forEach((rule, i) => {
      if (rule.domain === 'github.com') this.spec.egress[i] = githubEgress(this.c.token)
    })
    const spec = this.spec
    this.feed?.stop()
    const snapshotId = await this.sandbox.snapshot!()
    let restored: IsolatedSandbox
    try {
      restored = await restoreIsolatedSandbox(deps.sandbox, snapshotId, spec)
    } catch (error) {
      await deps.sandbox.deleteSnapshot?.(snapshotId).catch(() => {})
      throw error
    }
    this.sessionStartedAt = Date.now()
    const sandbox = Run.withCredentials(this.c, restored, this.spec.egress)
    state.sandbox = sandbox
    // The snapshot did its job; keeping it only costs storage.
    await deps.sandbox.deleteSnapshot?.(snapshotId).catch(() => {})
    this.feed = await KnowledgeFeed.open(deps.knowledge, sandbox.backend, this.c.row.repository, {
      taskId,
    })
    this.sandbox = this.feed.attachTo(sandbox)
    state.sandbox = this.sandbox
    await enterRunStage(deps.db, taskId, 'sandbox', {
      provider: deps.sandbox.name,
      renewed: true,
      sessionMinutes: minutes,
    })
  }

  /**
   * The sandbox with its GitHub token renewed while the run works, since a run may outlast a token. Every
   * change of the firewall goes through one queue and is built from `egress` as it is when it is sent, so a
   * GitHub renewal never puts back an old Codex token and a Codex renewal never puts back an old GitHub one.
   */
  private static withCredentials(
    c: RunContext,
    started: IsolatedSandbox,
    egress: SandboxSpec['egress'],
  ): IsolatedSandbox {
    let queue: Promise<unknown> = Promise.resolve()
    const serial = <T>(step: () => Promise<T>): Promise<T> => {
      const done = queue.then(step)
      queue = done.catch(() => {})
      return done
    }
    const put = (rule: EgressRule) => {
      const i = egress.findIndex((known) => known.domain === rule.domain)
      if (i >= 0) egress[i] = rule
    }
    const update = started.updateEgress?.bind(started)
    const serialized: IsolatedSandbox = update
      ? {
          ...started,
          updateEgress: (rules) =>
            serial(async () => {
              const github = rules.find((rule) => rule.domain === 'github.com')
              if (github) put(github)
              await update([...egress])
            }),
        }
      : started
    if (update) {
      refreshers.set(egress, (rule) =>
        serial(async () => {
          put(rule)
          await update([...egress])
        }),
      )
    }
    return renewGithubCredential(serialized, egress, {
      mint: async () => (await c.deps.github.installationToken(c.row.repository)).token,
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
  }
  private get title() {
    return squashTitle(this.c.issue.title, this.c.row.issueNumber)
  }
  private get fixes(): string[] {
    return this.c.repo.fixes ?? []
  }
  /** The fix commit pushed for an agent that changed nothing: the work is that commit. */
  private pushedFix: string | undefined
  /** The last commit the fixes ran on or made, so they never run twice on the same commit. */
  private fixedHead: string | undefined
  private get checks() {
    return withChangesetCheck(
      this.c.repo.checks ?? this.c.deps.checks ?? DEFAULT_CHECKS,
      this.usesChangesets,
      integrationBranch(this.c.repo),
    )
  }

  /**
   * Starts the sandbox (new, or restored from a snapshot), puts the repository on the branch, and
   * prepares the agents. The agents come from the issue's labels, and each signs its own calls: its
   * secret is read here, on the host, and becomes a firewall rule, so the sandbox never holds one.
   */
  static async open(given: RunContext): Promise<Run> {
    const c = await Run.withoutLostBranch(given)
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
    const planner = deps.planner?.(labels, builder.name) ?? builder
    const agents = [builder, reviewer, planner].filter(
      (agent, at, all) => all.findIndex((other) => other.name === agent.name) === at,
    )
    const agentEgress = mergeEgress(await Promise.all(agents.map((a) => a.egress())))

    const spec: SandboxSpec = {
      timeoutMs: fitToSession(deps.timeouts ?? DEFAULT_TIMEOUTS, deps.sandbox.maxSessionMs)
        .sandboxMs,
      cacheKey: c.row.repository,
      egress: [
        githubEgress(c.token),
        ...agentEgress,
        { domain: 'registry.npmjs.org' },
        ...c.repo.egress.map((domain) => ({ domain })),
      ],
    }
    // The run is named on the task before the sandbox exists, so the supervisor never sees a sandbox whose
    // run the task does not know.
    const sandboxRun = randomUUID()
    await deps.db.update(task).set({ sandboxRun }).where(eq(task.id, c.taskId))
    spec.owner = { owner: 'task', taskId: c.taskId, run: sandboxRun }
    const startedAt = Date.now()
    const started = resuming
      ? await restoreIsolatedSandbox(deps.sandbox, resuming.snapshotId, spec)
      : await createIsolatedSandbox(deps.sandbox, spec)
    c.state.sandbox = started
    const sandbox = Run.withCredentials(c, started, spec.egress)
    c.state.sandbox = sandbox
    // The snapshot did its job; keeping it only costs storage.
    if (resuming) await deps.sandbox.deleteSnapshot?.(resuming.snapshotId).catch(() => {})
    // A renewed session replaces the sandbox, so an abort stops the one the run is in when it comes.
    c.signal?.addEventListener('abort', () => void c.state.sandbox?.stop().catch(() => {}), {
      once: true,
    })

    const { repoDir, baseSha } = await Run.checkout(c, sandbox.backend)
    for (const agent of agents) await agent.prepare?.(sandbox.backend)
    const feed = await KnowledgeFeed.open(deps.knowledge, sandbox.backend, c.row.repository, {
      taskId: c.taskId,
    })
    // Stopping the sandbox stops the feed first, so no copy goes into a sandbox that is gone.
    c.state.sandbox = feed.attachTo(sandbox)
    const told = await Run.withConflictFiles(c, sandbox.backend, repoDir, baseSha)
    const run = new Run(told, builder, reviewer, c.state.sandbox, spec, repoDir, baseSha, startedAt)
    run.planner = planner
    run.feed = feed
    run.remoteHead = await Run.remoteHeadOf(sandbox.backend, repoDir, c.branch)
    run.usesChangesets = await Run.publishesWithChangesets(sandbox.backend, repoDir)
    // Before the builder's first pass, so it can run the check it is told to run.
    await uploadChangesetCheck(sandbox.backend, run.checks)
    return run
  }

  /**
   * Puts the repository on the task's branch. A resumed run already has its checkout, on its branch,
   * inside the snapshot. The SDK's provisioner clones with `--` and the `ext::` transport off. The work
   * starts from the integration branch: `workspace`, or the one the owner chose for the repository.
   */
  /** Whether the clone has `.changeset/config.json`; only an answer of `yes` counts. */
  private static async publishesWithChangesets(backend: SandboxBackend, repoDir: string) {
    const found = await must(
      backend,
      `test -f ${repoDir}/.changeset/config.json && echo yes || echo no`,
    )
    return found.stdout.trim() === 'yes'
  }

  /**
   * A run sent back continues on the task's branch only while GitHub has it. A task resolved with no change
   * never pushed one, and a retry deletes it: fetching it would fail the task before any agent read the note
   * (paulohenriquevn/aifactory#54). Such a run starts over instead, and keeps what was asked for its prompt.
   */
  private static async withoutLostBranch(c: RunContext): Promise<RunContext> {
    if (!c.continuation) return c
    const head = await c.api.branchHead(c.row.repository, c.token, c.branch)
    return head ? c : { ...c, continuation: undefined, startingOver: c.continuation }
  }

  /**
   * A send-back for a conflict with the integration branch is told which files git finds in conflict. When
   * git cannot say, the agent keeps the note as it was: a guessed list would send it to the wrong files.
   */
  private static async withConflictFiles(
    c: RunContext,
    backend: SandboxBackend,
    repoDir: string,
    baseSha: string,
  ): Promise<RunContext> {
    const feedback = c.continuation?.feedback
    if (!c.continuation || !feedback?.startsWith(CONFLICT_NOTE_OPENING)) return c
    try {
      const files = await conflictingFiles(backend, `git -C ${repoDir}`, baseSha)
      return {
        ...c,
        continuation: { ...c.continuation, feedback: withConflictFiles(feedback, files) },
      }
    } catch {
      return c
    }
  }

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
    role: 'builder' | 'planner' | 'reviewer',
    attempt: number,
    call: (onEvent: (event: AgentEvent) => void) => Promise<HarnessResult>,
  ): Promise<HarnessResult> {
    const { db } = this.c.deps
    const { taskId } = this.c
    this.transcript ??= await Transcript.open(db, taskId)
    const started = Date.now()
    let result: HarnessResult
    try {
      result = await call(this.transcript.sink(role === 'planner' ? 'builder' : role, attempt))
      if (result.unauthorized && who.reauthorize) {
        await this.transcript.drain()
        result = await this.afterRefusal(who, role, attempt, call)
      }
    } catch (error) {
      await this.transcript.drain()
      // The agent did not come back (the sandbox died, say, or its login could not be renewed). It still ran,
      // and that is on record.
      await db.insert(agentRun).values({
        taskId,
        role,
        harness: who.name,
        model: who.model ?? null,
        effort: who.effort ?? null,
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
      // What the agent says it ran, else what it was told; null when neither is known, never a guess.
      model: result.model === undefined ? (who.model ?? null) : result.model,
      effort: who.effort ?? null,
      tokensIn: result.tokensIn ?? null,
      tokensOut: result.tokensOut ?? null,
      attempt,
      costUsd: result.costUsd ?? null,
      durationMs: Date.now() - started,
      ok: result.ok,
      quota: result.quota !== undefined,
      sessionId: result.sessionId ?? null,
    })
    // A builder cut at its limit goes on to `failUnfinished`, which keeps what it wrote before the quota is told.
    if (result.quota && !(role === 'builder' && result.timedOut)) throw this.quotaStop(who, result)
    return result
  }

  private quotaStop(who: CodingHarness, result: HarnessResult): QuotaStop {
    const quota = result.quota
    if (!quota) throw new Error('a quota stop needs a quota')
    const resets = quota.resetsAt ? `, resets ${quota.resetsAt}` : ''
    return new QuotaStop(`the ${who.name} quota ran out${resets}: ${quota.message}`, quota.resetsAt)
  }

  /**
   * The provider refused the agent's login. Renews it once for the token the sandbox signs with, gives the
   * firewall the new one, and runs the pass again. A login that cannot be renewed, or is refused again, is a
   * fault of the environment, not of the work: the task waits to retry, and the owner connects Codex again.
   */
  private async afterRefusal(
    who: CodingHarness,
    role: 'builder' | 'planner' | 'reviewer',
    attempt: number,
    call: (onEvent: (event: AgentEvent) => void) => Promise<HarnessResult>,
  ): Promise<HarnessResult> {
    const refused = `the ${who.name} login was refused by the provider`
    const rules = this.spec.egress
    const at = rules.findIndex((rule) => rule.domain === 'chatgpt.com')
    const installed = rules[at]?.headers?.authorization?.replace(/^Bearer /, '')
    if (!who.reauthorize || at < 0 || !installed) {
      throw new StageFailure(`${refused}: connect Codex again from the Setup page`)
    }
    try {
      const push = refreshers.get(rules)
      for (const rule of await who.reauthorize(this.backend, installed)) {
        if (push) await push(rule)
        else {
          const i = rules.findIndex((known) => known.domain === rule.domain)
          if (i >= 0) rules[i] = rule
          await this.sandbox.updateEgress?.(rules)
        }
      }
    } catch (error) {
      throw new StageFailure(
        `Codex login was refused and could not be renewed (${error instanceof Error ? error.message : String(error)}): connect Codex again from the Setup page`,
      )
    }
    const again = await call(this.transcript!.sink(role === 'planner' ? 'builder' : role, attempt))
    if (again.unauthorized) {
      const now = rules[at]?.headers?.authorization?.replace(/^Bearer /, '')
      if (now) await who.markRefused?.(now).catch(() => {})
      throw new StageFailure(
        'Codex login was refused again after it was renewed: connect Codex again from the Setup page',
      )
    }
    return again
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
    await enterRunStage(deps.db, taskId, 'waiting', {
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

  /**
   * Whether the checkout started from the work branch GitHub holds rather than from the base: a continuation
   * checks that branch out, and a run resumed from a snapshot comes back on whatever its first run had.
   */
  private async startedFromBranch(): Promise<boolean> {
    if (!this.remoteHead) return false
    const head = (await must(this.backend, `git -C ${this.repoDir} rev-parse HEAD`)).stdout.trim()
    return head !== this.baseSha
  }

  private async hasNothingToCommit(): Promise<boolean> {
    const pending = await must(this.backend, `git -C ${this.repoDir} status --porcelain`)
    return pending.stdout.trim() === '' && !(await this.hasUnpushedCommits())
  }

  /**
   * Whether the branch has commits GitHub does not: the agent may commit by itself, as `git merge` does, and
   * leave nothing uncommitted. Counted from the head the branch had on GitHub, or from the base on a new one.
   */
  private async hasUnpushedCommits(): Promise<boolean> {
    const since = this.remoteHead || this.baseSha
    const counted = await must(
      this.backend,
      `git -C ${this.repoDir} rev-list --count ${since}..HEAD`,
    )
    return Number(counted.stdout.trim()) > 0
  }

  /** Commits whatever the agent left in the checkout and pushes it. Returns the new head. */
  private async commitAndPush(message: string, detail: Record<string, unknown>): Promise<string> {
    const { deps, taskId, branch, state } = this.c
    const { backend, git } = this
    state.current = 'push'
    await enterRunStage(deps.db, taskId, 'push', { branch, ...detail })
    const changes = await must(backend, `git -C ${this.repoDir} status --porcelain`)
    const uncommitted = changes.stdout.trim() !== ''
    if (!uncommitted && !(await this.hasUnpushedCommits())) {
      // A rework that changed nothing is the reviewer's business, not a fact about the issue.
      if (!detail.rework) await this.keepNoChange()
      throw new StageFailure(
        `${NO_CHANGE}${
          this.summary ? `. The agent said: ${oneLine(this.summary).slice(0, 700)}` : ''
        }`,
      )
    }
    // Text that came from outside (the issue title, the author) goes in by file, so none of it is
    // ever parsed by a shell (the SDK does not export its quoting helper: usetheokit/theokit#1131).
    // What the agent committed by itself (a merge, say) goes as it is, with nothing added to it.
    if (uncommitted) {
      await backend.uploadFile(GITCONFIG, gitConfig(deps.author))
      await backend.uploadFile(COMMIT_MESSAGE, `${message}\n`)
      await must(backend, `${git} add -A`)
      await must(backend, `${git} commit -F ${COMMIT_MESSAGE}`)
    }
    // What is about to leave the sandbox, kept so a refused push can be explained.
    const since = uncommitted ? 'HEAD~1' : this.remoteHead || this.baseSha
    const files = (await must(backend, `${git} diff --name-status ${since} HEAD`)).stdout.trim()
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

  /**
   * A pass that did not finish fails the run. One cut at its time limit leaves what it wrote in the
   * checkout, which the sandbox takes away: it is committed and pushed first, and the reason names it.
   */
  private async failUnfinished(result: HarnessResult, what: string): Promise<never> {
    const plain = `${what}: ${result.summary}`
    // A quota stop keeps its reset, so the retry still waits for it, whatever became of the work.
    const stop = (note: string) =>
      result.quota
        ? new QuotaStop(
            `${this.quotaStop(this.builder, result).message}\n${note}`,
            result.quota.resetsAt,
          )
        : new StageFailure(`${plain}\n${note}`)
    if (!result.timedOut || (await this.hasNothingToCommit())) {
      throw result.quota ? this.quotaStop(this.builder, result) : new StageFailure(plain)
    }
    let sha: string
    try {
      sha = await this.commitAndPush(
        `${this.title}: work in progress, the agent reached its time limit`,
        { timedOut: true },
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw stop(`the work could not be kept: ${reason}`)
    }
    throw stop(
      `the work was kept in commit ${sha} on ${this.c.branch}; send the task back to continue from it`,
    )
  }

  /** The first pass of the builder: a new one, or the session resumed with the answer it was waiting for. */
  private async firstPass(): Promise<HarnessResult> {
    const { deps, taskId, resuming } = this.c
    const timeoutMs = await this.agentTimeout()
    const { builder, backend, repoDir } = this
    if (resuming) {
      if (!builder.resume) throw new StageFailure(`${builder.name} cannot resume a session`)
      await enterRunStage(deps.db, taskId, 'build', {
        ...agentFacts(builder),
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
          timeoutMs,
          prompt,
        }),
      )
    }
    await enterRunStage(deps.db, taskId, 'build', {
      ...agentFacts(builder),
      attempt: 1,
      ...(this.feed?.delivered ? { knowledge: this.feed.delivered } : {}),
      ...(this.planned ? { planned: true } : {}),
    })
    if (this.plan && this.plannedBy) {
      const prompt = givenPlanPrompt(this.buildInput(), this.plan, this.plannedBy)
      return this.settle(builder, 'builder', 1, (onEvent) =>
        builder.run(backend, { onEvent, cwd: repoDir, timeoutMs, prompt }),
      )
    }
    if (this.planned && this.sessionId) {
      const prompt = implementPlanPrompt(this.planned)
      const sessionId = this.sessionId
      return this.settle(builder, 'builder', 1, (onEvent) =>
        builder.resume!(backend, sessionId, { onEvent, cwd: repoDir, timeoutMs, prompt }),
      )
    }
    return this.settle(builder, 'builder', 1, (onEvent) =>
      builder.run(backend, {
        onEvent,
        cwd: repoDir,
        timeoutMs,
        prompt: buildPrompt(this.buildInput()),
      }),
    )
  }

  /** What the builder is told about the issue and its rules, the same for the plan and the work. */
  private buildInput(): Parameters<typeof buildPrompt>[0] {
    const { row, issue, branch, startingOver } = this.c
    const sentBack = this.c.continuation ?? startingOver
    return {
      repo: row.repository,
      issueNumber: row.issueNumber,
      title: issue.title,
      body: issue.body,
      branch,
      feedback: sentBack?.feedback,
      feedbackFrom: sentBack?.fromChecks ? 'checks' : 'person',
      startsOver: startingOver !== undefined,
      askQuestions: this.c.repo.askQuestions,
      knowledgeDir: this.feed?.dir,
      checks: this.checks,
      clarifications: this.c.clarifications,
    }
  }

  /**
   * Before it changes anything, the builder writes what it will change: the files, the order, the risks,
   * the proof and what it leaves out. The plan is stored and the build continues the same session. A run
   * that continues the task (an answer, a person's changes, the repository's checks) keeps the plan the
   * task has, and so does a builder that cannot resume a session, which plans nothing here.
   */
  private async planChange(): Promise<void> {
    const { deps, taskId, resuming, continuation, state } = this.c
    if (resuming || continuation) {
      this.plan = await this.storedPlan()
      return
    }
    if (!(deps.planFirst ?? true) || !this.builder.resume) return
    // Reading and planning is short; the rest of the pass is left to the work.
    const timeoutMs = Math.min(await this.agentTimeout(), PLAN_MS)
    const planner = this.planner ?? this.builder
    const apart = planner.name !== this.builder.name
    if (apart && !planner.resume) {
      throw new StageFailure(
        `${planner.name} cannot plan: it cannot resume a session to be asked again`,
      )
    }
    state.current = 'plan'
    await enterRunStage(deps.db, taskId, 'plan', agentFacts(planner))
    const prompt = changePlanPrompt(this.buildInput())
    const first = await this.settle(planner, 'planner', 1, (onEvent) =>
      planner.run(this.backend, { onEvent, cwd: this.repoDir, timeoutMs, prompt }),
    )
    if (!first.ok) throw new StageFailure(`the agent did not finish the plan: ${first.summary}`)
    // The planner's session is the builder's only when they are the same agent.
    const session = first.sessionId ?? (apart ? undefined : this.sessionId)
    if (!apart) this.sessionId = session
    const plan =
      parseChangePlan(first.summary) ?? (await this.planAgain(planner, session, timeoutMs))
    const discarded = await this.discardEdits()
    await deps.db.insert(changePlan).values({
      taskId,
      baseSha: this.baseSha,
      harness: planner.name,
      plan,
    })
    this.plan = plan
    this.planned = { discarded }
    this.plannedBy = apart ? planner.name : undefined
  }

  /** The planning turn ended with no plan that could be read: one more turn, asking for the plan alone. */
  private async planAgain(
    planner: CodingHarness,
    sessionId: string | undefined,
    timeoutMs: number,
  ): Promise<ChangePlan> {
    if (!sessionId)
      throw new StageFailure('the agent wrote no plan and gave no session to ask again')
    const again = await this.settle(planner, 'planner', 1, (onEvent) =>
      planner.resume!(this.backend, sessionId, {
        onEvent,
        cwd: this.repoDir,
        timeoutMs,
        prompt: planAgainPrompt(),
      }),
    )
    if (planner.name === this.builder.name) this.sessionId = again.sessionId ?? this.sessionId
    const plan = again.ok ? parseChangePlan(again.summary) : undefined
    if (!plan)
      throw new StageFailure(`the agent wrote no plan: ${oneLine(again.summary).slice(0, 700)}`)
    return plan
  }

  /** Puts back the checkout the planning turn was not to change. Says whether there was anything to put back. */
  private async discardEdits(): Promise<boolean> {
    const pending = await must(this.backend, `git -C ${this.repoDir} status --porcelain`)
    if (pending.stdout.trim() === '') return false
    await must(this.backend, `git -C ${this.repoDir} reset --hard ${this.baseSha}`)
    await must(this.backend, `git -C ${this.repoDir} clean -fd`)
    return true
  }

  /** The latest plan of the task, written by an earlier run. */
  private async storedPlan(): Promise<ChangePlan | undefined> {
    const [latest] = await this.c.deps.db
      .select()
      .from(changePlan)
      .where(eq(changePlan.taskId, this.c.taskId))
      .orderBy(desc(changePlan.id))
      .limit(1)
    return latest?.plan as ChangePlan | undefined
  }

  private firstMessage(): string {
    if (this.c.resuming) return `${this.title}: continue after an answer`
    if (this.c.continuation) return `${this.title}: address requested changes`
    return this.title
  }

  /**
   * A run that was sent back changed nothing, and no review approved the head of its branch: an earlier run
   * fixed what was asked and stopped before a review, or a person pushed the fix. Ending here would deliver
   * work nobody checked, so the run goes on from that head. That holds for a send-back with the factory's own
   * note too (`fromChecks`: the coordinator's after a run that ran out of time or changed nothing): the head a
   * failed check sent back was approved, so that case still reaches `checksUnanswered`.
   */
  private async unreviewedHeadLeftAsItIs(): Promise<boolean> {
    const { continuation, deps, taskId } = this.c
    if (!continuation || continuation.plain || !this.remoteHead) {
      return false
    }
    if (!(await this.hasNothingToCommit())) return false
    const [approved] = await deps.db
      .select({ id: reviewTable.id })
      .from(reviewTable)
      .where(
        and(
          eq(reviewTable.taskId, taskId),
          eq(reviewTable.sha, this.remoteHead),
          eq(reviewTable.verdict, 'approve'),
        ),
      )
      .limit(1)
    return !approved
  }

  /** The task's recorded pull request, read by its number; undefined when none is recorded or it cannot be read as one. */
  private async recordedPullRequest() {
    const { row, api } = this.c
    const number = Number(/\/pull\/(\d+)$/.exec(row.pullRequestUrl ?? '')?.[1])
    if (!this.c.continuation || !number) return undefined
    // A pull request that is gone is not one to reopen. One that could not be read is not judged as if its
    // state were known: the error fails the run, which repeats when GitHub was only failing.
    return api.readPullRequest(row.repository, this.c.token, number).catch((error: unknown) => {
      if (/^GitHub answered 404\b/.test(error instanceof Error ? error.message : ''))
        return undefined
      throw error
    })
  }

  /**
   * A task sent back on its branch whose recorded pull request is closed (not merged): GitHub keeps the old
   * head of a closed pull request, so judging it would judge a stale commit. When the agent changed nothing,
   * the run goes on with the branch's head to the checks and the review; `reopenedOrEmpty` then settles the
   * pull request before one is opened.
   */
  private async closedPullRequestContinued(): Promise<{ sha: string } | undefined> {
    const { continuation } = this.c
    if (!continuation || continuation.plain || !this.remoteHead) return undefined
    const pull = await this.recordedPullRequest()
    if (!pull || pull.state !== 'closed' || pull.merged) return undefined
    if (!(await this.hasNothingToCommit())) return undefined
    return { sha: this.remoteHead }
  }

  /**
   * Before a pull request is opened for a run sent back: when the recorded one is closed and unmerged, it is
   * reopened (GitHub moves its head to the branch) if the branch has something ahead of its base. A branch
   * with nothing ahead can have no pull request (GitHub rejects an empty one), so the task is handed over
   * with that said instead of failing after the checks and the review.
   */
  private async reopenedOrEmpty(sha: string): Promise<RunResult | undefined> {
    const { deps, taskId, row, api, branch } = this.c
    const pull = await this.recordedPullRequest()
    if (!pull || pull.state === 'open') return undefined
    const base = integrationBranch(this.c.repo)
    const ahead = await api.branchAhead(row.repository, this.c.token, base, branch)
    if (ahead && ahead.aheadBy > 0) {
      // A merged one stays merged; a closed one that GitHub will not reopen is replaced by a new one.
      if (!pull.merged) {
        await api.reopenPullRequest(row.repository, this.c.token, pull.number).catch((error) =>
          console.warn(
            JSON.stringify({
              event: 'pull_request_reopen_failed',
              taskId,
              repository: row.repository,
              pullRequest: pull.number,
              fallback: 'a new pull request is opened from the branch',
              error: String(error),
            }),
          ),
        )
      }
      return undefined
    }
    const reason = `the pull request ${pull.url} is ${pull.merged ? 'merged' : 'closed'} and the branch has nothing ahead of ${base}, so there is nothing to open a pull request for`
    await enterRunStage(deps.db, taskId, 'handoff', {
      branch,
      sha,
      reason,
      cause: 'checks_unchanged' satisfies HandoffCause,
      pullRequestUrl: pull.url,
      unchanged: true,
      agentSummary: this.summary.slice(0, 4_000),
      costUsd: this.cost,
    })
    return { status: 'handoff', branch, sha, pullRequestUrl: pull.url, reason }
  }

  /**
   * A person asked for a change and the agent found nothing to change (the test was already there,
   * say). That is an answer, not a failure: the pull request stays as it was, and the person reads why.
   */
  private async answeredWithNoChange(first: HarnessResult): Promise<RunResult | undefined> {
    const { deps, taskId, row, api, branch, continuation } = this.c
    // A plain continuation was asked nothing, so leaving the pull request as it is answers nothing.
    if (!continuation || continuation.plain || !row.pullRequestUrl || !row.headSha) return undefined
    if (!(await this.hasNothingToCommit())) return undefined
    if (continuation.fromChecks) return this.checksUnanswered(first)
    await api.commentOnIssue(
      row.repository,
      this.c.token,
      row.issueNumber,
      `You asked for changes. The agent left the pull request as it is:\n\n${first.summary.slice(0, 3_000)}`,
    )
    await enterRunStage(deps.db, taskId, 'done', {
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
   * The repository's required checks failed and the agent changed nothing, saying why (often a check that
   * fails on the integration branch too). Its auto-merge is already off and its wait over, so leaving the
   * task done would leave it nowhere: it goes to a person, with the agent's words on the issue.
   */
  private async checksUnanswered(first: HarnessResult): Promise<RunResult> {
    const { deps, taskId, row, api, branch } = this.c
    const evidence = evidenceOfNote(this.c.continuation?.feedback ?? '')
    const reason =
      "the repository's required checks failed and the agent changed nothing, saying why below" +
      (evidence ? `. What the failed checks reported:\n\n${evidence}` : '')
    const said = first.summary.slice(0, 3_000)
    await api.commentOnIssue(
      row.repository,
      this.c.token,
      row.issueNumber,
      `The repository's required checks failed on ${row.pullRequestUrl}, and the agent left it as it is:\n\n${said}${evidence ? `\n\nWhat the failed checks reported:\n\n${evidence}` : ''}`,
    )
    await enterRunStage(deps.db, taskId, 'handoff', {
      branch,
      sha: row.headSha,
      reason,
      cause: 'checks_unchanged' satisfies HandoffCause,
      pullRequestUrl: row.pullRequestUrl,
      unchanged: true,
      agentSummary: first.summary.slice(0, 4_000),
      costUsd: this.cost,
    })
    return {
      status: 'handoff',
      branch,
      sha: row.headSha!,
      pullRequestUrl: row.pullRequestUrl!,
      reason,
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
    if (continuation || (await this.startedFromBranch())) return undefined
    if (!(await this.hasNothingToCommit())) return undefined
    // Fixes that change the start commit make this a change after all: it goes on to be committed, checked
    // and reviewed like any other, instead of a claim the checks backed only after the fix.
    const fixed = await this.applyFixes(this.baseSha, {
      costUsd: first.costUsd,
      agentSummary: first.summary.slice(0, 4_000),
      sessionId: this.sessionId,
    })
    if (fixed.fixedFrom) {
      this.pushedFix = fixed.sha
      return undefined
    }
    await this.keepNoChange()
    const said = `The agent said: ${oneLine(first.summary).slice(0, 700)}`
    const at = this.baseSha.slice(0, 7)
    const checked = await this.verify(this.baseSha, 1, { publish: false, fixed })
    if (!checked.verdict.open) {
      throw new StageFailure(
        `${NO_CHANGE}, and the checks did not pass at ${at}: ${checked.verdict.reasons.join('; ')}. ${said}`,
      )
    }
    const outcome = await this.reviewClaim(first.summary)
    const refuted = `${NO_CHANGE}, and the reviewer did not confirm the issue is resolved: ${outcome.summary}.`
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
        repository: row.repository,
      }),
    )
    await api.closeIssue(row.repository, this.c.token, row.issueNumber)
    await enterRunStage(
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
    const timeoutMs = await this.agentTimeout()
    state.current = 'build'
    await enterRunStage(deps.db, taskId, 'build', {
      ...agentFacts(this.builder),
      attempt: 1,
      refuted: true,
    })
    const result = await this.settle(this.builder, 'builder', 1, (onEvent) =>
      this.builder.resume!(this.backend, this.sessionId!, {
        onEvent,
        cwd: this.repoDir,
        timeoutMs,
        prompt: notResolvedPrompt({
          summary: outcome.summary,
          findings: outcome.findings,
          checks: this.checks,
        }),
      }),
    )
    if (!result.ok) await this.failUnfinished(result, 'the agent did not finish')
    await this.keepLearned(result.summary)
    this.sessionId = result.sessionId ?? this.sessionId
    const asked = parseQuestion(withoutLearned(result.summary))
    if (asked) await this.ask(asked, 1)
    this.summary = result.summary
    return { changed: !(await this.hasNothingToCommit()), summary: result.summary }
  }

  /** Has the reviewer check, without changing anything, that the code already resolves the issue. */
  private async reviewClaim(claim: string): Promise<ReviewVerdict> {
    const { deps, taskId, row, issue, state } = this.c
    state.current = 'review'
    await enterRunStage(deps.db, taskId, 'review', {
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
    // A claim that the issue is resolved: work missing under .github/ is still missing, so no downgrade.
    const read: ReviewVerdict = result.ok
      ? parseVerdict(result.summary, { followUpPaths: false })
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
    if (this.c.continuation?.mergeBase) return { sha: await this.mergeBase() }
    await this.planChange()
    this.c.state.current = 'build'
    const first = await this.firstPass()
    if (!first.ok) await this.failUnfinished(first, 'the agent did not finish')
    await this.keepLearned(first.summary)
    // A fact the agent left is not part of its question, wherever it put it.
    const asked = parseQuestion(withoutLearned(first.summary))
    this.sessionId = first.sessionId ?? this.sessionId
    if (asked) await this.ask(asked, this.c.resuming?.attempt ?? 1)
    this.summary = first.summary

    // Work a review never approved is not left as it is: it goes on to the checks and the review.
    if (await this.unreviewedHeadLeftAsItIs()) return { sha: this.remoteHead }
    const closed = await this.closedPullRequestContinued()
    if (closed) return closed
    const unchanged = await this.answeredWithNoChange(first)
    if (unchanged) return { result: unchanged }
    const resolved = await this.resolvedAlready(first)
    if (resolved) return { result: resolved }
    if (this.pushedFix) return { sha: this.pushedFix }
    // A continuation the agent had nothing to add to goes on with the commit the earlier run pushed, and so
    // does one resumed after an answer, which no longer carries the continuation it started as.
    const resumedOnBranch = this.c.resuming !== undefined && (await this.startedFromBranch())
    if ((this.c.continuation?.plain || resumedOnBranch) && (await this.hasNothingToCommit())) {
      return { sha: this.remoteHead }
    }
    const sha = await this.commitAndPush(this.firstMessage(), {
      costUsd: first.costUsd,
      agentSummary: first.summary.slice(0, 4_000),
      sessionId: this.sessionId,
    })
    return { sha }
  }

  /**
   * The run a fixed integration branch queued (`merge_base` in ci-wait.ts): the factory merges the head of
   * that branch, as this run cloned it, into the work branch and pushes the merge. No agent runs, because a
   * clean merge asks for no decision; the checks and the review then read the merge as any work. A conflict,
   * or a branch that already holds that commit, fails the run with the reason, for a person.
   */
  private async mergeBase(): Promise<string> {
    const { deps, branch, state } = this.c
    state.current = 'push'
    const base = `${integrationBranch(this.c.repo)} at ${this.baseSha.slice(0, 7)}`
    await this.backend.uploadFile(GITCONFIG, gitConfig(deps.author))
    const merged = await mergeIntegration(this.backend, this.git, this.baseSha)
    if ('conflicts' in merged) {
      throw new BaseConflict(integrationBranch(this.c.repo), merged.conflicts, base, branch)
    }
    if ('upToDate' in merged) {
      throw new StageFailure(
        `${branch} already holds ${base}, so merging it makes no commit for the required checks to run on again`,
      )
    }
    return this.commitAndPush(`Merge ${base} into ${branch}`, { mergeBase: this.baseSha })
  }

  /** Throws `BaseRed` when the checks the work failed fail on the integration branch too (#219). */
  private async refuseRedBase(failed: CheckResult[]): Promise<void> {
    this.c.state.current = 'verify'
    const red = await this.baseProbe.red(
      this.backend,
      {
        repoDir: this.repoDir,
        baseSha: this.baseSha,
        checks: this.checks,
        timeoutMs: this.timeouts.checkMs ?? DEFAULT_CHECK_MS,
      },
      failed,
    )
    if (red) throw new BaseRed(red, this.baseSha, integrationBranch(this.c.repo))
  }

  /**
   * Sends the work back to the builder's own session with what was wrong, and pushes the fix. Answers the new
   * head, or nothing when the builder changed nothing: that is its answer, with the reason in its summary, and
   * the loop decides what follows (#214).
   */
  private async rework(
    attempt: number,
    findings: Finding[],
    failed: CheckResult[],
    reviewedSha?: string,
  ): Promise<string | undefined> {
    const { deps, taskId, state } = this.c
    const timeoutMs = await this.agentTimeout()
    state.current = 'build'
    await enterRunStage(deps.db, taskId, 'build', {
      ...agentFacts(this.builder),
      attempt,
      rework: true,
    })
    const result = await this.settle(this.builder, 'builder', attempt, (onEvent) =>
      this.builder.resume!(this.backend, this.sessionId!, {
        onEvent,
        cwd: this.repoDir,
        timeoutMs,
        prompt: reworkPrompt({
          findings,
          failedChecks: failed,
          checks: this.checks,
          ...(reviewedSha ? { reviewedSha } : {}),
        }),
      }),
    )
    if (!result.ok) await this.failUnfinished(result, 'the agent did not finish the rework')
    this.sessionId = result.sessionId ?? this.sessionId
    const asked = parseQuestion(result.summary)
    if (asked) await this.ask(asked, attempt)
    this.summary = result.summary
    if (await this.hasNothingToCommit()) return undefined
    return this.commitAndPush(`${this.title}: address feedback (attempt ${attempt})`, {
      attempt,
      rework: true,
      costUsd: result.costUsd,
    })
  }

  /**
   * Runs the repository's fix commands on the checkout, which is at `sha` and clean, and, when they changed
   * files, commits and pushes that change as its own commit, with `detail` and their outcomes on the push.
   * A fix that fails changes nothing; the checks that follow decide. A commit the fixes already ran on or
   * made is not fixed again.
   */
  private async applyFixes(sha: string, detail: Record<string, unknown>): Promise<FixedRound> {
    if (this.fixes.length === 0 || sha === this.fixedHead) return { sha, outcomes: [] }
    const { outcomes, changed } = await runFixes(
      this.backend,
      this.repoDir,
      this.fixes,
      this.timeouts.checkMs ?? DEFAULT_CHECK_MS,
    )
    const fixed: FixedRound = changed
      ? {
          sha: await this.commitAndPush(FIX_COMMIT_MESSAGE, { ...detail, fixes: outcomes }),
          outcomes,
          fixedFrom: sha,
        }
      : { sha, outcomes }
    this.fixedHead = fixed.sha
    return fixed
  }

  /**
   * Runs the checks on the pushed commit and nothing else, stores each result, and publishes what they
   * add up to as a check run on the commit.
   */
  private async verify(
    sha: string,
    attempt: number,
    options: { publish: boolean; fixed?: FixedRound } = { publish: true },
  ): Promise<Checked> {
    const { deps, taskId, row, api, state } = this.c
    const { db } = deps
    state.current = 'verify'
    await enterRunStage(
      db,
      taskId,
      'verify',
      {
        sha,
        attempt,
        checks: this.checks.map((c) => c.name),
        ...fixDetail(options.fixed),
      },
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
    await uploadChangesetCheck(this.backend, this.checks)
    const results = await runChecks(
      this.backend,
      this.repoDir,
      this.checks,
      this.timeouts.checkMs ?? DEFAULT_CHECK_MS,
    )
    for (const check of results) await db.insert(evidence).values({ taskId, sha, ...check })
    const rows = await this.checkRuns()
    const verdict = gate({ headSha: sha, required: this.checks.map((c) => c.name), evidence: rows })
    const here = rows.filter((r) => r.sha === sha)
    // A commit of the integration branch that the run did not make gets no check run of the factory.
    if (!options.publish) return { results, here, verdict }
    await api.createCheckRun(row.repository, this.c.token, {
      name: 'aifactory/verify',
      headSha: sha,
      conclusion: verdict.open ? 'success' : 'failure',
      title: verdict.open ? 'All checks passed' : 'Checks did not pass',
      summary: checkSummary(here, row.repository),
    })
    return { results, here, verdict }
  }

  /** Every result of the factory's checks on this task, oldest first. */
  private checkRuns() {
    const { deps, taskId } = this.c
    return deps.db
      .select()
      .from(evidence)
      .where(eq(evidence.taskId, taskId))
      .orderBy(asc(evidence.id))
  }

  /** Has the reviewer read the commit, adds the facts about the diff, and records the outcome. */
  private async review(sha: string, attempt: number): Promise<ReviewVerdict> {
    const { deps, taskId, row, issue, branch, state } = this.c
    state.current = 'review'
    await enterRunStage(deps.db, taskId, 'review', {
      sha,
      attempt,
      ...reviewerFacts(this.reviewer),
    })
    const { guards, unplanned, required, touched } = await diffFacts(this.backend, this.repoDir, {
      baseSha: this.baseSha,
      plan: this.plan,
      issue,
      checkRuns: await this.checkRuns(),
    })
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
          required,
          ...(this.earlier ? { earlier: this.earlier } : {}),
          ...(this.plan
            ? { plan: this.renderedPlan, unplanned, builderSummary: this.summary }
            : {}),
        }),
      }),
    )
    this.touched = touched
    // The reviewer reads and does not write. If it wrote anyway, none of it counts.
    await must(this.backend, `git -C ${this.repoDir} reset --hard ${sha}`)
    await must(this.backend, `git -C ${this.repoDir} clean -fd`)

    const read: ReviewVerdict = result.ok
      ? parseVerdict(result.summary)
      : { verdict: 'invalid', summary: `the reviewer failed: ${result.summary}`, findings: [] }
    // A fact about the diff that an agent could bend outranks an approval.
    const blocked = read.verdict === 'approve' && guards.some((g) => g.severity !== 'minor')
    // A file outside the plan is on record; whether it was needed is the reviewer's call.
    const outside: Finding[] = unplanned.map((file) => ({
      severity: 'minor',
      file,
      issue: OUTSIDE_THE_PLAN,
    }))
    const merged: ReviewVerdict = {
      verdict: blocked ? 'changes' : read.verdict,
      summary: read.summary,
      findings: [...guards, ...outside, ...read.findings],
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
    this.earlier = merged.verdict === 'changes' ? { sha, findings: merged.findings } : undefined
    return merged
  }

  private deliver(sha: string, pullRequestUrl: string, attempts: number): Promise<Handed> {
    const { deps, taskId, row, issue, api } = this.c
    return deliverPreRelease(
      { db: deps.db, api },
      {
        taskId,
        repository: row.repository,
        token: this.c.token,
        issueNumber: row.issueNumber,
        title: issue.title,
        sha,
        pullRequestUrl,
        attempts,
        costUsd: this.cost,
        agentSummary: this.summary,
      },
    )
  }

  /**
   * The work was approved: the run ends by moving the task to `merge`, with all the pull request and the
   * delivery need, and the `merge-task` job opens the pull request and integrates it (`factory/merge-task.ts`).
   * A change the factory never integrates on its own goes to a person instead, and a pull request a person
   * closed is settled here, while the run still has its branch.
   */
  private async approved(
    sha: string,
    attempt: number,
    here: StoredCheck[],
    outcome: ReviewVerdict,
  ): Promise<RunResult> {
    const { deps, taskId, row, branch, state } = this.c
    const held = heldFor(
      heldForEvaluation(row.repository, this.touched, deps.ownRepository),
      heldForReview(row.repository, this.touched, deps.ownRepository),
    )
    if (held) return this.handOver(sha, attempt, here, outcome, [], held)
    const empty = await this.reopenedOrEmpty(sha)
    if (empty) return empty
    state.current = 'merge'
    await enterMerge(taskId, {
      branch,
      sha,
      attempts: attempt,
      costUsd: this.cost,
      agentSummary: this.summary,
      reviewer: this.reviewer.name,
      title: this.title,
      issueTitle: this.c.issue.title,
      pullRequestBody: pullRequestBody({
        issueNumber: row.issueNumber,
        sha,
        rows: here,
        agentSummary: this.summary,
        review: { reviewer: this.reviewer.name, attempt, outcome },
        plan: this.renderedPlan,
        repository: row.repository,
      }),
    })
    return { status: 'merging', branch, sha, summary: this.summary }
  }

  /**
   * No approval and no attempts left (or no verdict to act on): a person takes it from here, with a
   * draft pull request, a comment on the issue and a pre-release of what the factory did get done.
   */
  /**
   * The last rework broke a check and no attempt is left, but an earlier commit of this run passed the checks and
   * was reviewed. Its tree comes back as a new commit (history is never rewritten), the checks run on it, and the
   * work goes to a person with that review, instead of failing with nothing to show. When the checks fail there
   * too, the run fails as it did before.
   */
  private async restoreReviewed(
    kept: Reviewed,
    reasons: string[],
    attempt: number,
  ): Promise<RunResult> {
    const short = kept.sha.slice(0, 7)
    const broke = `${NO_PULL_REQUEST}${reasons.join('; ')} (after ${attempt} attempts)`
    await must(
      this.backend,
      `git -C ${this.repoDir} restore --source=${kept.sha} --staged --worktree :/`,
    )
    if (await this.hasNothingToCommit()) throw new StageFailure(broke)
    const sha = await this.commitAndPush(
      `Restore ${short}, the last commit that passed the checks`,
      { attempt: attempt + 1, restoredFrom: kept.sha },
    )
    const checked = await this.verify(sha, attempt + 1, { publish: true })
    if (!checked.verdict.open) {
      throw new StageFailure(
        `${NO_PULL_REQUEST}${checked.verdict.reasons.join('; ')} (after ${attempt + 1} attempts, the last on ${short} restored)`,
      )
    }
    return this.handOver(sha, kept.attempt, checked.here, kept.outcome, kept.counts, {
      headline: 'The last rework broke the checks',
      reason: `the last rework broke the checks (${reasons.join('; ')}), so the branch is back at ${short}, which passed them and was reviewed`,
      cause: 'review_plateau',
    })
  }

  /** The builder changed nothing in answer to a review and said why: a person reads both sides. */
  private disputed(
    sha: string,
    attempt: number,
    here: StoredCheck[],
    outcome: ReviewVerdict,
    counts: number[],
  ): Promise<RunResult> {
    const said = oneLine(withoutLearned(this.summary)).slice(0, 700)
    return this.handOver(sha, attempt, here, outcome, counts, {
      headline: 'The builder and the reviewer disagree',
      reason: `the builder changed nothing in answer to the review, and said: ${said}`,
      cause: 'review_plateau',
    })
  }

  private async handOver(
    sha: string,
    attempt: number,
    here: StoredCheck[],
    outcome: ReviewVerdict,
    counts: number[] = [],
    held?: Held,
  ): Promise<RunResult> {
    const { deps, taskId, row, api, branch, state } = this.c
    const reason =
      held?.reason ??
      (outcome.verdict === 'invalid'
        ? `the review gave no usable verdict: ${outcome.summary}`
        : `the reviewer still asked for changes after ${attempt} attempt${attempt === 1 ? '' : 's'}${roundsNote(attempt, counts)}`)
    const empty = await this.reopenedOrEmpty(sha)
    if (empty) return empty
    state.current = 'pr'
    const pull = await api.openPullRequest(row.repository, this.c.token, {
      head: branch,
      base: integrationBranch(this.c.repo),
      title: `${NEEDS_A_PERSON}${this.title}`,
      draft: true,
      body: pullRequestBody({
        issueNumber: row.issueNumber,
        sha,
        rows: here,
        agentSummary: this.summary,
        review: { reviewer: this.reviewer.name, attempt, outcome },
        handoff: reason,
        plan: this.renderedPlan,
        repository: row.repository,
      }),
    })
    await api.commentOnIssue(
      row.repository,
      this.c.token,
      row.issueNumber,
      [
        held
          ? `${held.headline}: ${reason}.`
          : `The factory could not get this approved: ${reason}.`,
        '',
        `Its work is in the draft pull request ${pull.url}, with the checks that passed and what the reviewer still found.`,
        '',
        outcome.findings.length > 0 ? renderFindings(outcome.findings) : outcome.summary,
      ].join('\n'),
    )
    const handed = await this.deliver(sha, pull.url, attempt)
    await enterRunStage(
      deps.db,
      taskId,
      'handoff',
      {
        branch,
        sha,
        reason,
        cause:
          held?.cause ??
          ((outcome.verdict === 'invalid'
            ? 'review_unusable'
            : 'review_plateau') satisfies HandoffCause),
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
   * The blocking findings of the review rounds before the one a resumed run starts at, read from what
   * the earlier part of the run stored. The review of the claim that the issue is resolved is not one.
   */
  private async priorCounts(): Promise<number[]> {
    const { deps, taskId, resuming } = this.c
    if (!resuming) return []
    // A run that ended (delivered, handed off, failed, cancelled) is not this one: only what came after
    // the last such stage belongs to the run that parked, whose rounds a continuation numbers again.
    const [ended] = await deps.db
      .select()
      .from(stageEvent)
      .where(and(eq(stageEvent.taskId, taskId), inArray(stageEvent.stage, ENDING_STAGES)))
      .orderBy(desc(stageEvent.id))
      .limit(1)
    const rows = await deps.db
      .select()
      .from(reviewTable)
      .where(eq(reviewTable.taskId, taskId))
      .orderBy(asc(reviewTable.id))
    const byRound = new Map<number, number>()
    for (const r of rows) {
      if (ended && r.at <= ended.at) continue
      if (r.sha === this.baseSha) continue
      byRound.set(r.round, blockingCount(r.findings as Finding[]))
      // The run that parked asked for changes last: its continuation reviews against those findings.
      this.earlier =
        r.verdict === 'changes' ? { sha: r.sha, findings: r.findings as Finding[] } : undefined
    }
    const counts: number[] = []
    for (let round = 1; round < resuming.attempt; round++) {
      const count = byRound.get(round)
      if (count !== undefined) counts.push(count)
    }
    return counts
  }

  /**
   * Checks the commit and has it reviewed, up to three attempts, or six while the blocking findings fall. Failing checks and a review that
   * asks for changes send the work back to the same agent session; an approval moves the task to `merge`,
   * and running out of attempts after green checks hands the work to a person.
   */
  async loop(pushed: string): Promise<RunResult> {
    let sha = pushed
    const counts = await this.priorCounts()
    // The last commit of this run that passed the checks and was reviewed: a later rework may break it (#216).
    let reviewed: Reviewed | undefined
    // The checks that failed on the commit before, while they keep failing.
    let failedBefore: CheckResult[] | undefined
    for (let attempt = this.c.resuming?.attempt ?? 1; ; attempt++) {
      const canRework =
        attempt < MAX_ATTEMPTS && this.builder.resume !== undefined && !!this.sessionId
      const fixed = await this.applyFixes(sha, { attempt })
      sha = fixed.sha
      const checked = await this.verify(sha, attempt, { publish: true, fixed })

      if (!checked.verdict.open) {
        const failed = failingChecks(checked.results)
        // The same checks failed on the commit before, so the rework did not fix them: they may be the base's (#219).
        if (sameChecks(failedBefore, failed)) await this.refuseRedBase(failed)
        failedBefore = failed
        if (!canRework) {
          if (reviewed) return this.restoreReviewed(reviewed, checked.verdict.reasons, attempt)
          const after = attempt > 1 ? ` (after ${attempt} attempts)` : ''
          throw new StageFailure(`${NO_PULL_REQUEST}${checked.verdict.reasons.join('; ')}${after}`)
        }
        // A builder that changed nothing said the failure is not its change's: a timeout, often, and then the
        // checks run again on the same commit, within the same attempts. When the failing checks fail on the
        // integration branch too, the failure is the base's, and no rework fixes it (#219).
        const reworked = await this.rework(attempt + 1, [], failed)
        if (reworked === undefined) await this.refuseRedBase(failed)
        sha = reworked ?? sha
        continue
      }

      failedBefore = undefined
      const outcome = await this.review(sha, attempt)
      if (outcome.verdict === 'approve') return this.approved(sha, attempt, checked.here, outcome)
      counts.push(blockingCount(outcome.findings))
      reviewed = { sha, attempt, here: checked.here, outcome, counts: [...counts] }
      const mayRework =
        this.builder.resume !== undefined && !!this.sessionId && reviewAllowsRework(attempt, counts)
      if (outcome.verdict === 'changes' && mayRework) {
        const reworked = await this.rework(attempt + 1, outcome.findings, [], sha)
        // Reviewing the same commit again would get the same verdict: the disagreement goes to a person.
        if (reworked === undefined)
          return this.disputed(sha, attempt, checked.here, outcome, counts)
        sha = reworked
        continue
      }
      return this.handOver(sha, attempt, checked.here, outcome, counts)
    }
  }
}

/** What a stage records about the agent working in it, so the panel can say who it is and on which model. */
function agentFacts(agent: CodingHarness): { harness: string; model?: string; effort?: string } {
  return {
    harness: agent.name,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.effort ? { effort: agent.effort } : {}),
  }
}

/** The reviewer as a review stage records it: the name under `reviewer`, as it always was, with model and effort. */
function reviewerFacts(agent: CodingHarness): {
  reviewer: string
  model?: string
  effort?: string
} {
  const { harness, ...rest } = agentFacts(agent)
  return { reviewer: harness, ...rest }
}
