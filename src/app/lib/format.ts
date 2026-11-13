import type { MetricRow, Retryable, Stage, TimelineEvent } from '../../shared/panel'

import { en, type Copy } from './copy/en'

export const money = (usd: number) => (usd < 0.005 ? '$0.00' : `$${usd.toFixed(2)}`)

/** An indicator's value in its unit: a share as a percentage, a cost in dollars, a duration in its unit. */
export function metricValue(value: number, unit: MetricRow['unit']): string {
  if (unit === 'share') return `${(value * 100).toFixed(0)}%`
  if (unit === 'usd') return money(value)
  if (unit === 'count') return value.toFixed(1)
  return `${value.toFixed(0)} ${unit === 'minutes' ? 'min' : 'h'}`
}

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '')

export function ago(iso: string, now = Date.now(), t: Copy['time'] = en.time): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return t.secondsAgo(seconds)
  if (seconds < 3600) return t.minutesAgo(Math.floor(seconds / 60))
  if (seconds < 86_400) return t.hoursAgo(Math.floor(seconds / 3600))
  return t.daysAgo(Math.floor(seconds / 86_400))
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
    retryable?: Retryable
  } = {},
  t: Copy['stages'] = en.stages,
): string {
  if (stage === 'done' && extra.resolved) return t.alreadyResolved
  if (stage === 'done' && extra.integrated) return t.integrated
  if (stage === 'done' && extra.waitingForChecks) return t.waitingForChecks
  if (stage === 'failed' && extra.retryable === 'quota') return t.waitingForLimit
  if (stage === 'failed' && extra.retryable === 'environment') return t.willRetry
  if (stage === 'failed' && extra.retryable === 'blocked') return t.waitingForIssue
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

/** One line about what happened at a stage, from what the factory recorded. */
export function describeEvent(event: TimelineEvent): string {
  const d = (event.detail ?? {}) as Record<string, unknown>
  switch (event.stage) {
    case 'intake':
      return d.decision
        ? `${d.automatic ? 'the factory' : 'a person'} ${text(d.decision).replace('_', ' ')}${d.note ? `: ${text(d.note)}` : ''}`
        : ''
    case 'sandbox':
      return d.renewed
        ? `${text(d.provider)}, new session: the last one had run ${text(d.sessionMinutes)} minutes, the disk moved over`
        : text(d.provider)
    case 'plan':
      return text(d.harness)
    case 'build':
      return [
        text(d.harness),
        d.attempt ? `attempt ${text(d.attempt)}` : '',
        d.resumed ? 'resumed after an answer' : '',
        d.rework ? 'rework' : '',
        d.planned ? 'following its plan' : '',
      ]
        .filter(Boolean)
        .join(', ')
    case 'push':
      return text(d.branch)
    case 'verify':
      return [shortSha(d.sha as string), d.attempt ? `attempt ${text(d.attempt)}` : '']
        .filter(Boolean)
        .join(', ')
    case 'review':
      return [text(d.reviewer), shortSha(d.sha as string)].filter(Boolean).join(', ')
    case 'waiting':
      return text(d.question)
    case 'done':
      return describeDone(d)
    case 'released':
      if (d.resolvedSha) {
        return `already resolved at ${shortSha(d.resolvedSha as string)}, now on ${text(d.releaseBranch)}`
      }
      if (d.publishing === 'changesets') {
        return `promoted by ${text(d.actor)}; the repository's release workflow publishes it`
      }
      return d.tag
        ? `${text(d.tag)} by ${text(d.actor)}${d.releaseError ? `, but the release could not be created: ${text(d.releaseError)}` : ''}`
        : `merged by ${text(d.actor)}, but the release could not be created: ${text(d.releaseError)}`
    case 'handoff':
      return text(d.reason)
    case 'failed':
      return d.quota
        ? `out of quota${d.resetsAt ? `, resets ${text(d.resetsAt)}` : ''}`
        : `${text(d.failedAt)}: ${text(d.error)}`
    default:
      return ''
  }
}
