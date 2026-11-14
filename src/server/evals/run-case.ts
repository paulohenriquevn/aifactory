import type { SandboxBackend } from '@theokit/agents/sandbox'

import {
  DEFAULT_CHECK_MS,
  DEFAULT_REVIEW_MS,
  agentTimeLeft,
  fitToSession,
} from '../factory/agent-time'
import {
  changePlanPrompt,
  implementPlanPrompt,
  parseChangePlan,
  planAgainPrompt,
  renderChangePlan,
  type ChangePlan,
} from '../factory/change-plan'
import { cloneRepository } from '../factory/clone'
import { uploadChangesetCheck } from '../factory/changeset-check'
import { failingChecks, runChecks, type CheckResult } from '../factory/evidence'
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
import { caseOutcome, type CaseEnd, type CaseResult } from './compare'

export type EvalDeps = {
  sandbox: IsolatedSandboxProvider
  builder: CodingHarness
  reviewer: CodingHarness
  author: { name: string; email: string }
  /** The knowledge base every agent reads; left out, the agents work without one. */
  knowledge?: KnowledgeSource
}

/** A case that ended before a verdict: the agent stopped, asked something, or changed nothing. */
class Stopped extends Error {}

const COMMIT = /^[0-9a-f]{40}$/

/**
 * One case run the way the factory runs a task (`factory/run.ts`): the same prompts, agents, plan, checks,
 * facts about the diff and review, and up to `MAX_ATTEMPTS` passes. A step added to `Run` is added here too,
 * or the suite measures a factory that no longer exists. It writes nowhere but the sandbox: GitHub is
 * reachable without a credential, so the clone works and a push cannot, and nothing here pushes, opens a
 * pull request or records a stage.
 */
class CaseRun {
  cost = 0
  attempts = 1
  reviewRounds = 0
  /** The findings that block, in each review round so far. */
  private readonly blockingCounts: number[] = []
  private sessionId: string | undefined
  /** What the builder meant to change, written before it changed anything. */
  private plan: ChangePlan | undefined
  /** What the builder said when it last finished, where it gives its reasons. */
  private summary = ''
  /** Every result of the checks in this case, with the commit it ran on. */
  private readonly checkRuns: CheckRun[] = []
  private readonly started = Date.now()

  constructor(
    private readonly deps: EvalDeps,
    private readonly c: EvalCase,
    private readonly sandbox: IsolatedSandbox,
    private readonly repoDir: string,
    private readonly knowledgeDir: string | undefined,
  ) {}

  private get backend(): SandboxBackend {
    return this.sandbox.backend
  }
  private get git() {
    return `GIT_CONFIG_GLOBAL=${GITCONFIG} git -c core.hooksPath=/dev/null -C ${this.repoDir}`
  }
  private get limits() {
    return fitToSession(DEFAULT_TIMEOUTS, this.deps.sandbox.maxSessionMs)
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
    const { builder } = this.deps
    const discarded = builder.resume ? await this.planChange() : undefined
    const result =
      discarded === undefined
        ? await builder.run(this.backend, this.agentInput(buildPrompt(this.buildInput())))
        : await builder.resume!(
            this.backend,
            this.sessionId!,
            this.agentInput(implementPlanPrompt({ discarded })),
          )
    this.settle(result, 'the agent did not finish')
    this.summary = result.summary
    if (parseQuestion(result.summary)) throw new Stopped('the agent asked a question')
  }

  /** Writes the plan and answers whether the planning turn left edits, which are thrown away. */
  private async planChange(): Promise<boolean> {
    const input = this.agentInput(changePlanPrompt(this.buildInput()), PLAN_MS)
    const first = this.settle(
      await this.deps.builder.run(this.backend, input),
      'the agent did not finish the plan',
    )
    this.plan = parseChangePlan(first.summary) ?? (await this.planAgain(input.timeoutMs))
    const pending = await must(this.backend, `git -C ${this.repoDir} status --porcelain`)
    if (pending.stdout.trim() === '') return false
    await must(this.backend, `git -C ${this.repoDir} reset --hard ${this.c.baseSha}`)
    await must(this.backend, `git -C ${this.repoDir} clean -fd`)
    return true
  }

  /** The planning turn ended with no plan that could be read: one more turn, asking for the plan alone. */
  private async planAgain(timeoutMs: number): Promise<ChangePlan> {
    const again = await this.deps.builder.resume!(this.backend, this.sessionId!, {
      cwd: this.repoDir,
      timeoutMs,
      prompt: planAgainPrompt(),
    })
    this.cost += again.costUsd ?? 0
    this.sessionId = again.sessionId ?? this.sessionId
    const plan = again.ok ? parseChangePlan(again.summary) : undefined
    if (!plan) throw new Stopped(`the agent wrote no plan: ${oneLine(again.summary).slice(0, 300)}`)
    return plan
  }

  private async rework(findings: Finding[], failed: CheckResult[]): Promise<void> {
    this.attempts++
    const prompt = reworkPrompt({ findings, failedChecks: failed, checks: this.c.checks })
    const result = await this.deps.builder.resume!(
      this.backend,
      this.sessionId!,
      this.agentInput(prompt),
    )
    this.settle(result, 'the agent did not finish the rework')
    this.summary = result.summary
  }

  /** Commits what the builder left, in the sandbox only, and answers the commit. */
  private async commit(): Promise<string> {
    const changes = await must(this.backend, `git -C ${this.repoDir} status --porcelain`)
    if (changes.stdout.trim() === '') throw new Stopped('the agent made no change')
    await this.backend.uploadFile(GITCONFIG, gitConfig(this.deps.author))
    await this.backend.uploadFile(
      COMMIT_MESSAGE,
      `evaluation of ${this.c.id}, attempt ${this.attempts}\n`,
    )
    await must(this.backend, `${this.git} add -A`)
    await must(this.backend, `${this.git} commit -F ${COMMIT_MESSAGE}`)
    return (await must(this.backend, `${this.git} rev-parse HEAD`)).stdout.trim()
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
    const result = await this.deps.reviewer.run(this.backend, {
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
        ...(this.plan
          ? { plan: renderChangePlan(this.plan), unplanned, builderSummary: this.summary }
          : {}),
      }),
    })
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
    for (;;) {
      const sha = await this.commit()
      const failed = await this.check(sha)
      if (failed.length > 0) {
        if (!this.canRework()) {
          return {
            checksPassed: false,
            verdict: 'invalid',
            blockingGuards: [],
            failedChecks: names(failed),
          }
        }
        await this.rework([], failed)
        continue
      }
      const { guards, unplanned, required } = await diffFacts(this.backend, this.repoDir, {
        baseSha: this.c.baseSha,
        plan: this.plan,
        issue: { labels: this.c.labels, title: this.c.title, body: this.c.body },
        checkRuns: this.checkRuns,
      })
      const blocking = guards.filter((g) => g.severity !== 'minor')
      const read = await this.review(sha, unplanned, required)
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
      if (
        read.verdict === 'invalid' ||
        !this.canResume() ||
        !reviewAllowsRework(this.attempts, this.blockingCounts)
      ) {
        return {
          checksPassed: true,
          verdict: read.verdict,
          blockingGuards: blocking.map((g) => g.issue),
        }
      }
      await this.rework([...guards, ...outside, ...read.findings], [])
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
    }
  }
}

const names = (checks: CheckResult[]) => [...new Set(checks.map((c) => c.name))]

/** What the sandbox of a case may reach: GitHub without a credential, the agents, the registry. */
async function specFor(deps: EvalDeps, c: EvalCase): Promise<SandboxSpec> {
  const agents =
    deps.reviewer.name === deps.builder.name ? [deps.builder] : [deps.builder, deps.reviewer]
  const agentEgress = (await Promise.all(agents.map((a) => a.egress()))).flat()
  return {
    timeoutMs: fitToSession(DEFAULT_TIMEOUTS, deps.sandbox.maxSessionMs).sandboxMs,
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
export async function runCase(deps: EvalDeps, c: EvalCase): Promise<CaseResult> {
  const started = Date.now()
  const stoppedAs = (reason: string): CaseResult => ({
    id: c.id,
    ...caseOutcome({ stopped: reason }),
    costUsd: 0,
    durationMs: Date.now() - started,
    attempts: 0,
    reviewRounds: 0,
  })
  // The hash reaches a shell, so only a full commit hash gets that far.
  if (!COMMIT.test(c.baseSha))
    return stoppedAs(`the base ${JSON.stringify(c.baseSha)} is not a commit hash`)

  let sandbox: IsolatedSandbox | undefined
  try {
    sandbox = await createIsolatedSandbox(deps.sandbox, await specFor(deps, c))
    const repoDir = await checkout(sandbox.backend, c)
    for (const agent of new Set([deps.builder, deps.reviewer]))
      await agent.prepare?.(sandbox.backend)
    const feed = await KnowledgeFeed.open(deps.knowledge, sandbox.backend, c.repository, {})
    sandbox = feed.attachTo(sandbox)
    const run = new CaseRun(deps, c, sandbox, repoDir, feed.dir)
    try {
      await run.build()
      return run.result(await run.loop())
    } catch (error) {
      if (!(error instanceof Stopped)) throw error
      return run.result({ stopped: error.message })
    }
  } catch (error) {
    return stoppedAs(error instanceof Error ? error.message : String(error))
  } finally {
    await sandbox?.stop().catch(() => {})
  }
}
