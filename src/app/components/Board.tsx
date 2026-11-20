import { Card as Surface, Table } from '@usetheo/ui'
import type { ReactNode } from 'react'
import { Link } from 'react-router'

import {
  COLUMNS,
  mergeBreakdown,
  type MergeState,
  type AgentSeen,
  type Column as ColumnId,
  type LeadTime,
  type LeadTimeStatus,
  type QueueView,
  type TaskCard,
} from '../../shared/panel'
import { useCopy } from '../lib/copy'
import type { Copy } from '../lib/copy/en'
import {
  agentName,
  ago,
  duration,
  inQueueOrder,
  lastAgentLine,
  money,
  runsAgain,
  stepLine,
  topRank,
  workingLine,
} from '../lib/format'

import { PriorityBadge, ReturnedBadge, StageBadge } from './Badges'

/** The board's address with a task open in the side panel. */
export const openTask = (id: number) => ({ pathname: '/work', search: `?task=${id}` })

/**
 * Where a queued task stands, why, and what the scheduler made of its issue, in the words of the copy. The
 * priority is not in the words: the card shows it as a badge (`PriorityBadge`).
 */
export function queueWords(
  queue: QueueView,
  board: Copy['board'],
): { place: string; verdict: string | null } {
  const place = queue.position === null ? board.queueHeld : board.queuePlace(queue.position)
  const why = queue.reasons
    ? [
        queue.reasons.bug ? board.bug : null,
        queue.reasons.unblocks > 0 ? board.unblocks(queue.reasons.unblocks) : null,
      ].filter((w): w is string => w !== null)
    : []
  const verdict = queue.readiness
    ? queue.readiness.verdict === 'ready'
      ? board.ready
      : board.needsRefinement(queue.readiness.missing)
    : null
  return { place: [place, ...why].join(' · '), verdict }
}

function QueueLines({ queue }: { queue: QueueView }) {
  const { t } = useCopy()
  const { place, verdict } = queueWords(queue, t.board)
  return (
    <>
      <div className="mt-1 flex items-start gap-1.5">
        {queue.reasons?.priority != null ? (
          <PriorityBadge priority={queue.reasons.priority} />
        ) : null}
        <span className="line-clamp-2 text-xs text-muted-foreground" title={place}>
          {place}
        </span>
      </div>
      {verdict ? (
        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground" title={verdict}>
          {verdict}
        </div>
      ) : null}
    </>
  )
}

/**
 * The color of each agent the factory ships with, from the theme's tokens: the harness is the first thing an owner
 * looks for on a card. It marks the panel (a stripe on its side, and its fill while the agent runs) and never the
 * text, since no brand color reads at 4.5 in both modes (see palette.test.ts). Any other agent is neutral.
 */
const AGENT_TONE: Record<string, { stripe: string; lit: string }> = {
  'claude-code': { stripe: 'bg-primary', lit: 'border-primary/40 bg-primary/10' },
  codex: { stripe: 'bg-info', lit: 'border-info/40 bg-info/10' },
}
const NEUTRAL_TONE = { stripe: 'bg-muted-foreground', lit: 'border-border bg-muted/40' }

/**
 * A panel on the card with a stripe of color on its side, which pulses while what it shows is at work. `label` is the
 * whole of it in one line, for a reader that does not see the layout.
 */
function Panel({
  label,
  stripe,
  surface,
  live,
  children,
}: {
  label: string
  stripe: string
  surface: string
  live: boolean
  children: ReactNode
}) {
  return (
    <div
      aria-label={label}
      title={label}
      className={`mt-2 flex gap-2 rounded-md border px-2 py-1.5 text-xs ${surface}`}
    >
      <span
        aria-hidden
        className={`w-1 shrink-0 self-stretch rounded-full ${stripe} ${live ? 'animate-pulse' : ''}`}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** The agent's name, larger than the rest of the card, and its model. */
function AgentName({ seen }: { seen: AgentSeen }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className="shrink-0 text-[13px] font-semibold text-foreground">
        {agentName(seen.agent)}
      </span>
      {seen.model ? (
        <span className="min-w-0 truncate text-muted-foreground">{seen.model}</span>
      ) : null}
    </div>
  )
}

/**
 * Who works on the task: lit in the agent's color while it runs, with what it does; outlined, with its stripe still
 * in color, once it is done, with who worked on it last. The checks have no agent, and a panel of their own.
 */
function AgentPanel({ task }: { task: TaskCard }) {
  const { t } = useCopy()
  const step = task.working
  if (step?.step === 'checks') {
    return (
      <Panel
        label={workingLine(step, t.board)}
        stripe="bg-warning"
        surface="border-warning/40 bg-warning/10"
        live
      >
        <div className="text-[13px] font-semibold text-foreground">{t.board.steps.checks}</div>
        <div className="mt-0.5 line-clamp-2 text-muted-foreground">{step.checks.join(', ')}</div>
      </Panel>
    )
  }
  const seen = step ?? task.lastAgent
  if (!seen) return null
  const tone = AGENT_TONE[seen.agent] ?? NEUTRAL_TONE
  return (
    <Panel
      label={step ? workingLine(step, t.board) : lastAgentLine(seen, t.board)}
      stripe={tone.stripe}
      surface={step ? tone.lit : 'border-border'}
      live={step !== null}
    >
      <AgentName seen={seen} />
      <div className={`mt-0.5 ${step ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
        {step ? stepLine(step, t.board) : t.board.lastWorked}
      </div>
    </Panel>
  )
}

/** The place of a task among the first ten of the queue, as a number on the card; nothing past them. */
function Rank({ queue }: { queue: TaskCard['queue'] }) {
  const { t } = useCopy()
  const rank = topRank(queue)
  if (rank === null) return null
  return (
    <span
      aria-label={t.board.topRank(rank)}
      title={t.board.topRank(rank)}
      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center self-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground"
    >
      {rank}
    </span>
  )
}

/** The border of a card whose clock still runs: amber when it is at risk, red when it is overdue. */
const LEAD_BORDER: Record<LeadTimeStatus, string> = {
  on_track: '',
  at_risk: 'border-warning ring-1 ring-warning/40',
  overdue: 'border-destructive ring-1 ring-destructive/40',
}

const LEAD_TEXT: Record<LeadTimeStatus, string> = {
  on_track: 'text-muted-foreground',
  at_risk: 'font-medium text-foreground',
  overdue: 'font-medium text-destructive',
}

/** Colour that is not text: amber and red read on a dot where amber text would not. */
const LEAD_DOT: Record<LeadTimeStatus, string> = {
  on_track: '',
  at_risk: 'bg-warning',
  overdue: 'bg-destructive',
}

/** The lead time line: how long the task has taken, and whether that is on track, at risk or overdue. */
function LeadTimeLine({ lead }: { lead: LeadTime }) {
  const { t } = useCopy()
  const copy = t.board.leadTime
  const say = lead.running ? copy.running : copy.delivered
  return (
    <div
      data-lead-time={lead.status}
      className={`mt-1 text-xs tabular-nums ${lead.running ? LEAD_TEXT[lead.status] : 'text-muted-foreground'}`}
    >
      {lead.running && lead.status !== 'on_track' ? (
        <span
          aria-hidden
          className={`mr-1.5 inline-block size-2 rounded-full ${LEAD_DOT[lead.status]}`}
        />
      ) : null}
      {say(duration(lead.minutes), copy[lead.status])}
    </div>
  )
}

/**
 * A card grows with what it has to say, from a floor that keeps the columns even, so nothing on it is cut. The title
 * takes up to three lines, the agent its own panel, and the stage closes the card.
 */
export function Card({ task }: { task: TaskCard }) {
  const { t } = useCopy()
  return (
    <Link to={openTask(task.id)} className="group block">
      <Surface
        size="sm"
        data-lead-border={task.leadTime?.running ? task.leadTime.status : undefined}
        className={`flex min-h-[168px] flex-col p-3 transition-colors group-hover:border-primary/60 group-hover:bg-muted/20 ${task.leadTime?.running ? LEAD_BORDER[task.leadTime.status] : ''}`}
      >
        <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
          <Rank queue={task.queue} />
          <span
            className="min-w-0 flex-1 truncate"
            title={`${task.repository} #${task.issueNumber}`}
          >
            {task.repository.split('/').pop()} #{task.issueNumber}
          </span>
          <span className="shrink-0 tabular-nums">
            {task.costUsd >= 0.005 ? `${money(task.costUsd)} · ` : ''}
            {ago(task.updatedAt, Date.now(), t.time)}
          </span>
        </div>
        <div
          title={task.title}
          className="mt-1.5 line-clamp-3 text-sm font-semibold leading-snug text-foreground"
        >
          {task.title}
        </div>
        {task.leadTime ? <LeadTimeLine lead={task.leadTime} /> : null}
        {task.returned ? (
          <div className="mt-1.5">
            <ReturnedBadge returned={task.returned} />
          </div>
        ) : null}
        {task.mainRed ? (
          <div className="mt-1 text-xs font-medium text-destructive">
            {t.board.mainRedAfterRelease}
          </div>
        ) : null}
        {task.waitingOnBase ? (
          <div className="mt-1 text-xs font-medium text-destructive">
            {t.board.waitingOnBase(task.waitingOnBase.checks.join(', '), task.waitingOnBase.branch)}
          </div>
        ) : null}
        {task.queue ? <QueueLines queue={task.queue} /> : null}
        {task.retryAt ? (
          <div className="mt-1 text-xs text-muted-foreground">
            {runsAgain(task.retryAt, Date.now(), t.time)}
          </div>
        ) : null}
        {task.attempts > 1 ? (
          <div className="mt-1 text-xs text-muted-foreground">{t.board.attempt(task.attempts)}</div>
        ) : null}
        <AgentPanel task={task} />
        <div className="mt-auto pt-2">
          <StageBadge
            stage={task.stage}
            integrated={task.integrated}
            waitingForChecks={task.waitingForChecks}
            resolved={task.resolved}
            retryable={task.retryable}
            wrap
          />
        </div>
      </Surface>
    </Link>
  )
}

/**
 * Every column is the same width, full or empty, and they share the room equally, so the board looks the
 * same however many tasks there are. None goes below this: under it the board scrolls instead.
 */
const COLUMN = 'minmax(176px, 1fr)'

/**
 * The queued column in the order the worker serves it, with a line under the first ten so the head of the
 * queue reads at a glance. Every other column keeps the order it was given.
 */
function ordered(id: ColumnId, tasks: TaskCard[]): TaskCard[] {
  return id === 'queued' ? inQueueOrder(tasks) : tasks
}

const MERGE_STATES: MergeState[] = ['merging', 'opening_pr', 'waiting_for_checks', 'awaiting_merge']

/** What the Merge column's cards wait for, counted, in one line under its title; the states with none are left out. */
function MergeCounts({ tasks }: { tasks: TaskCard[] }) {
  const { t } = useCopy()
  const counts = mergeBreakdown(tasks)
  const line = MERGE_STATES.filter((state) => counts[state] > 0)
    .map((state) => t.board.merge[state](counts[state]))
    .join(' · ')
  if (line === '') return null
  return (
    <span className="mt-0.5 block text-[11px] font-normal leading-snug text-muted-foreground">
      {line}
    </span>
  )
}

function Column({ id, title, tasks }: { id: ColumnId; title: string; tasks: TaskCard[] }) {
  const { t } = useCopy()
  const head = tasks.filter((task) => topRank(task.queue) !== null).length
  return (
    <section aria-label={title} className="min-w-0">
      <h2 className="sticky top-0 z-10 mb-2 bg-background pb-1 text-sm font-semibold text-foreground">
        <span className="block truncate">
          {title} <span className="font-normal text-muted-foreground">{tasks.length}</span>
        </span>
        {id === 'merge' ? <MergeCounts tasks={tasks} /> : null}
      </h2>
      <div className="space-y-2">
        {tasks.map((task, i) => (
          <div key={task.id}>
            {i === head && head > 0 ? (
              <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                {t.board.restOfQueue}
                <span className="h-px flex-1 bg-border" />
              </div>
            ) : null}
            <Card task={task} />
          </div>
        ))}
        {tasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t.board.nothingHere}</p>
        ) : null}
      </div>
    </section>
  )
}

/**
 * The board: every column, always, side by side, with cards in them or not. It scrolls inside its own
 * frame when the screen is narrower than the columns need, so the sideways scrollbar stays at the bottom
 * of the screen where it can be found, and the column titles stay at the top.
 */
export function Board({ tasks }: { tasks: TaskCard[] }) {
  const { t } = useCopy()
  return (
    <div className="max-h-[calc(100vh-170px)] overflow-auto pb-2">
      {/* The columns are as tall as the tallest: a title sticks only inside its own column, so a short one would let it go. */}
      <div
        className="grid gap-2.5"
        style={{ gridTemplateColumns: `repeat(${COLUMNS.length}, ${COLUMN})` }}
      >
        {COLUMNS.map((column) => (
          <Column
            key={column.id}
            id={column.id}
            title={t.columns[column.id]}
            tasks={ordered(
              column.id,
              tasks.filter((t) => t.column === column.id),
            )}
          />
        ))}
      </div>
    </div>
  )
}

/** The same tasks as a table, for when the columns are too many to scan. */
export function TaskList({ tasks }: { tasks: TaskCard[] }) {
  const { t } = useCopy()
  return (
    <Table aria-label={t.board.tasks}>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{t.board.task}</Table.HeaderCell>
          <Table.HeaderCell>{t.board.repository}</Table.HeaderCell>
          <Table.HeaderCell>{t.board.stage}</Table.HeaderCell>
          <Table.HeaderCell align="right">{t.board.cost}</Table.HeaderCell>
          <Table.HeaderCell align="right">{t.board.updated}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {tasks.map((task) => (
          <Table.Row key={task.id}>
            <Table.Cell>
              <Link to={openTask(task.id)} className="font-medium text-foreground hover:underline">
                {task.title}
              </Link>
              {task.mainRed ? (
                <span className="ml-2 text-xs font-medium text-destructive">{t.board.mainRed}</span>
              ) : null}
            </Table.Cell>
            <Table.Cell>
              {task.repository} #{task.issueNumber}
            </Table.Cell>
            <Table.Cell>
              <StageBadge
                stage={task.stage}
                integrated={task.integrated}
                waitingForChecks={task.waitingForChecks}
                resolved={task.resolved}
                retryable={task.retryable}
              />
            </Table.Cell>
            <Table.Cell align="right" numeric>
              {money(task.costUsd)}
            </Table.Cell>
            <Table.Cell align="right">{ago(task.updatedAt, Date.now(), t.time)}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  )
}
