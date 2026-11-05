import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { eq, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { repository, task } from '../db/schema'
import { listTasks, taskDetail } from '../panel/queries'

/** What the assistant may read of the factory. It reads rows and a state file, and nothing it could run. */

const TEXT_MAX = 300
const cut = (value: unknown, max = TEXT_MAX) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').slice(0, max) : value

/** Counts of tasks by stage, the repositories the factory works in, and how it is set up. */
export async function factoryStatus(
  db: Database,
  env: NodeJS.ProcessEnv,
  feed = backlogProgress(),
) {
  const byStage = await db
    .select({ stage: task.stage, n: sql<number>`count(*)::int` })
    .from(task)
    .groupBy(task.stage)
  const repos = await db.select().from(repository).where(eq(repository.enabled, true))
  const failed = (await listTasks(db)).filter((c) => c.stage === 'failed')
  return {
    tasksByStage: Object.fromEntries(byStage.map((r) => [r.stage, r.n])),
    failedTasks: {
      willRetryItself: failed.filter((c) => c.retryable !== null).length,
      waitingForTheUsageLimit: failed.filter((c) => c.retryable === 'quota').length,
      needAPerson: failed.filter((c) => c.retryable === null).length,
    },
    repositories: repos.map((r) => ({
      name: r.fullName,
      integrationBranch: r.baseBranch ?? 'workspace',
      releaseBranch: r.releaseBranch ?? '(the default branch)',
      checks: r.checks?.map((c) => c.name) ?? ['npm test'],
      agentMayAsk: r.askQuestions,
    })),
    setup: {
      builder: env.FACTORY_HARNESS || 'claude-code',
      sandbox: env.FACTORY_SANDBOX || 'vercel',
      releaseMode: env.FACTORY_RELEASE_MODE || 'manual',
    },
    backlogFeed: feed,
  }
}

export type TaskFilter = { stage?: string; repository?: string; limit?: number }

/** Tasks, newest activity first, with what the owner wants to know about each. */
export async function findTasks(db: Database, filter: TaskFilter) {
  const limit = Math.min(Math.max(filter.limit ?? 15, 1), 40)
  const cards = await listTasks(db)
  return cards
    .filter((c) => !filter.stage || c.stage === filter.stage)
    .filter(
      (c) =>
        !filter.repository || c.repository.toLowerCase().includes(filter.repository.toLowerCase()),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      repository: c.repository,
      issue: c.issueNumber,
      title: cut(c.title, 120),
      stage: c.stage,
      integrated: c.integrated,
      preRelease: c.preRelease?.tag ?? null,
      pullRequest: c.pullRequestUrl,
      costUsd: Number(c.costUsd.toFixed(3)),
      updatedAt: c.updatedAt,
    }))
}

/** One task: where it is, the last things that happened to it, the checks and the review. */
export async function describeTask(db: Database, id: number) {
  const detail = await taskDetail(db, id)
  if (!detail) return { error: `there is no task ${id}` }
  return {
    task: {
      id: detail.task.id,
      repository: detail.task.repository,
      issue: detail.task.issueNumber,
      title: cut(detail.task.title, 160),
      stage: detail.task.stage,
      integrated: detail.task.integrated,
      pullRequest: detail.task.pullRequestUrl,
    },
    lastEvents: detail.timeline.slice(-6).map((e) => ({
      stage: e.stage,
      at: e.at,
      detail: e.detail
        ? Object.fromEntries(
            Object.entries(e.detail).map(([k, v]) => [
              k,
              cut(typeof v === 'string' ? v : JSON.stringify(v)),
            ]),
          )
        : null,
    })),
    checks: detail.evidence.map((e) => ({ name: e.name, passed: e.passed })),
    reviews: detail.reviews.map((r) => ({
      round: r.round,
      verdict: r.verdict,
      summary: cut(r.summary, 400),
    })),
  }
}

export type FeedState = Record<
  string,
  { outcome?: string; reason?: string; repo?: string; issue?: number; pullRequest?: string }
>

/** What the backlog feeder recorded: how many items ended each way, and which ones need attention. */
export function summarizeFeed(items: FeedState) {
  const outcomes: Record<string, number> = {}
  const attention: { item: string; outcome: string; reason: string; issue: string }[] = []
  for (const [id, entry] of Object.entries(items)) {
    const outcome = entry.outcome ?? 'in-progress'
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
    if (['failed', 'handoff', 'pr-open', 'not-started'].includes(outcome)) {
      attention.push({
        item: id,
        outcome,
        reason: String(cut(entry.reason ?? '', 160)),
        issue: entry.repo && entry.issue ? `${entry.repo}#${entry.issue}` : '',
      })
    }
  }
  return { itemsTried: Object.keys(items).length, outcomes, needAttention: attention.slice(0, 20) }
}

/** The feeder's state file, or nothing when it never ran here. */
export function backlogProgress(path = resolve(process.cwd(), '.backlog-feed/state.json')) {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { items?: FeedState }
    return summarizeFeed(parsed.items ?? {})
  } catch {
    return null
  }
}
