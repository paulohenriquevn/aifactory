import type { SandboxBackend } from '@theokit/agents/sandbox'

import type { EgressRule } from './sandbox'
import type { CheckResult } from './evidence'
import { renderFindings, type ReviewVerdict } from './review'
import type { RunResult } from './run-types'
import { quotaResumesAt } from './quota-reset'

export const INSTANCE = 'work'
export const GITCONFIG = '/tmp/factory.gitconfig'
export const COMMIT_MESSAGE = '/tmp/factory-commit-message.txt'

/** Thrown inside a stage so the run can report which stage failed. */
export class StageFailure extends Error {}

/** The agent asked a person something and the run is parked: not a failure, and not done. */
export class Asked extends Error {
  constructor(readonly result: RunResult) {
    super('waiting for an answer')
  }
}

/** The agent's account is out of quota. It is recorded as such, because waiting fixes it. */
export class QuotaStop extends StageFailure {
  constructor(
    message: string,
    readonly resetsAt?: string,
  ) {
    super(message)
  }
}

/**
 * What a quota stop leaves in the failure: the agent's own words for when it comes back, and the instant
 * they mean, read against the moment it failed. A reader later cannot rebuild the instant: it would have to
 * guess the zone and the day.
 */
export function quotaDetail(stop: QuotaStop, failedAt: Date) {
  const resumes = quotaResumesAt(stop.resetsAt, failedAt)
  return {
    quota: true as const,
    resetsAt: stop.resetsAt,
    ...(resumes ? { resumesAt: resumes.toISOString() } : {}),
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

const PUSH_ATTEMPTS = 6

/**
 * Pushes the same commit up to six times, waiting twice as long after each failure (5, 10, 20, 40 and 80
 * seconds with the default delay). GitHub now and then answers a push with an internal error
 * (`fatal error in commit_refs`, a 500), and during an incident it keeps doing so for minutes: giving up
 * after a few seconds threw away a whole agent run for something that passes by itself. The push is
 * idempotent: it sends one commit to one branch the run created. Only the push is retried.
 */
export async function pushWithRetry(backend: SandboxBackend, command: string, delayMs: number) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await must(backend, command)
    } catch (error) {
      if (attempt >= PUSH_ATTEMPTS) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** (attempt - 1)))
    }
  }
}

export async function must(backend: SandboxBackend, command: string) {
  const result = await backend.execute(command)
  if (result.exitCode !== 0) {
    const output = (result.stderr || result.stdout).trim().slice(-500)
    throw new StageFailure(`\`${command}\` exited ${result.exitCode}: ${output}`)
  }
  return result
}

export type StoredCheck = Pick<CheckResult, 'name' | 'command' | 'passed' | 'durationMs' | 'output'>

export function checkSummary(rows: StoredCheck[]): string {
  return rows
    .map((r) => `- ${r.passed ? 'passed' : 'failed'}: \`${r.command}\` (${seconds(r.durationMs)})`)
    .join('\n')
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

export function pullRequestBody(input: {
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

/**
 * The comment that closes an issue the code already resolved: the commit, the checks that passed there, the
 * reviewer's confirmation and what the agent found, so whoever opened it can check it and reopen it.
 */
export function resolvedComment(input: {
  sha: string
  claim: string
  reviewer: string
  review: string
  rows: StoredCheck[]
}): string {
  return [
    `The factory found this already resolved at ${input.sha}, so it changed nothing and is closing the issue.`,
    '',
    `Checks the factory ran on \`${input.sha.slice(0, 7)}\`:`,
    '',
    checkSummary(input.rows),
    '',
    `Independent review by ${input.reviewer}: ${input.review}`,
    '',
    '<details><summary>What the agent found</summary>',
    '',
    input.claim.slice(0, 3_000),
    '',
    '</details>',
    '',
    'If something the issue asks for is still missing, reopen it and say what.',
    '',
  ].join('\n')
}

export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The commit identity as a git config file. Newlines would start a new setting, so refuse them. */
export function gitConfig(author: { name: string; email: string }): string {
  if (/[\r\n]/.test(author.name + author.email)) {
    throw new StageFailure('the commit author must be a single line')
  }
  return `[user]\n\tname = ${author.name}\n\temail = ${author.email}\n`
}

/** A run that continues on the branch the agent pushed, with what to change. */
export type Continuation = {
  feedback: string
  /** The repository's required checks sent the work back, not a person. */
  fromChecks?: boolean
}

/**
 * How a queued run starts: on the branch the agent pushed, with feedback, when a person asked for changes
 * or the factory sent the work back with its own note (the repository's checks failed); from the beginning
 * otherwise.
 */
export function runContinuation(
  decided: { kind: string; note: string } | undefined,
  feedback: string | undefined,
): Continuation | undefined {
  if (decided?.kind === 'request_changes') return { feedback: decided.note }
  return feedback ? { feedback, fromChecks: true } : undefined
}
