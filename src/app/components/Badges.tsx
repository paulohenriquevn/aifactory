import type { Stage } from '../../shared/panel'
import { stageLabel } from '../lib/format'

const TONE: Record<Stage, string> = {
  intake: 'bg-slate-100 text-slate-700',
  sandbox: 'bg-blue-100 text-blue-800',
  build: 'bg-blue-100 text-blue-800',
  push: 'bg-blue-100 text-blue-800',
  verify: 'bg-blue-100 text-blue-800',
  review: 'bg-indigo-100 text-indigo-800',
  pr: 'bg-blue-100 text-blue-800',
  waiting: 'bg-amber-100 text-amber-900',
  done: 'bg-emerald-100 text-emerald-800',
  handoff: 'bg-orange-100 text-orange-900',
  failed: 'bg-red-100 text-red-800',
}

export function StageBadge({ stage }: { stage: Stage }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE[stage]}`}>
      {stageLabel(stage)}
    </span>
  )
}

export function Pass({ ok }: { ok: boolean }) {
  return (
    <span className={ok ? 'text-emerald-700' : 'text-red-700'}>{ok ? 'passed' : 'failed'}</span>
  )
}
