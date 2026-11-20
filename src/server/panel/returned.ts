import { isMergeConflict } from '../factory/auto-retry'
import {
  BASE_PASSES_AGAIN,
  CHECKS_FEEDBACK_OPENING,
  CHECKS_STILL_FAIL,
  CONFLICTS_WITH_BASE,
  isFixedBaseNote,
} from '../factory/ci-wait'
import { CONFLICT_NOTE_OPENING } from '../factory/merge-base'
import type { ReturnReason, Returned } from '../../shared/panel'

/** How much of the note a card carries: enough to say why, never a whole log. */
export const RETURNED_NOTE_MAX = 600

/** The event that took a task out of `done`, as `stage_event` keeps it. */
export type LeavingEvent = { stage: string; detail: unknown; at: Date | string }

/** The stages that keep a task delivered: leaving `done` for one of them is not going back. */
const STILL_DELIVERED = new Set(['done', 'released'])

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The handoff causes `ci-wait.ts` writes after the automatic runs, by the mark they become. */
const HANDOFF_CAUSES: Record<string, ReturnReason> = {
  pull_conflict: 'base_conflict',
  ci_red: 'ci_red',
  base_fixed: 'base_fixed',
}

/** What the run was told, or the handoff's reason; the factory writes one or the other. */
function said(event: LeavingEvent): string {
  const detail = record(event.detail)
  return text(event.stage === 'handoff' ? detail.reason : detail.note)
}

function reasonOf(event: LeavingEvent, doneDetail: unknown): ReturnReason {
  const detail = record(event.detail)
  const cause = HANDOFF_CAUSES[text(detail.cause)]
  if (cause) return cause
  const note = said(event)
  if (note.startsWith(CONFLICT_NOTE_OPENING) || note.startsWith(CONFLICTS_WITH_BASE)) {
    return 'base_conflict'
  }
  // A merge GitHub refused for a conflict starts the run over with no note: the `done` before it says why.
  if (note === '' && isMergeConflict(record(doneDetail).integrationError)) return 'base_conflict'
  if (isFixedBaseNote(note) || note.startsWith(BASE_PASSES_AGAIN)) return 'base_fixed'
  if (note.startsWith(CHECKS_FEEDBACK_OPENING) || note.startsWith(CHECKS_STILL_FAIL))
    return 'ci_red'
  if (detail.decision === 'request_changes' && detail.automatic !== true) return 'review'
  return 'other'
}

const cut = (note: string): string =>
  note.length > RETURNED_NOTE_MAX ? `${note.slice(0, RETURNED_NOTE_MAX)}…` : note

/**
 * Why a task went back from `done`, from the first event after its last `done` and that `done`'s detail. Null
 * when nothing followed the `done`, or when what followed keeps the task delivered (its release).
 */
export function returnedOf(event: LeavingEvent | undefined, doneDetail: unknown): Returned | null {
  if (!event || STILL_DELIVERED.has(event.stage)) return null
  const note = said(event)
  return {
    reason: reasonOf(event, doneDetail),
    at: new Date(event.at).toISOString(),
    note: note === '' ? null : cut(note),
  }
}
