import { and, asc, desc, eq, gt, inArray, isNull, like, sql } from 'drizzle-orm'

import type { Database } from '../db'
import {
  agentRun,
  changePlan,
  decision,
  delivery,
  evidence,
  finding,
  question,
  releaseWait,
  review,
  stageEvent,
  task,
  setting,
  watch,
} from '../db/schema'
import { MISSING_KEY } from '../factory/ship'
import { retryAt } from '../factory/auto-retry'
import {
  columnOf,
  retryableFailure,
  type ChangePlanView,
  type DecisionView,
  type Retryable,
  type DeliveryView,
  type ReleaseWaitView,
  type CostGroup,
  type EvidenceView,
  type FindingView,
  type HealthReport,
  type RunView,
  type InboxItem,
  type QuestionView,
  type ReviewView,
  type Stage,
  type TaskCard,
  type TaskDetail,
  type TimelineEvent,
  type WatchView,
} from '../../shared/panel'

type TaskRow = typeof task.$inferSelect

/**
 * The columns of `stage_event` with the table's name in front. Drizzle writes a column of a query over one
 * table as a bare name, and inside a subquery over the same table under an alias a bare `task_id` is the
 * alias's own column: the comparison would be true for every row, and the count would follow the events of
 * every task instead of this one's.
 */
const OUTER = {
  id: sql.raw('"stage_event"."id"'),
  taskId: sql.raw('"stage_event"."task_id"'),
  stage: sql.raw('"stage_event"."stage"'),
  detail: sql.raw('"stage_event"."detail"'),
}

/**
 * Per task, in a query grouped by `stage_event.task_id`: the automatic runs since a person last started it.
 * A person's retry starts the count over. A rework that failed creating its sandbox, before any agent ran,
 * is not counted: nothing of the work was attempted.
 */
export function automaticRunsSincePerson() {
  return sql<number>`count(*) filter (where ${OUTER.stage} = 'intake' and ${OUTER.detail}->>'automatic' = 'true' and ${OUTER.id} > coalesce((select max(i.id) from stage_event i where i.task_id = ${OUTER.taskId} and i.stage = 'intake' and (i.detail->>'automatic') is distinct from 'true'), 0) and not ((${OUTER.detail}->>'decision') is not distinct from 'request_changes' and exists (select 1 from stage_event s where s.task_id = ${OUTER.taskId} and s.stage = 'sandbox' and s.id = (select min(n.id) from stage_event n where n.task_id = ${OUTER.taskId} and n.id > ${OUTER.id}) and (select f.stage from stage_event f where f.task_id = ${OUTER.taskId} and f.id > s.id order by f.id limit 1) = 'failed')))`
}

const iso = (date: Date) => date.toISOString()

/** Whether a failed task runs again on its own and when, from its last failure. */
function nextRun(
  failure: { detail: unknown; at: Date } | undefined,
  automaticRetries: number,
): { retryable: Retryable; at: Date } | null {
  if (!failure) return null
  const detail = (failure.detail ?? {}) as Record<string, unknown>
  const retryable = retryableFailure(detail)
  const at = retryAt({
    retryable,
    failedAt: new Date(failure.at),
    resumesAt: typeof detail.resumesAt === 'string' ? detail.resumesAt : undefined,
    resetsAt: typeof detail.resetsAt === 'string' ? detail.resetsAt : undefined,
    automaticRetries,
  })
  return at ? { retryable, at } : null
}

/**
 * Cards for the given tasks: what the board shows. The attempts, the last activity and whether a
 * person approved the current commit come from three small aggregates instead of one query per task.
 */
async function cards(db: Database, rows: TaskRow[]): Promise<TaskCard[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const activity = await db
    .select({
      taskId: stageEvent.taskId,
      last: sql<Date>`max(${stageEvent.at})`,
      // Only the current run's: a retry starts again at attempt 1 with a new intake, so the checks of
      // the runs before it are not attempts of this one. An automatic retry that kept the work (`kept`) is the
      // same run again, so the checks before it still count.
      verifies: sql<number>`count(*) filter (where ${OUTER.stage} = 'verify' and ${OUTER.id} > coalesce((select max(i.id) from stage_event i where i.task_id = ${OUTER.taskId} and i.stage = 'intake' and (i.detail->>'kept') is distinct from 'true'), 0))`,
      automatic: automaticRunsSincePerson(),
    })
    .from(stageEvent)
    .where(inArray(stageEvent.taskId, ids))
    .groupBy(stageEvent.taskId)
  const approvals = await db
    .select({ taskId: decision.taskId, sha: decision.sha })
    .from(decision)
    .where(inArray(decision.taskId, ids))
    .orderBy(asc(decision.id))
  const delivered = await db
    .select()
    .from(delivery)
    .where(inArray(delivery.taskId, ids))
    .orderBy(asc(delivery.id))
  const watched = await db.select().from(watch).where(inArray(watch.taskId, ids))
  const releases = await db
    .select()
    .from(releaseWait)
    .where(inArray(releaseWait.taskId, ids))
    .orderBy(asc(releaseWait.id))
  const failures = await db
    .selectDistinctOn([stageEvent.taskId], {
      taskId: stageEvent.taskId,
      detail: stageEvent.detail,
      at: stageEvent.at,
    })
    .from(stageEvent)
    .where(and(inArray(stageEvent.taskId, ids), eq(stageEvent.stage, 'failed')))
    .orderBy(stageEvent.taskId, desc(stageEvent.id))
  const lastFailure = new Map(failures.map((f) => [f.taskId, f]))
  const byTask = new Map(activity.map((a) => [a.taskId, a]))
  return rows.map((r) => {
    const seen = byTask.get(r.id)
    const again =
      r.stage === 'failed' ? nextRun(lastFailure.get(r.id), Number(seen?.automatic ?? 0)) : null
    const kinds = approvals.filter((a) => a.taskId === r.id)
    return {
      id: r.id,
      repository: r.repository,
      issueNumber: r.issueNumber,
      title: r.issueTitle,
      stage: r.stage as Stage,
      column: columnOf(r.stage as Stage, again?.retryable ?? null, {
        resolved: r.resolvedSha !== null,
        integrated: r.mergedSha !== null,
      }),
      pullRequestUrl: r.pullRequestUrl,
      headSha: r.headSha,
      costUsd: r.costUsd,
      attempts: Number(seen?.verifies ?? 0),
      createdAt: iso(r.createdAt),
      updatedAt: iso(new Date(seen?.last ?? r.createdAt)),
      approved: r.headSha !== null && kinds.some((k) => k.sha === r.headSha),
      integrated: r.mergedSha !== null,
      waitingForChecks: r.awaitingCiSha !== null,
      resolved: r.resolvedSha !== null,
      retryable: again?.retryable ?? null,
      retryAt: again?.at.toISOString() ?? null,
      preRelease: lastDelivery(delivered, r, 'prerelease'),
      release: lastDelivery(delivered, r, 'release'),
      mainRed: watched.some((w) => w.taskId === r.id && w.status === 'red' && !w.acknowledgedAt),
      releaseWait: lastReleaseWait(releases, r),
    }
  })
}

/** The latest release of a task that waits for checks or was refused, while the task is not released. */
function lastReleaseWait(
  rows: (typeof releaseWait.$inferSelect)[],
  t: TaskRow,
): ReleaseWaitView | null {
  const last = rows.filter((w) => w.taskId === t.id).at(-1)
  if (!last || last.status === 'merged' || t.stage !== 'done') return null
  return {
    status: last.status,
    pullRequestUrl: last.pullRequestUrl,
    checks: last.checks,
    reason: last.detail,
  }
}

type DeliveryRow = typeof delivery.$inferSelect

/**
 * The latest delivery of a kind for a task. Before an integration a pre-release counts for the commit
 * the task is at; after it, the tag is on the pre-release branch, at a commit of its own.
 */
function lastDelivery(rows: DeliveryRow[], t: TaskRow, kind: 'prerelease' | 'release') {
  const mine = rows.filter(
    (d) =>
      d.taskId === t.id &&
      d.kind === kind &&
      (kind === 'release' || t.mergedSha !== null || d.sha === t.headSha),
  )
  const last = mine.at(-1)
  return last ? { tag: last.tag, url: last.url } : null
}

/** Every task, newest activity first. */
export async function listTasks(db: Database): Promise<TaskCard[]> {
  const rows = await db.select().from(task).orderBy(desc(task.id))
  return (await cards(db, rows)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function taskDetail(db: Database, id: number): Promise<TaskDetail | undefined> {
  const [row] = await db.select().from(task).where(eq(task.id, id))
  if (!row) return undefined
  const [card] = await cards(db, [row])
  const [events, checks, reviews, questions, decisions, deliveries, watches, runs, plans] =
    await Promise.all([
      db.select().from(stageEvent).where(eq(stageEvent.taskId, id)).orderBy(asc(stageEvent.id)),
      db.select().from(evidence).where(eq(evidence.taskId, id)).orderBy(asc(evidence.id)),
      db.select().from(review).where(eq(review.taskId, id)).orderBy(asc(review.id)),
      db.select().from(question).where(eq(question.taskId, id)).orderBy(asc(question.id)),
      db.select().from(decision).where(eq(decision.taskId, id)).orderBy(asc(decision.id)),
      db.select().from(delivery).where(eq(delivery.taskId, id)).orderBy(asc(delivery.id)),
      db.select().from(watch).where(eq(watch.taskId, id)).orderBy(asc(watch.id)),
      db.select().from(agentRun).where(eq(agentRun.taskId, id)).orderBy(asc(agentRun.id)),
      db.select().from(changePlan).where(eq(changePlan.taskId, id)).orderBy(asc(changePlan.id)),
    ])
  return {
    task: card,
    timeline: events.map((e): TimelineEvent => ({
      id: e.id,
      stage: e.stage as Stage,
      at: iso(e.at),
      detail: (e.detail ?? null) as Record<string, unknown> | null,
    })),
    evidence: checks.map((e): EvidenceView => ({
      id: e.id,
      name: e.name,
      command: e.command,
      sha: e.sha,
      passed: e.passed,
      exitCode: e.exitCode,
      timedOut: e.timedOut,
      durationMs: e.durationMs,
      output: e.output,
      at: iso(e.at),
    })),
    reviews: reviews.map((r): ReviewView => ({
      id: r.id,
      round: r.round,
      sha: r.sha,
      reviewer: r.reviewer,
      verdict: r.verdict,
      summary: r.summary,
      findings: r.findings as ReviewView['findings'],
      at: iso(r.at),
    })),
    plans: plans.map((p): ChangePlanView => ({
      id: p.id,
      baseSha: p.baseSha,
      harness: p.harness,
      ...(p.plan as Omit<ChangePlanView, 'id' | 'baseSha' | 'harness' | 'at'>),
      at: iso(p.at),
    })),
    questions: questions.map((q): QuestionView => ({
      id: q.id,
      body: q.body,
      askedAt: iso(q.askedAt),
      answer: q.answer,
      answeredBy: q.answeredBy,
      answeredAt: q.answeredAt ? iso(q.answeredAt) : null,
    })),
    decisions: decisions.map((d): DecisionView => ({
      id: d.id,
      kind: d.kind,
      sha: d.sha,
      note: d.note,
      at: iso(d.at),
    })),
    runs: runs.map((r): RunView => ({
      id: r.id,
      role: r.role,
      harness: r.harness,
      model: r.model,
      effort: r.effort,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      attempt: r.attempt,
      costUsd: r.costUsd,
      durationMs: r.durationMs,
      ok: r.ok,
      quota: r.quota,
      at: iso(r.at),
    })),
    watches: watches.map((w): WatchView => ({
      id: w.id,
      sha: w.sha,
      tag: w.tag,
      status: w.status,
      revertUrl: w.revertUrl,
      detail: w.detail,
      startedAt: iso(w.startedAt),
      endedAt: w.endedAt ? iso(w.endedAt) : null,
      acknowledged: w.acknowledgedAt !== null,
    })),
    deliveries: deliveries.map((d): DeliveryView => ({
      id: d.id,
      kind: d.kind,
      tag: d.tag,
      url: d.url,
      sha: d.sha,
      actor: d.actor,
      at: iso(d.at),
    })),
  }
}

const oneLine = (text: string, max = 200) => text.replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * What waits for a person: a question to answer, a pull request nobody approved yet, work handed
 * over after three attempts, and a run that failed. Oldest first, because that is what has waited
 * the longest.
 */
export async function inbox(db: Database): Promise<InboxItem[]> {
  const rows = await db
    .select()
    .from(task)
    .where(inArray(task.stage, ['waiting', 'done', 'handoff', 'failed']))
  const all = await cards(db, rows)
  const items: InboxItem[] = []
  for (const card of all) {
    const [last] = await db
      .select()
      .from(stageEvent)
      .where(eq(stageEvent.taskId, card.id))
      .orderBy(desc(stageEvent.id))
      .limit(1)
    const detail = (last?.detail ?? {}) as Record<string, unknown>
    const at = last ? iso(last.at) : card.updatedAt
    if (card.stage === 'waiting') {
      items.push({
        task: card,
        kind: 'question',
        summary: oneLine(String(detail.question ?? 'A question')),
        at,
      })
    } else if (card.stage === 'handoff') {
      items.push({
        task: card,
        kind: 'handoff',
        summary: oneLine(String(detail.reason ?? 'Needs a person')),
        at,
      })
    } else if (card.stage === 'failed') {
      const quota = detail.quota === true
      const error = oneLine(String(detail.error ?? 'The run failed'))
      items.push({
        task: card,
        kind: 'failed',
        summary: quota ? `Out of quota. ${error}` : error,
        at,
      })
    } else if (card.stage === 'done' && !card.approved && !card.resolved) {
      items.push({ task: card, kind: 'review', summary: 'Pull request ready to review', at })
    }
  }
  const red = await db
    .select()
    .from(watch)
    .where(and(eq(watch.status, 'red'), isNull(watch.acknowledgedAt)))
  if (red.length > 0) {
    const owners = await cards(
      db,
      await db
        .select()
        .from(task)
        .where(inArray(task.id, [...new Set(red.map((w) => w.taskId))])),
    )
    for (const w of red) {
      const owner = owners.find((c) => c.id === w.taskId)
      if (!owner) continue
      items.push({
        task: owner,
        kind: 'main_red',
        summary: `The default branch went red after ${w.tag ?? 'a release'}. ${
          w.revertUrl ? 'A revert pull request is open.' : 'No revert pull request could be opened.'
        } ${oneLine(w.detail ?? '')}`.trim(),
        at: iso(w.endedAt ?? w.startedAt),
      })
    }
  }
  items.push(...(await missingReleases(db)))
  return items.sort((a, b) => a.at.localeCompare(b.at))
}

/**
 * The releases that the last shipment of each repository found missing for the task it left open. Nothing
 * else will publish them, so the owner is told; the next shipment replaces what is said here.
 */
async function missingReleases(db: Database): Promise<InboxItem[]> {
  const rows = await db
    .select()
    .from(setting)
    .where(like(setting.key, `${MISSING_KEY}%`))
  const items: InboxItem[] = []
  for (const row of rows) {
    const { taskId, missing } = JSON.parse(row.value) as { taskId?: number; missing: string[] }
    if (taskId === undefined || missing.length === 0) continue
    for (const card of await cards(db, await db.select().from(task).where(eq(task.id, taskId)))) {
      items.push({
        task: card,
        kind: 'publication_partial',
        summary: `No release for ${missing.join(', ')} in ${row.key.slice(MISSING_KEY.length)}; the issues of that package stay open.`,
        at: iso(row.updatedAt),
      })
    }
  }
  return items
}

/**
 * What the factory costs and what is wrong with it. Cost is told per agent and per role, because a
 * builder and a reviewer on different agents are two different bills, and an agent that reports no
 * cost (Codex) is counted as runs, not as zero dollars.
 */
export async function health(db: Database, now = new Date()): Promise<HealthReport> {
  const since = (ms: number) => new Date(now.getTime() - ms)
  const spent = async (from?: Date) => {
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${agentRun.costUsd}), 0)` })
      .from(agentRun)
      .where(from ? gt(agentRun.at, from) : undefined)
    return Number(row.total)
  }
  const groups = await db
    .select({
      harness: agentRun.harness,
      role: agentRun.role,
      runs: sql<number>`count(*)`,
      reportedRuns: sql<number>`count(${agentRun.costUsd})`,
      costUsd: sql<number>`coalesce(sum(${agentRun.costUsd}), 0)`,
      avgDurationMs: sql<number>`coalesce(avg(${agentRun.durationMs}), 0)`,
      failed: sql<number>`count(*) filter (where not ${agentRun.ok} and not ${agentRun.quota})`,
      quota: sql<number>`count(*) filter (where ${agentRun.quota})`,
    })
    .from(agentRun)
    .groupBy(agentRun.harness, agentRun.role)
    .orderBy(agentRun.harness, agentRun.role)
  const [perTask] = await db
    .select({
      tasks: sql<number>`count(*) filter (where ${task.costUsd} > 0)`,
      total: sql<number>`coalesce(sum(${task.costUsd}), 0)`,
    })
    .from(task)
  const tasks = Number(perTask.tasks)
  const open = await db
    .select({ f: finding, title: task.issueTitle })
    .from(finding)
    .leftJoin(task, eq(task.id, finding.taskId))
    .where(isNull(finding.resolvedAt))
    .orderBy(asc(finding.firstSeenAt))
  return {
    cost: {
      last24HoursUsd: await spent(since(24 * 3_600_000)),
      last7DaysUsd: await spent(since(7 * 24 * 3_600_000)),
      totalUsd: await spent(),
      tasks,
      avgPerTaskUsd: tasks === 0 ? 0 : Number(perTask.total) / tasks,
      groups: groups.map((g): CostGroup => ({
        harness: g.harness,
        role: g.role,
        runs: Number(g.runs),
        reportedRuns: Number(g.reportedRuns),
        costUsd: Number(g.costUsd),
        avgDurationMs: Math.round(Number(g.avgDurationMs)),
        failed: Number(g.failed),
        quota: Number(g.quota),
      })),
    },
    findings: open.map(({ f, title }): FindingView => ({
      id: f.id,
      kind: f.kind,
      subject: f.subject,
      taskId: f.taskId,
      taskTitle: title,
      ref: f.ref,
      detail: f.detail,
      firstSeenAt: iso(f.firstSeenAt),
      lastSeenAt: iso(f.lastSeenAt),
    })),
  }
}
