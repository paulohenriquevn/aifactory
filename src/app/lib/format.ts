import type {
  AgentSeen,
  AgentStep,
  MetricRow,
  QueueView,
  Retryable,
  Stage,
  TimelineEvent,
} from '../../shared/panel'

import { en, type Copy } from './copy/en'

export const money = (usd: number) => (usd < 0.005 ? '$0.00' : `$${usd.toFixed(2)}`)

/** An indicator's value in its unit: a share as a percentage, a cost in dollars, a duration in its unit. */
export function metricValue(value: number, unit: MetricRow['unit']): string {
  if (unit === 'share') return `${(value * 100).toFixed(0)}%`
  if (unit === 'usd') return money(value)
  if (unit === 'count') return value.toFixed(1)
  return `${value.toFixed(0)} ${unit === 'minutes' ? 'min' : 'h'}`
}

/** The product names of the agents the factory ships with; any other agent shows by the name it has. */
const AGENT_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

export const agentName = (agent: string) => AGENT_NAMES[agent] ?? agent

const who = ({ agent, model }: AgentSeen) => [agentName(agent), model]

/** The attempt of a build, or the round of a review, said only past the first. */
function stepCount(step: Extract<AgentStep, { agent: string }>, board: Copy['board']) {
  if (step.attempt <= 1) return null
  return step.step === 'reviewing'
    ? board.reviewRound(step.attempt)
    : board.stepAttempt(step.attempt)
}

/** The badge tones a priority can take, from the theme's badge variants. */
export type PriorityTone = 'destructive' | 'warning' | 'primary' | 'default'

/**
 * The tone of a `priority:N` badge: 1 is the most urgent and red, 2 amber, 3 violet, and from 4 on it is
 * plain, so only what the owner marked urgent stands out. A number under 1 counts as the most urgent.
 */
export function priorityTone(priority: number): PriorityTone {
  if (priority <= 1) return 'destructive'
  if (priority === 2) return 'warning'
  if (priority === 3) return 'primary'
  return 'default'
}

/** How many places at the head of the queue the board ranks. */
export const TOP_OF_QUEUE = 10

/**
 * The queued tasks in the order the worker serves them (`queue.position`), and after them the ones with no
 * place in the line (held, or not looked at yet) in the order they came. The list given is not changed.
 */
export function inQueueOrder<T extends { queue: QueueView | null }>(tasks: T[]): T[] {
  const place = (task: T) => task.queue?.position ?? Number.MAX_SAFE_INTEGER
  return [...tasks].sort((a, b) => place(a) - place(b))
}

/** The rank of a queued task among the first `TOP_OF_QUEUE` places of the line, or nothing past them. */
export function topRank(queue: QueueView | null): number | null {
  const position = queue?.position ?? null
  return position !== null && position <= TOP_OF_QUEUE ? position : null
}

/** What an agent does on a running task, with its attempt or round past the first, without naming the agent. */
export function stepLine(
  step: Extract<AgentStep, { agent: string }>,
  board: Copy['board'],
): string {
  return [board.steps[step.step], stepCount(step, board)].filter((part) => part).join(' · ')
}

/** One line for what works on a running task: the agent, its model and its step, or the checks. */
export function workingLine(step: AgentStep, board: Copy['board']): string {
  const parts =
    step.step === 'checks'
      ? [board.steps.checks, step.checks.join(', ')]
      : [...who(step), stepLine(step, board)]
  return parts.filter((part) => part).join(' · ')
}

/** Who worked on a task last, and with which model when it was recorded. */
export const lastAgentLine = (seen: AgentSeen, board: Copy['board']) =>
  board.lastAgent(
    who(seen)
      .filter((part) => part)
      .join(' · '),
  )

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '')

export function ago(iso: string, now = Date.now(), t: Copy['time'] = en.time): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return t.secondsAgo(seconds)
  if (seconds < 3600) return t.minutesAgo(Math.floor(seconds / 60))
  if (seconds < 86_400) return t.hoursAgo(Math.floor(seconds / 3600))
  return t.daysAgo(Math.floor(seconds / 86_400))
}

/** A length of time in whole minutes, in the largest two units that say it: `45m`, `3h 10m`, `1d 4h`. */
export function duration(measured: number): string {
  // Times are measured to the millisecond; the board counts whole minutes.
  const minutes = Math.floor(measured)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
  return `${rest}m`
}

/** How long until the factory runs a failed task again on its own. */
export function runsAgain(iso: string, now = Date.now(), t: Copy['time'] = en.time): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000)
  if (seconds <= 0) return t.runsNextPass
  if (seconds < 60) return t.runsUnderMinute
  if (seconds < 3600) return t.runsInMinutes(Math.floor(seconds / 60))
  if (seconds < 86_400) return t.runsInHours(Math.floor(seconds / 3600))
  return t.runsInDays(Math.floor(seconds / 86_400))
}

/**
 * What a stage is called. A finished task whose pull request the factory already merged is "integrated", one
 * whose pull request GitHub merges once the repository's required checks pass is "waiting for CI", neither
 * "pull request open", and a failure the factory will repeat says so instead of "failed".
 */
export function stageLabel(
  stage: Stage,
  extra: {
    integrated?: boolean
    resolved?: boolean
    /** The pull request waits for the repository's required checks, and GitHub merges it after them. */
    waitingForChecks?: boolean
    /** Approved and delivered, with nothing merged yet and no check GitHub merges it after. */
    awaitingMerge?: boolean
    retryable?: Retryable
  } = {},
  t: Copy['stages'] = en.stages,
): string {
  if (stage === 'done' && extra.resolved) return t.alreadyResolved
  if (stage === 'done' && extra.integrated) return t.integrated
  if (stage === 'done' && extra.waitingForChecks) return t.waitingForChecks
  if (stage === 'done' && extra.awaitingMerge) return t.awaitingMerge
  if (stage === 'failed' && extra.retryable === 'quota') return t.waitingForLimit
  if (stage === 'failed' && extra.retryable === 'environment') return t.willRetry
  if (stage === 'failed' && extra.retryable === 'blocked') return t.waitingForIssue
  if (stage === 'failed' && extra.retryable === 'base') return t.waitingForBase
  return t[stage]
}

const text = (value: unknown) => (value === undefined || value === null ? '' : String(value))

/** What a task's work came to when it finished: its pull request, its delivery, its integration. */
function describeDone(d: Record<string, unknown>): string {
  if (d.resolved) return `already resolved at ${text(d.sha).slice(0, 7)}, issue closed`
  return [
    text(d.pullRequestUrl),
    d.preRelease ? `pre-release ${text(d.preRelease)}` : '',
    d.preReleaseError ? `no pre-release: ${text(d.preReleaseError)}` : '',
    d.unchanged ? 'nothing to change' : '',
    Array.isArray(d.awaitingChecks)
      ? `waiting for the repository checks: ${d.awaitingChecks.join(', ')}`
      : '',
    d.integratedBy ? `merged by ${text(d.integratedBy)} at ${text(d.mergedSha).slice(0, 7)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

type Detail = Record<string, unknown>

/** The parts of a line that have something to say, joined with commas. */
const parts = (...values: string[]) => values.filter(Boolean).join(', ')

function describeIntake(d: Detail): string {
  if (!d.decision) return ''
  const who = d.automatic ? 'the factory' : 'a person'
  return `${who} ${text(d.decision).replace('_', ' ')}${d.note ? `: ${text(d.note)}` : ''}`
}

function describeSandbox(d: Detail): string {
  return d.renewed
    ? `${text(d.provider)}, new session: the last one had run ${text(d.sessionMinutes)} minutes, the disk moved over`
    : text(d.provider)
}

function describeBuild(d: Detail): string {
  return parts(
    text(d.harness),
    d.attempt ? `attempt ${text(d.attempt)}` : '',
    d.resumed ? 'resumed after an answer' : '',
    d.rework ? 'rework' : '',
    d.planned ? 'following its plan' : '',
  )
}

function describeReleased(d: Detail): string {
  if (d.resolvedSha) {
    return `already resolved at ${shortSha(d.resolvedSha as string)}, now on ${text(d.releaseBranch)}`
  }
  if (d.publishing === 'changesets') {
    return `promoted by ${text(d.actor)}; the repository's release workflow publishes it`
  }
  return d.tag
    ? `${text(d.tag)} by ${text(d.actor)}${d.releaseError ? `, but the release could not be created: ${text(d.releaseError)}` : ''}`
    : `merged by ${text(d.actor)}, but the release could not be created: ${text(d.releaseError)}`
}

function describeFailed(d: Detail): string {
  return d.quota
    ? `out of quota${d.resetsAt ? `, resets ${text(d.resetsAt)}` : ''}`
    : `${text(d.failedAt)}: ${text(d.error)}`
}

const DESCRIBE: Partial<Record<TimelineEvent['stage'], (d: Detail) => string>> = {
  intake: describeIntake,
  sandbox: describeSandbox,
  plan: (d) => text(d.harness),
  build: describeBuild,
  push: (d) => text(d.branch),
  verify: (d) => parts(shortSha(d.sha as string), d.attempt ? `attempt ${text(d.attempt)}` : ''),
  review: (d) => parts(text(d.reviewer), shortSha(d.sha as string)),
  waiting: (d) => text(d.question),
  merge: (d) =>
    parts(shortSha(d.sha as string), d.reviewer ? `approved by ${text(d.reviewer)}` : ''),
  done: describeDone,
  released: describeReleased,
  handoff: (d) => text(d.reason),
  failed: describeFailed,
}

/** One line about what happened at a stage, from what the factory recorded. */
export function describeEvent(event: TimelineEvent): string {
  const describe = DESCRIBE[event.stage]
  return describe ? describe((event.detail ?? {}) as Detail) : ''
}
