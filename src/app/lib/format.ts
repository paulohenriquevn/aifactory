import type { Stage, TimelineEvent } from '../../shared/panel'

export const money = (usd: number) => (usd < 0.005 ? '$0.00' : `$${usd.toFixed(2)}`)

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '')

export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

/** How long until the factory runs a failed task again on its own. */
export function runsAgain(iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000)
  if (seconds <= 0) return 'runs again on the next pass'
  if (seconds < 60) return 'runs again in under a minute'
  if (seconds < 3600) return `runs again in ${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `runs again in ${Math.floor(seconds / 3600)}h`
  return `runs again in ${Math.floor(seconds / 86_400)}d`
}

const LABELS: Record<Stage, string> = {
  intake: 'queued',
  sandbox: 'starting sandbox',
  build: 'building',
  push: 'pushing',
  verify: 'running checks',
  review: 'in review',
  waiting: 'waiting for you',
  pr: 'opening pull request',
  done: 'pull request open',
  released: 'released',
  handoff: 'handed to a person',
  failed: 'failed',
}

/**
 * What a stage is called. A finished task whose pull request the factory already merged is "integrated", not
 * "pull request open", and a failure the factory will repeat says so instead of "failed".
 */
export function stageLabel(
  stage: Stage,
  extra: { integrated?: boolean; retryable?: 'quota' | 'environment' | null } = {},
): string {
  if (stage === 'done' && extra.integrated) return 'integrated'
  if (stage === 'failed' && extra.retryable === 'quota') return 'waiting for the limit'
  if (stage === 'failed' && extra.retryable === 'environment') return 'will retry'
  return LABELS[stage]
}

/** One line about what happened at a stage, from what the factory recorded. */
export function describeEvent(event: TimelineEvent): string {
  const d = (event.detail ?? {}) as Record<string, unknown>
  const text = (value: unknown) => (value === undefined || value === null ? '' : String(value))
  switch (event.stage) {
    case 'intake':
      return d.decision
        ? `a person ${text(d.decision).replace('_', ' ')}${d.note ? `: ${text(d.note)}` : ''}`
        : ''
    case 'sandbox':
      return text(d.provider)
    case 'build':
      return [
        text(d.harness),
        d.attempt ? `attempt ${text(d.attempt)}` : '',
        d.resumed ? 'resumed after an answer' : '',
        d.rework ? 'rework' : '',
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
      return [
        text(d.pullRequestUrl),
        d.preRelease ? `pre-release ${text(d.preRelease)}` : '',
        d.preReleaseError ? `no pre-release: ${text(d.preReleaseError)}` : '',
        d.unchanged ? 'nothing to change' : '',
      ]
        .filter(Boolean)
        .join('\n')
    case 'released':
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
