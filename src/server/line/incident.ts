import { and, eq, ne } from 'drizzle-orm'

import type { Database } from '../db'
import { lineIncident, task } from '../db/schema'

import type { StoppedLine } from '../../shared/panel'

import type { OpenIncident } from './decide'

/**
 * The reads and writes of a stopped line (`line_incident`). What to do with one is decided in `decide.ts`.
 */

export type Incident = OpenIncident & { id: number; repository: string; issueUrl: string }

type Db = Pick<Database, 'select'>

/** The repository's incident that is not over yet, if any. */
export async function openIncident(db: Db, repository: string): Promise<Incident | undefined> {
  const [row] = await db
    .select()
    .from(lineIncident)
    .where(and(eq(lineIncident.repository, repository), ne(lineIncident.status, 'resolved')))
  if (!row || row.status === 'resolved') return undefined
  return { ...row, status: row.status }
}

/** The repositories whose line is stopped now, each with the task of its fix when it has one. */
export async function stoppedLines(db: Db): Promise<Map<string, number | undefined>> {
  const rows = await db
    .select({ repository: lineIncident.repository, fixTaskId: task.id })
    .from(lineIncident)
    .leftJoin(
      task,
      and(
        eq(task.repository, lineIncident.repository),
        eq(task.issueNumber, lineIncident.issueNumber),
      ),
    )
    .where(ne(lineIncident.status, 'resolved'))
  return new Map(rows.map((r) => [r.repository, r.fixTaskId ?? undefined]))
}

const SCOPES = ['hold', 'fix_first'] as const
/**
 * What a stopped line holds back. `hold` (the default) holds every other run, integration and coordinator action
 * of the repository until the line is green again. `fix_first` holds nothing: the incident and its one fix issue
 * stay, the issue's priority label takes the fix ahead of the queue, and the rest of the repository keeps running
 * and integrating, for an owner whose integration branch takes work fast and whose promotion is fixed on its way.
 */
export type LineStopScope = (typeof SCOPES)[number]

export function lineStopScope(env: NodeJS.ProcessEnv = process.env): LineStopScope {
  const scope = env.FACTORY_LINE_STOP_SCOPE || 'hold'
  const known = SCOPES.find((s) => s === scope)
  if (!known) throw new Error(`FACTORY_LINE_STOP_SCOPE must be hold or fix_first, got ${scope}`)
  return known
}

/** The stopped lines that hold the rest of their repository back: none when the scope is `fix_first`. */
export async function holdingLines(db: Db): Promise<Map<string, number | undefined>> {
  return lineStopScope() === 'fix_first' ? new Map() : stoppedLines(db)
}

/**
 * Whether the line of the repository holds the task out: the line is stopped and the task is not its fix.
 * A fix integrates, since the line runs again only once it did.
 */
export async function lineHolds(db: Db, repository: string, taskId: number): Promise<boolean> {
  const lines = await holdingLines(db)
  return lines.has(repository) && lines.get(repository) !== taskId
}

export type NewIncident = {
  repository: string
  cause: 'promotion_red' | 'mass_failure'
  surface: string
  issueNumber: number
  issueUrl: string
  lastSha: string
}

/** Records a stopped line. False when another pass recorded one for the repository first. */
export async function recordIncident(
  db: Pick<Database, 'insert'>,
  incident: NewIncident,
): Promise<boolean> {
  const rows = await db
    .insert(lineIncident)
    .values(incident)
    .onConflictDoNothing()
    .returning({ id: lineIncident.id })
  return rows.length > 0
}

export type IncidentChange = Partial<
  Pick<
    typeof lineIncident.$inferInsert,
    'issueNumber' | 'issueUrl' | 'lastSha' | 'attempts' | 'status' | 'endedAt'
  >
>

export async function updateIncident(
  db: Pick<Database, 'update'>,
  id: number,
  change: IncidentChange,
): Promise<void> {
  await db.update(lineIncident).set(change).where(eq(lineIncident.id, id))
}

/** The stopped lines, as the board shows them. */
export async function listStoppedLines(
  db: Db,
  scope: LineStopScope = lineStopScope(),
): Promise<StoppedLine[]> {
  const rows = await db
    .select()
    .from(lineIncident)
    .where(ne(lineIncident.status, 'resolved'))
    .orderBy(lineIncident.openedAt)
  return rows.flatMap((r) =>
    r.status === 'resolved'
      ? []
      : [
          {
            repository: r.repository,
            cause: r.cause,
            surface: r.surface,
            issueNumber: r.issueNumber,
            issueUrl: r.issueUrl,
            status: r.status,
            attempts: r.attempts,
            since: r.openedAt.toISOString(),
            scope,
          },
        ],
  )
}
