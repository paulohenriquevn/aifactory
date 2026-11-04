import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { finding, question, stageEvent, task, watch } from '../db/schema'

import { WATCH_WINDOW_MS } from './watch'

/** What the supervisor reports. `key` is what makes the same problem one finding, not many. */
export type Found = {
  key: string
  kind: 'stalled' | 'orphaned'
  subject: 'run' | 'queued_run' | 'answer_resume' | 'snapshot' | 'revert'
  taskId: number | null
  ref: string | null
  detail: string
}

/** The stages in which a run is alive and should be producing events. */
const WORKING = ['sandbox', 'build', 'push', 'verify', 'review', 'pr'] as const

export type Limits = {
  /** The longest a working task may go without entering a stage: past the agent's own timeout. */
  stallMs: number
  /** How long a queued task, an answer or a revert may wait for the thing that should pick it up. */
  pickupMs: number
  /** A snapshot younger than this may belong to a question still being written. */
  snapshotGraceMs: number
}

export const LIMITS: Limits = {
  stallMs: 45 * 60_000,
  pickupMs: 10 * 60_000,
  snapshotGraceMs: 5 * 60_000,
}

export type SuperviseDeps = {
  db: Database
  now?: () => Date
  limits?: Limits
  /** The snapshots the sandbox provider holds, when it can say. */
  listSnapshots?: () => Promise<{ id: string; createdAt: Date; sizeBytes: number }[]>
}

const minutes = (ms: number) => Math.round(ms / 60_000)

/** The jobs still in the queue (pending, locked or failed): finished ones are deleted. */
async function queuedJobs(db: Database, name: string, field: string) {
  try {
    const rows = await db.execute<{ id: string; failed: boolean; error: string | null }>(
      sql`select (input->>${field}) as id, (failed_at is not null) as failed, last_error as error
          from theokit_jobs where name = ${name}`,
    )
    return rows.rows
  } catch {
    // The table is made when the worker first starts. Without it there is no queue to be missing from.
    return null
  }
}

export type Detected = {
  found: Found[]
  /** The checks that actually ran. A check that could not run says nothing about its findings. */
  checked: Set<Found['subject']>
}

/** Everything wrong with the factory right now. It reads, and changes nothing. */
export async function detect(deps: SuperviseDeps): Promise<Detected> {
  const { db } = deps
  const now = (deps.now ?? (() => new Date()))()
  const limits = deps.limits ?? LIMITS
  const found: Found[] = []
  const checked = new Set<Found['subject']>(['run', 'revert'])
  const ago = (ms: number) => new Date(now.getTime() - ms)

  // Work that stopped moving.
  const lastEvent = db
    .select({ taskId: stageEvent.taskId, last: sql<Date>`max(${stageEvent.at})`.as('last') })
    .from(stageEvent)
    .groupBy(stageEvent.taskId)
    .as('last_event')
  const quiet = await db
    .select({ id: task.id, stage: task.stage, last: lastEvent.last })
    .from(task)
    .innerJoin(lastEvent, eq(lastEvent.taskId, task.id))
    .where(inArray(task.stage, [...WORKING]))
  for (const t of quiet) {
    const idle = now.getTime() - new Date(t.last).getTime()
    if (idle > limits.stallMs) {
      found.push({
        key: `stalled:run:${t.id}`,
        kind: 'stalled',
        subject: 'run',
        taskId: t.id,
        ref: null,
        detail: `in ${t.stage} and silent for ${minutes(idle)} minutes, longer than any run should take`,
      })
    }
  }

  // A task queued with no job to run it.
  const waiting = await db
    .select({ id: task.id, last: lastEvent.last })
    .from(task)
    .innerJoin(lastEvent, eq(lastEvent.taskId, task.id))
    .where(eq(task.stage, 'intake'))
  const runJobs = await queuedJobs(db, 'run-task', 'taskId')
  if (runJobs) {
    checked.add('queued_run')
    for (const t of waiting) {
      if (now.getTime() - new Date(t.last).getTime() <= limits.pickupMs) continue
      const job = runJobs.find((j) => Number(j.id) === t.id)
      if (!job || job.failed) {
        found.push({
          key: `orphaned:queued_run:${t.id}`,
          kind: 'orphaned',
          subject: 'queued_run',
          taskId: t.id,
          ref: null,
          detail: job
            ? `the job that should run it failed: ${job.error ?? 'no reason given'}`
            : 'it is queued, and no job is left to run it',
        })
      }
    }
  }

  // An answer nobody resumed.
  const answered = await db
    .select({ q: question, stage: task.stage })
    .from(question)
    .innerJoin(task, eq(task.id, question.taskId))
    .where(and(isNull(question.resumedAt), eq(task.stage, 'waiting')))
  const resumeJobs = await queuedJobs(db, 'resume-task', 'questionId')
  if (resumeJobs) {
    checked.add('answer_resume')
    for (const { q } of answered) {
      if (!q.answeredAt || now.getTime() - q.answeredAt.getTime() <= limits.pickupMs) continue
      const job = resumeJobs.find((j) => Number(j.id) === q.id)
      if (!job || job.failed) {
        found.push({
          key: `orphaned:answer_resume:${q.id}`,
          kind: 'orphaned',
          subject: 'answer_resume',
          taskId: q.taskId,
          ref: String(q.id),
          detail: job
            ? `the job that should resume it failed: ${job.error ?? 'no reason given'}`
            : `it was answered ${minutes(now.getTime() - q.answeredAt.getTime())} minutes ago and no job is left to resume it`,
        })
      }
    }
  }

  // A revert that never finished being opened. It can only start inside the watch window.
  const stuck = await db
    .select()
    .from(watch)
    .where(
      and(
        eq(watch.status, 'reverting'),
        sql`${watch.startedAt} < ${ago(WATCH_WINDOW_MS + limits.pickupMs)}`,
      ),
    )
  for (const w of stuck) {
    found.push({
      key: `orphaned:revert:${w.id}`,
      kind: 'orphaned',
      subject: 'revert',
      taskId: w.taskId,
      ref: String(w.id),
      detail:
        'the default branch went red and the revert was never confirmed opened; check the repository',
    })
  }

  // A snapshot no waiting question needs: it only costs storage.
  if (deps.listSnapshots) {
    checked.add('snapshot')
    const needed = await db
      .select({ snapshotId: question.snapshotId })
      .from(question)
      .where(isNull(question.resumedAt))
    const keep = new Set(needed.map((n) => n.snapshotId))
    for (const snap of await deps.listSnapshots()) {
      if (keep.has(snap.id) || now.getTime() - snap.createdAt.getTime() <= limits.snapshotGraceMs)
        continue
      found.push({
        key: `orphaned:snapshot:${snap.id}`,
        kind: 'orphaned',
        subject: 'snapshot',
        taskId: null,
        ref: snap.id,
        detail: `a snapshot of ${Math.round(snap.sizeBytes / 1e6)} MB that no waiting question needs`,
      })
    }
  }
  return { found, checked }
}

export type SuperviseResult = { opened: string[]; resolved: string[]; open: number }

/**
 * Brings the findings in line with what is true now. A problem seen again keeps its first-seen time, a
 * new one is opened, one that is gone is resolved, and one that comes back after being resolved starts
 * over. A check that could not run (no snapshot list, no job table) resolves nothing of its own: not
 * seeing a problem is not the same as the problem being gone.
 */
export async function supervise(deps: SuperviseDeps): Promise<SuperviseResult> {
  const { db } = deps
  const now = (deps.now ?? (() => new Date()))()
  const { found, checked } = await detect(deps)
  const keys = new Set(found.map((f) => f.key))
  const existing = await db.select().from(finding)
  const byKey = new Map(existing.map((f) => [f.key, f]))
  const result: SuperviseResult = { opened: [], resolved: [], open: found.length }

  for (const f of found) {
    const known = byKey.get(f.key)
    if (!known) {
      await db.insert(finding).values({ ...f, firstSeenAt: now, lastSeenAt: now })
      result.opened.push(f.key)
    } else if (known.resolvedAt) {
      await db
        .update(finding)
        .set({ detail: f.detail, firstSeenAt: now, lastSeenAt: now, resolvedAt: null })
        .where(eq(finding.id, known.id))
      result.opened.push(f.key)
    } else {
      await db
        .update(finding)
        .set({ detail: f.detail, lastSeenAt: now })
        .where(eq(finding.id, known.id))
    }
  }
  const gone = existing.filter((f) => !f.resolvedAt && !keys.has(f.key) && checked.has(f.subject))
  if (gone.length > 0) {
    await db
      .update(finding)
      .set({ resolvedAt: now })
      .where(
        and(
          inArray(
            finding.id,
            gone.map((g) => g.id),
          ),
          isNull(finding.resolvedAt),
        ),
      )
    result.resolved.push(...gone.map((g) => g.key))
  }
  return result
}
