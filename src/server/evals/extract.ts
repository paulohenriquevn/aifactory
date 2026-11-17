import { sql } from 'drizzle-orm'

import type { Database } from '../db'
import type { CheckSpec } from '../factory/evidence'

import { kindOf, type Candidate, type EvalCase } from './cases'

type Row = {
  task_id: number
  repository: string
  issue_number: number
  first_sha: string
  merged_sha: string
  cost_usd: string
  duration_ms: string
  attempts: number
  checks: CheckSpec[]
}

/**
 * The delivered tasks whose last run went straight through: a new sandbox, the first commit verified, and
 * `done` with its cost. A run resumed after a question is left out, since its prompt held an answer the
 * suite cannot give again. The checks are the ones that ran on the first commit, each once.
 */
export async function deliveredCandidates(db: Database): Promise<Candidate[]> {
  const result = await db.execute<Row>(sql`
    with last_run as (
      select task_id, max(id) as sandbox_id from stage_event where stage = 'sandbox' group by task_id
    ),
    runs as (
      select t.id as task_id, t.repository, t.issue_number, t.merged_sha,
        (select at from stage_event where id = l.sandbox_id) as started,
        (select e.at from stage_event e where e.task_id = t.id and e.id > l.sandbox_id and e.stage = 'done' order by e.id limit 1) as finished,
        (select e.detail from stage_event e where e.task_id = t.id and e.id > l.sandbox_id and e.stage = 'done' order by e.id limit 1) as done,
        (select e.detail->>'sha' from stage_event e where e.task_id = t.id and e.id > l.sandbox_id and e.stage = 'verify' order by e.id limit 1) as first_sha,
        exists (select 1 from stage_event e where e.task_id = t.id and e.id > l.sandbox_id and (e.detail->>'resumed')::boolean) as resumed
      from task t join last_run l on l.task_id = t.id
      where t.stage in ('done', 'released') and t.merged_sha is not null
    )
    select r.task_id, r.repository, r.issue_number, r.first_sha, r.merged_sha,
      coalesce((r.done->>'costUsd')::numeric, 0) as cost_usd,
      (extract(epoch from r.finished - r.started) * 1000)::bigint as duration_ms,
      coalesce((r.done->>'attempts')::int, 1) as attempts,
      coalesce((
        select json_agg(json_build_object('name', c.name, 'command', c.command) order by c.first_id)
        from (select name, command, min(id) as first_id from evidence
              where task_id = r.task_id and sha = r.first_sha group by name, command) c
      ), '[]'::json) as checks
    from runs r
    where r.finished is not null and r.first_sha is not null and not r.resumed
    order by r.task_id
  `)
  return result.rows.map((r) => ({
    taskId: r.task_id,
    repository: r.repository,
    issueNumber: r.issue_number,
    firstSha: r.first_sha,
    mergedSha: r.merged_sha,
    costUsd: Number(r.cost_usd),
    durationMs: Number(r.duration_ms),
    attempts: r.attempts,
    checks: r.checks,
  }))
}

/** What a case needs from outside the database: the issue, the commit history and the owner's settings. */
export type CaseSources = {
  issue(
    repository: string,
    number: number,
  ): Promise<{ title: string; body: string; labels: string[] }>
  /** The first parent of `sha`: the commit the run started from. */
  parentOf(repository: string, sha: string): Promise<string>
  config(repository: string): Promise<{ integrationBranch: string; egress: string[] }>
}

export async function toCase(candidate: Candidate, sources: CaseSources): Promise<EvalCase> {
  const { repository, issueNumber } = candidate
  const issue = await sources.issue(repository, issueNumber)
  const config = await sources.config(repository)
  return {
    id: `${repository}#${issueNumber}`,
    repository,
    issueNumber,
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    kind: kindOf(issue.labels),
    integrationBranch: config.integrationBranch,
    baseSha: await sources.parentOf(repository, candidate.firstSha),
    checks: candidate.checks,
    egress: config.egress,
    original: {
      taskId: candidate.taskId,
      costUsd: candidate.costUsd,
      durationMs: candidate.durationMs,
      attempts: candidate.attempts,
      mergedSha: candidate.mergedSha,
    },
  }
}
