import { randomUUID } from 'node:crypto'

import type { SandboxBackend } from '@theokit/agents/sandbox'

import {
  DEFAULT_CHECK_MS,
  DEFAULT_REVIEW_MS,
  NoTimeForAgent,
  agentTimeLeft,
  fitToSession,
} from '../factory/agent-time'
import {
  changePlanPrompt,
  givenPlanPrompt,
  implementPlanPrompt,
  parseChangePlan,
  planAgainPrompt,
  renderChangePlan,
  type ChangePlan,
} from '../factory/change-plan'
import { BaseProbe, sameChecks } from '../factory/base-checks'
import { cloneRepository } from '../factory/clone'
import { uploadChangesetCheck } from '../factory/changeset-check'
import { failingChecks, runChecks, type CheckResult } from '../factory/evidence'
import { FIX_COMMIT_MESSAGE, runFixes } from '../factory/fixes'
import { diffFacts } from '../factory/diff-facts'
import type { CheckRun, RequiredByCheck } from '../factory/required-files'
import {
  buildPrompt,
  type CodingHarness,
  type HarnessInput,
  type HarnessResult,
} from '../factory/harness'
import {
  blockingCount,
  MAX_ATTEMPTS,
  OUTSIDE_THE_PLAN,
  parseVerdict,
  reviewAllowsRework,
  reviewPrompt,
  reworkPrompt,
  type EarlierReview,
  type Finding,
  type ReviewVerdict,
} from '../factory/review'
import { DEFAULT_TIMEOUTS, PLAN_MS } from '../factory/run'
import {
  COMMIT_MESSAGE,
  GITCONFIG,
  INSTANCE,
  gitConfig,
  must,
  oneLine,
} from '../factory/run-support'
import {
  createIsolatedSandbox,
  type IsolatedSandbox,
  type IsolatedSandboxProvider,
  type SandboxSpec,
} from '../factory/sandbox'
import { parseQuestion } from '../factory/waiting'
import { KnowledgeFeed } from '../knowledge/feed'
import type { KnowledgeSource } from '../knowledge/source'

import type { EvalCase } from './cases'
import { caseOutcome, MEASURED_ITS_BASE, type CaseEnd, type CaseResult } from './compare'
import { whenSlotFree } from './sandbox-slot'

export type EvalDeps = {
  sandbox: IsolatedSandboxProvider
  builder: CodingHarness
  reviewer: CodingHarness
  /** The agent that writes the plan when it is not the builder, as `Run.planChange` uses it. */
  planner?: CodingHarness
  author: { name: string; email: string }
  /** The knowledge base every agent reads; left out, the agents work without one. */
  knowledge?: KnowledgeSource
  /** The limits a run of the case's repository has (`resolveTimeouts`); left out, the factory's default. */
  timeouts?: typeof DEFAULT_TIMEOUTS
}

/** A case that ended before a verdict: the agent stopped, asked something, or changed nothing. */
class Stopped extends Error {}

const COMMIT = /^[0-9a-f]{40}$/

const ABANDONED = 'abandoned: the suite ran out of time'

/** Ends an abandoned case where it stands, so it starts nothing more. */
function ensureLive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Stopped(ABANDONED)
}

/**
 * One case run the way the factory runs a task (`factory/run.ts`): the same prompts, agents, plan, checks,
 * facts about the diff and review, and up to `MAX_ATTEMPTS` passes. A step added to `Run` is added here too,
 * or the suite measures a factory that no longer exists. It writes nowhere but the sandbox: GitHub is
 * reachable without a credential, so the clone works and a push cannot, and nothing here pushes, opens a
 * pull request or records a stage.
 */
class CaseRun {
  /** The last review that asked for changes: the next round starts from its findings. */
  private earlier: EarlierReview | undefined
  cost = 0
  /** A review gave a valid verdict at some point of the case. */
  private verdictSeen = false
  attempts = 1
  reviewRounds = 0
  /** The findings that block, in each review round so far. */
  private readonly blockingCounts: number[] = []
  /** The last commit this case made or found, from which the next round counts what the builder committed. */
  private committed: string | undefined
  /** The last commit the fixes ran on or made, so they never run twice on the same commit, as in `Run`. */
  private fixedHead: string | undefined
  private sessionId: string | undefined
  /** What the builder meant to change, written before it changed anything. */
  private plan: ChangePlan | undefined
  /** What the builder said when it last finished, where it gives its reasons. */
  private summary = ''
  /** Every result of the checks in this case, with the commit it ran on. */
  private readonly checkRuns: CheckRun[] = []
  /** Whether the checks the case failed fail on its base too, as `Run` asks it. */
  private readonly baseProbe = new BaseProbe()
  private readonly started = Date.now()

  constructor(
    private readonly deps: EvalDeps,
    private readonly c: EvalCase,
    private readonly sandbox: IsolatedSandbox,
    private readonly repoDir: string,
    private readonly knowledgeDir: string | undefined,
    private readonly signal?: AbortSignal,
  ) {}

  /**
   * Every agent call goes through here. An abandoned case starts none, and a call that answers after the case
   * was abandoned ends it, so nothing after it runs against the stopped sandbox.
   */
  private async agentCall(start: () => Promise<HarnessResult>): Promise<HarnessResult> {
    ensureLive(this.signal)
    const result = await start()
    ensureLive(this.signal)
    return result
  }

  private get backend(): SandboxBackend {
    return this.sandbox.backend
  }
  private get git() {
    return `GIT_CONFIG_GLOBAL=${GITCONFIG} git -c core.hooksPath=/dev/null -C ${this.repoDir}`
  }
  private get limits() {
    return fitToSession(this.deps.timeouts ?? DEFAULT_TIMEOUTS, this.deps.sandbox.maxSessionMs)
  }

  /** Books what an agent pass cost and turns one that did not finish into the end of the case. */
  private settle(result: HarnessResult, what: string): HarnessResult {
    this.cost += result.costUsd ?? 0
    this.sessionId = result.sessionId ?? this.sessionId
    if (!result.ok) throw new Stopped(`${what}: ${oneLine(result.summary).slice(0, 300)}`)
    return result
  }

  private agentInput(prompt: string, longest = Infinity): HarnessInput {
    return {
      cwd: this.repoDir,
      prompt,
      timeoutMs: Math.min(agentTimeLeft(this.limits, Date.now() - this.started), longest),
    }
  }

  private buildInput(): Parameters<typeof buildPrompt>[0] {
    const { c } = this
    return {
      repo: c.repository,
      issueNumber: c.issueNumber,
      title: c.title,
      body: c.body,
      branch: `factory/${c.issueNumber}`,
      askQuestions: false,
      knowledgeDir: this.knowledgeDir,
      checks: c.checks,
    }
  }

  /**
   * The builder's work, as `Run.build` does it: a builder that can continue a session first writes a plan
   * (`Run.planChange`), what the planning turn changed is thrown away, and the work continues that session.
   */
  async build(): Promise<void> {
    const { builder, planner } = this.deps
    const apart = planner !== undefined && planner.name !== builder.name
    const discarded = apart || builder.resume ? await this.planChange(apart ? planner : builder) : undefined
    const result = await this.agentCall(() => {
      if (apart && this.plan) {
        const prompt = givenPlanPrompt(this.buildInput(), this.plan, planner.name)
        return builder.run(this.backend, this.agentInput(prompt))
      }
      return discarded === undefined
        ? builder.run(this.backend, this.agentInput(buildPrompt(this.buildInput())))
        : builder.resume!(
            this.backend,
            this.sessionId!,
            this.agentInput(implementPlanPrompt({ discarded })),
          )
    })
    this.settle(result, 'the agent did not finish')
    this.summary = result.summary
    if (parseQuestion(result.summary)) throw new Stopped('the agent asked a question')
  }

  /** Writes the plan and answers whether the planning turn left edits, which are thrown away. */
  private async planChange(planner: CodingHarness): Promise<boolean> {
    const input = this.agentInput(changePlanPrompt(this.buildInput()), PLAN_MS)
    const first = this.settle(
      await this.agentCall(() => planner.run(this.backend, input)),
      'the agent did not finish the plan',
    )
    this.plan = parseChangePlan(first.summary) ?? (await this.planAgain(planner, input.timeoutMs))
    const pending = await must(this.backend, `git -C ${this.repoDir} status --porcelain`)
    if (pending.stdout.trim() === '') return false
    await must(this.backend, `git -C ${this.repoDir} reset --hard ${this.c.baseSha}`)
    await must(this.backend, `git -C ${this.repoDir} clean -fd`)
    return true
  }

  /** The planning turn ended with no plan that could be read: one more turn, asking for the plan alone. */
  private async planAgain(planner: CodingHarness, timeoutMs: number): Promise<ChangePlan> {
    if (!planner.resume || !this.sessionId) throw new Stopped('the agent wrote no plan')
    const again = await this.agentCall(() =>
      planner.resume!(this.backend, this.sessionId!, {
        cwd: this.repoDir,
        timeoutMs,
        prompt: planAgainPrompt(),
      }),
    )
    this.cost += again.costUsd ?? 0
    this.sessionId = again.sessionId ?? this.sessionId
    const plan = again.ok ? parseChangePlan(again.summary) : undefined
    if (!plan) throw new Stopped(`the agent wrote no plan: ${oneLine(again.summary).slice(0, 300)}`)
    return plan
  }

  /**
   * The last rework broke the checks and no attempt is left: the reviewed commit's tree comes back as a new
   * commit and the checks run on it, as `Run.restoreReviewed` does (#216). The case ends as it would have there,
   * or on the checks when they fail on it too.
   */
  private async restoreReviewed(
    kept: { sha: string; end: CaseEnd },
    failed: CheckResult[],
  ): Promise<CaseEnd> {
    await must(this.backend, `git -C ${this.repoDir} restore --source=${kept.sha} --staged --worktree :/`)
    if (!(await this.hasChange())) return checksFailed(failed)
    await this.commitAll(`evaluation of ${this.c.id}, ${kept.sha.slice(0, 7)} restored`)
    this.committed = (await must(this.backend, `${this.git} rev-parse HEAD`)).stdout.trim()
    const again = await this.check(this.committed)
    return again.length > 0 ? checksFailed(again) : kept.end
  }

  /** Sends the work back to the builder, as `Run.rework`. Answers whether the builder changed anything. */
  private async rework(
    findings: Finding[],
    failed: CheckResult[],
    reviewedSha?: string,
  ): Promise<boolean> {
    this.attempts++
    const prompt = reworkPrompt({
      findings,
      failedChecks: failed,
      checks: this.c.checks,
      ...(reviewedSha ? { reviewedSha } : {}),
    })
    const result = await this.agentCall(() =>
      this.deps.builder.resume!(this.backend, this.sessionId!, this.agentInput(prompt)),
    )
    this.settle(result, 'the agent did not finish the rework')
    this.summary = result.summary
    return this.hasChange()
  }

  /** Whether the checkout holds something past the last commit of the case: a file left or a commit made. */
  private async hasChange(): Promise<boolean> {
    const changes = await must(this.backend, `git -C ${this.repoDir} status --porcelain`)
    if (changes.stdout.trim() !== '') return true
    const since = this.committed ?? this.c.baseSha
    const ahead = await must(this.backend, `git -C ${this.repoDir} rev-list --count ${since}..HEAD`)
    return Number(ahead.stdout.trim()) > 0
  }

  /**
   * Commits what the builder left, in the sandbox only, and answers the commit. A commit the builder made by
   * itself (a merge does) counts as its change and goes as it is, the same as `Run.commitAndPush`.
   */
  private async commit(): Promise<string> {
    if (!(await this.hasChange())) {
      // As `Run.resolvedAlready`: on the first pass, fixes that change the starting commit make the change.
      const fixed = this.committed === undefined ? await this.applyFixes(this.c.baseSha) : undefined
      if (fixed && fixed !== this.c.baseSha) return fixed
      throw new Stopped('the agent made no change')
    }
    const changes = await must(this.backend, `git -C ${this.repoDir} status --porcelain`)
    if (changes.stdout.trim() !== '')
      await this.commitAll(`evaluation of ${this.c.id}, attempt ${this.attempts}`)
    this.committed = (await must(this.backend, `${this.git} rev-parse HEAD`)).stdout.trim()
    return this.committed
  }

  /** Commits everything in the checkout, in the sandbox only. The message goes in by file. */
  private async commitAll(message: string): Promise<void> {
    await this.backend.uploadFile(GITCONFIG, gitConfig(this.deps.author))
    await this.backend.uploadFile(COMMIT_MESSAGE, `${message}\n`)
    await must(this.backend, `${this.git} add -A`)
    await must(this.backend, `${this.git} commit -F ${COMMIT_MESSAGE}`)
  }

  /** The repository's fix commands, then their change as its own commit in the sandbox, as `Run.applyFixes`. */
  private async applyFixes(sha: string): Promise<string> {
    const fixes = this.c.fixes ?? []
    if (fixes.length === 0 || sha === this.fixedHead) return sha
    const { changed } = await runFixes(
      this.backend,
      this.repoDir,
      fixes,
      this.limits.checkMs ?? DEFAULT_CHECK_MS,
    )
    this.fixedHead = sha
    if (!changed) return sha
    await this.commitAll(FIX_COMMIT_MESSAGE)
    this.committed = (await must(this.backend, `${this.git} rev-parse HEAD`)).stdout.trim()
    this.fixedHead = this.committed
    return this.committed
  }

  /** The end of a case whose failing checks fail on its base too, or nothing when any passes there. */
  private async failingOnBase(failed: CheckResult[]): Promise<CaseEnd | undefined> {
    const red = await this.baseProbe.red(
      this.backend,
      {
        repoDir: this.repoDir,
        baseSha: this.c.baseSha,
        checks: this.c.checks,
        timeoutMs: this.limits.checkMs ?? DEFAULT_CHECK_MS,
      },
      failed,
    )
    if (!red) return undefined
    const names = red.map((name) => `"${name}"`).join(', ')
    return {
      stopped: `${names} failed on the case's base ${this.c.baseSha.slice(0, 7)} too, ${MEASURED_ITS_BASE}`,
    }
  }

  /** Runs the checks on the commit and keeps every result, as the factory keeps its evidence. */
  private async check(sha: string): Promise<CheckResult[]> {
    await must(this.backend, `git -C ${this.repoDir} clean -fdxq`)
    await uploadChangesetCheck(this.backend, this.c.checks)
    const results = await runChecks(
      this.backend,
      this.repoDir,
      this.c.checks,
      this.limits.checkMs ?? DEFAULT_CHECK_MS,
    )
    this.checkRuns.push(...results.map((result) => ({ ...result, sha })))
    return failingChecks(results)
  }

  private async review(
    sha: string,
    unplanned: string[],
    required: RequiredByCheck[],
  ): Promise<ReviewVerdict> {
    this.reviewRounds++
    const { c } = this
    const input: HarnessInput = {
      cwd: this.repoDir,
      timeoutMs: this.limits.reviewMs ?? DEFAULT_REVIEW_MS,
      prompt: reviewPrompt({
        repo: c.repository,
        issueNumber: c.issueNumber,
        title: c.title,
        body: c.body,
        branch: `factory/${c.issueNumber}`,
        baseSha: c.baseSha,
        knowledgeDir: this.knowledgeDir,
        required,
        ...(this.earlier ? { earlier: this.earlier } : {}),
        ...(this.plan
          ? { plan: renderChangePlan(this.plan), unplanned, builderSummary: this.summary }
          : {}),
      }),
    }
    const result = await this.agentCall(() => this.deps.reviewer.run(this.backend, input))
    this.cost += result.costUsd ?? 0
    // The reviewer reads and does not write; whatever it wrote anyway is thrown away.
    await must(this.backend, `${this.git} reset --hard ${sha}`)
    await must(this.backend, `${this.git} clean -fd`)
    return result.ok
      ? parseVerdict(result.summary)
      : { verdict: 'invalid', summary: result.summary, findings: [] }
  }

  private canResume(): boolean {
    return this.deps.builder.resume !== undefined && !!this.sessionId
  }

  /** Failing checks send the builder back up to `MAX_ATTEMPTS`; a review has its own rule. */
  private canRework(): boolean {
    return this.attempts < MAX_ATTEMPTS && this.canResume()
  }

  /** Checks, reviews and reworks until the case is approved or out of attempts, as `Run.loop` does. */
  async loop(): Promise<CaseEnd> {
    let sha = await this.applyFixes(await this.commit())
    // The last reviewed commit whose checks passed, and how the case would end there, as `Run.loop` keeps it.
    let reviewed: { sha: string; end: CaseEnd } | undefined
    // The checks that failed on the commit before, while they keep failing.
    let failedBefore: CheckResult[] | undefined
    for (;;) {
      const failed = await this.check(sha)
      if (failed.length > 0) {
        // The same checks failed on the commit before, as `Run.loop` asks (#219).
        const red = sameChecks(failedBefore, failed) ? await this.failingOnBase(failed) : undefined
        if (red) return red
        failedBefore = failed
        if (!this.canRework()) {
          return reviewed ? this.restoreReviewed(reviewed, failed) : checksFailed(failed)
        }
        // A rework that changed nothing has the checks run again on the same commit (#214), unless they fail on
        // the case's base too, as `Run.refuseRedBase` asks (#219).
        if (await this.rework([], failed)) sha = await this.applyFixes(await this.commit())
        else {
          const red = await this.failingOnBase(failed)
          if (red) return red
        }
        continue
      }
      failedBefore = undefined
      const { guards, unplanned, required } = await diffFacts(this.backend, this.repoDir, {
        baseSha: this.c.baseSha,
        plan: this.plan,
        issue: { labels: this.c.labels, title: this.c.title, body: this.c.body },
        checkRuns: this.checkRuns,
      })
      const blocking = guards.filter((g) => g.severity !== 'minor')
      const read = await this.review(sha, unplanned, required)
      // Any valid verdict counts, even when the case ends later without one.
      if (read.verdict !== 'invalid') this.verdictSeen = true
      // A file outside the plan is on record; whether it was needed is the reviewer's call.
      const outside: Finding[] = unplanned.map((file) => ({
        severity: 'minor',
        file,
        issue: OUTSIDE_THE_PLAN,
      }))
      // The same findings `Run.review` stores, so the rounds are counted as the factory counts them.
      this.blockingCounts.push(blockingCount([...guards, ...outside, ...read.findings]))
      if (read.verdict === 'approve' && blocking.length === 0) {
        return { checksPassed: true, verdict: 'approve', blockingGuards: [] }
      }
      // What the factory hands over: green checks and a review that did not approve.
      const handedOver: CaseEnd = {
        checksPassed: true,
        verdict: read.verdict,
        blockingGuards: blocking.map((g) => g.issue),
      }
      reviewed = { sha, end: handedOver }
      if (
        read.verdict === 'invalid' ||
        !this.canResume() ||
        !reviewAllowsRework(this.attempts, this.blockingCounts)
      ) {
        return handedOver
      }
      const findings = [...guards, ...outside, ...read.findings]
      // The next round starts from these findings, as `Run.review` keeps them.
      this.earlier = { sha, findings }
      // A rework that changed nothing ends the case as the factory hands it over: not reviewed again (#214).
      if (!(await this.rework(findings, [], sha))) return handedOver
      sha = await this.applyFixes(await this.commit())
    }
  }

  result(end: CaseEnd): CaseResult {
    return {
      id: this.c.id,
      ...caseOutcome(end),
      costUsd: this.cost,
      durationMs: Date.now() - this.started,
      attempts: this.attempts,
      reviewRounds: this.reviewRounds,
      reachedVerdict: this.verdictSeen,
    }
  }
}

const names = (checks: CheckResult[]) => [...new Set(checks.map((c) => c.name))]

/** How a case ends when its checks failed on the last commit it had. */
const checksFailed = (failed: CheckResult[]): CaseEnd => ({
  checksPassed: false,
  verdict: 'invalid',
  blockingGuards: [],
  failedChecks: names(failed),
})

/** Names this process's evaluation runs; the sandbox's metadata also carries the process, which says whether it lives. */
const PROCESS_RUN = randomUUID()

/** What the sandbox of a case may reach: GitHub without a credential, the agents, the registry. */
async function specFor(deps: EvalDeps, c: EvalCase): Promise<SandboxSpec> {
  const agents =
    deps.reviewer.name === deps.builder.name ? [deps.builder] : [deps.builder, deps.reviewer]
  const agentEgress = (await Promise.all(agents.map((a) => a.egress()))).flat()
  return {
    owner: { owner: 'eval', caseId: c.id, runId: PROCESS_RUN },
    timeoutMs: fitToSession(deps.timeouts ?? DEFAULT_TIMEOUTS, deps.sandbox.maxSessionMs).sandboxMs,
    cacheKey: c.repository,
    egress: [
      { domain: 'github.com' },
      ...agentEgress,
      { domain: 'registry.npmjs.org' },
      ...c.egress.map((domain) => ({ domain })),
    ],
  }
}

/** Puts the clone on the case's base commit, on the branch the task had. */
async function checkout(backend: SandboxBackend, c: EvalCase): Promise<string> {
  const { repoDir } = await cloneRepository(backend, {
    repoUrl: `https://github.com/${c.repository}.git`,
    ref: c.integrationBranch,
    instanceId: INSTANCE,
  })
  await must(backend, `git -C ${repoDir} fetch origin ${c.baseSha}`)
  await must(backend, `git -C ${repoDir} checkout -B factory/${c.issueNumber} ${c.baseSha}`)
  return repoDir
}

/** Runs one case and answers what it came to; it fails the case, never the suite, on what goes wrong. */
export async function runCase(
  deps: EvalDeps,
  c: EvalCase,
  signal?: AbortSignal,
): Promise<CaseResult> {
  const started = Date.now()
  const stoppedAs = (reason: string): CaseResult => ({
    id: c.id,
    ...caseOutcome({ stopped: reason }),
    costUsd: 0,
    durationMs: Date.now() - started,
    attempts: 0,
    reviewRounds: 0,
    reachedVerdict: false,
  })
  // The hash reaches a shell, so only a full commit hash gets that far.
  if (!COMMIT.test(c.baseSha))
    return stoppedAs(`the base ${JSON.stringify(c.baseSha)} is not a commit hash`)

  // Checked before each step of the setup; inside the run, every agent call checks it too.
  const live = () => ensureLive(signal)
  if (signal?.aborted) return stoppedAs(ABANDONED)

  const held: { sandbox?: IsolatedSandbox } = {}
  let stopped = false
  const stopSandbox = async () => {
    if (stopped || !held.sandbox) return
    stopped = true
    await held.sandbox.stop().catch(() => {})
  }
  // An abandoned case stops its sandbox at once, so work that hangs cannot go on costing, and ends as stopped.
  let onAbort = () => {}
  const abandoned = new Promise<CaseResult>((resolve) => {
    onAbort = () => {
      void stopSandbox()
      resolve(stoppedAs(ABANDONED))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  const work = async (): Promise<CaseResult> => {
    const spec = await specFor(deps, c)
    live()
    // The factory's runs may hold every sandbox the provider allows; the case waits for one to free (#261).
    let sandbox = await whenSlotFree(() => createIsolatedSandbox(deps.sandbox, spec), { signal })
    held.sandbox = sandbox
    // Abandoned while it was being created: the abort handler and `finally` found nothing to stop.
    if (signal?.aborted) await stopSandbox()
    live()
    const repoDir = await checkout(sandbox.backend, c)
    live()
    for (const agent of new Set([deps.builder, deps.reviewer])) {
      await agent.prepare?.(sandbox.backend)
      live()
    }
    const feed = await KnowledgeFeed.open(deps.knowledge, sandbox.backend, c.repository, {})
    sandbox = feed.attachTo(sandbox)
    held.sandbox = sandbox
    live()
    const run = new CaseRun(deps, c, sandbox, repoDir, feed.dir, signal)
    // Before the builder's first pass, so it can run the check it is told to run.
    await uploadChangesetCheck(sandbox.backend, c.checks)
    live()
    try {
      await run.build()
      return run.result(await run.loop())
    } catch (error) {
      if (!(error instanceof Stopped || error instanceof NoTimeForAgent)) throw error
      return run.result({ stopped: error.message })
    }
  }
  try {
    return await Promise.race([work(), abandoned])
  } catch (error) {
    return stoppedAs(error instanceof Error ? error.message : String(error))
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await stopSandbox()
  }
}
