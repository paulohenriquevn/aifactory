import { Badge } from '@usetheo/ui'

import type { Retryable, Stage } from '../../shared/panel'
import { stageLabel } from '../lib/format'

type Variant = 'default' | 'primary' | 'accent' | 'success' | 'warning' | 'destructive'

const TONE: Record<Stage, Variant> = {
  intake: 'default',
  sandbox: 'primary',
  build: 'primary',
  push: 'primary',
  verify: 'primary',
  review: 'primary',
  pr: 'primary',
  waiting: 'warning',
  done: 'success',
  released: 'accent',
  handoff: 'warning',
  failed: 'destructive',
}

export function StageBadge({
  stage,
  integrated,
  waitingForChecks,
  resolved,
  retryable,
  wrap = false,
}: {
  stage: Stage
  integrated?: boolean
  /** GitHub merges the pull request once the repository's required checks pass. */
  waitingForChecks?: boolean
  /** Delivered without a pull request: the code already did what the issue asks. */
  resolved?: boolean
  retryable?: Retryable
  /** Let the label go to a second line, for a card too narrow to hold it. */
  wrap?: boolean
}) {
  // A failure that will pass by itself is a wait, not an alarm.
  const variant = stage === 'failed' && retryable ? 'warning' : TONE[stage]
  return (
    <Badge
      variant={variant}
      className={wrap ? 'max-w-full whitespace-normal leading-tight' : 'whitespace-nowrap'}
    >
      {stageLabel(stage, { integrated, waitingForChecks, resolved, retryable })}
    </Badge>
  )
}

export function Pass({ ok }: { ok: boolean }) {
  return (
    <span className="text-foreground">
      <span
        aria-hidden
        className={`mr-1.5 inline-block size-2 rounded-full ${ok ? 'bg-success' : 'bg-destructive'}`}
      />
      {ok ? 'passed' : 'failed'}
    </span>
  )
}
