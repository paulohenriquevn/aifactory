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
  retryable,
}: {
  stage: Stage
  integrated?: boolean
  retryable?: Retryable
}) {
  // A failure that will pass by itself is a wait, not an alarm.
  const variant = stage === 'failed' && retryable ? 'warning' : TONE[stage]
  return (
    <Badge variant={variant} className="whitespace-nowrap">
      {stageLabel(stage, { integrated, retryable })}
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
