import { Badge } from '@usetheo/ui'

import { mergeState, type Retryable, type Returned, type Stage } from '../../shared/panel'
import { useCopy } from '../lib/copy'
import { ago, priorityTone, stageLabel } from '../lib/format'

type Variant = 'default' | 'primary' | 'accent' | 'success' | 'warning' | 'destructive'

const TONE: Record<Stage, Variant> = {
  intake: 'default',
  sandbox: 'primary',
  plan: 'primary',
  build: 'primary',
  push: 'primary',
  verify: 'primary',
  review: 'primary',
  pr: 'primary',
  waiting: 'warning',
  merge: 'primary',
  done: 'success',
  released: 'accent',
  handoff: 'warning',
  failed: 'destructive',
  cancelled: 'default',
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
  const { t } = useCopy()
  // A failure that will pass by itself is a wait, not an alarm.
  const variant = stage === 'failed' && retryable ? 'warning' : TONE[stage]
  // Delivered work that is neither merged nor waiting for CI says so, rather than only that its pull request is open.
  const awaitingMerge =
    !resolved &&
    mergeState({ stage, integrated: !!integrated, waitingForChecks: !!waitingForChecks }) ===
      'awaiting_merge'
  return (
    <Badge
      variant={variant}
      className={wrap ? 'max-w-full whitespace-normal leading-tight' : 'whitespace-nowrap'}
    >
      {stageLabel(
        stage,
        { integrated, waitingForChecks, awaitingMerge, resolved, retryable },
        t.stages,
      )}
    </Badge>
  )
}

export function Pass({ ok }: { ok: boolean }) {
  const { t } = useCopy()
  return (
    <span className="text-foreground">
      <span
        aria-hidden
        className={`mr-1.5 inline-block size-2 rounded-full ${ok ? 'bg-success' : 'bg-destructive'}`}
      />
      {ok ? t.stages.passed : t.stages.checkFailed}
    </span>
  )
}

/** The `priority:N` label of a queued task's issue, as a badge whose colour says how urgent it is. */
export function PriorityBadge({ priority }: { priority: number }) {
  const { t } = useCopy()
  return (
    <Badge
      variant={priorityTone(priority)}
      aria-label={t.board.priority(priority)}
      title={t.board.priority(priority)}
      className="shrink-0 whitespace-nowrap tabular-nums"
    >
      {t.board.priorityBadge(priority)}
    </Badge>
  )
}

/**
 * A task that went back from Delivered and has not reached it again: one small line in a warning colour, why and how
 * long ago, cut to the card's width, with the whole of it and what the run was told as the tooltip.
 */
export function ReturnedBadge({ returned }: { returned: Returned }) {
  const { t } = useCopy()
  const label = t.board.returnedWhen(
    t.board.returned[returned.reason],
    ago(returned.at, Date.now(), t.time),
  )
  return (
    <div
      data-returned={returned.reason}
      title={returned.note ? `${label}\n\n${returned.note}` : label}
      className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium text-foreground"
    >
      <span aria-hidden className="inline-block size-2 shrink-0 rounded-full bg-warning" />
      <span className="truncate">{label}</span>
    </div>
  )
}
