import { and, eq, isNotNull, or } from 'drizzle-orm'

import type { Database } from '../db'
import { delivery, task } from '../db/schema'
import type { GithubApi } from '../github/pulls'

import { enterStage } from './stages'

/** A release that reached the release branch: what it promoted, under which tags, and who decided. */
export type Shipment = {
  repository: string
  token: string
  /** The commit on the release branch. A task is in the release when its merge is in this history. */
  promotedSha: string
  releaseBranch: string
  /** The task the release was asked for: it is in the release whatever the history says. */
  askedTaskId: number
  actor: string
  /** The tags the release is available under; the first one names it. */
  tags: { tag: string; url: string }[]
  /** Who made the tags, said after the promotion in the comment, when it was not the factory. */
  publishedBy?: string
  /** Added to the `released` stage of every task. */
  detail?: Record<string, unknown>
}

export type Shipped = {
  released: number[]
  /** Issues that could not be commented on or closed, as `#<number>: <why>`. The release stands. */
  issueErrors: string[]
}

/** What a publication's detail adds when issues of the release could not be closed. */
export const unclosedNote = (shipped: Shipped) =>
  shipped.issueErrors.length ? `; issues not closed: ${shipped.issueErrors.join('; ')}` : ''

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What every released issue is told: where the fix is, and how it got there. */
export const availableIn = (s: Shipment) =>
  [
    `Available in ${s.tags.map((t) => `\`${t.tag}\` (${t.url})`).join(', ')}.`,
    '',
    `Released by ${s.actor}: the promotion \`${s.promotedSha.slice(0, 7)}\` to \`${s.releaseBranch}\`${s.publishedBy ? `, published by ${s.publishedBy}` : ''}.`,
    '',
  ].join('\n')

/**
 * Comments where the fix is and closes the issue. A failure is returned, not thrown: the release already
 * happened, and one issue GitHub refuses must not stop the others.
 */
async function announce(
  api: GithubApi,
  s: Shipment,
  issueNumber: number,
): Promise<string | undefined> {
  try {
    await api.commentOnIssue(s.repository, s.token, issueNumber, availableIn(s))
    await api.closeIssue(s.repository, s.token, issueNumber)
    return undefined
  } catch (error) {
    return `#${issueNumber}: ${message(error)}`
  }
}

/** Whether a task is in the release and not already released under its first tag. */
async function belongs(
  deps: { db: Database; api: GithubApi },
  s: Shipment,
  t: typeof task.$inferSelect,
): Promise<boolean> {
  const known = await deps.db
    .select({ id: delivery.id })
    .from(delivery)
    .where(and(eq(delivery.taskId, t.id), eq(delivery.tag, s.tags[0].tag)))
  if (known.length > 0) return false
  if (t.id === s.askedTaskId) return true
  return deps.api.contains(s.repository, s.token, s.promotedSha, t.mergedSha!)
}

/**
 * Releases every task whose work is in the promoted commit: the one that asked for the release, and each
 * finished task integrated before it. Each gets a delivery per tag, moves to `released`, and its issue is
 * told where the fix is and closed. A task already holding a delivery of the first tag is left alone, so a
 * pass that runs again does not comment twice. An issue that cannot be closed is recorded on its task's
 * `released` stage and returned; the release is not undone.
 */
export async function shipContained(
  deps: { db: Database; api: GithubApi },
  s: Shipment,
): Promise<Shipped> {
  const candidates = await deps.db
    .select()
    .from(task)
    .where(
      and(
        eq(task.repository, s.repository),
        isNotNull(task.mergedSha),
        or(eq(task.stage, 'done'), eq(task.id, s.askedTaskId)),
      ),
    )
  const shipped: Shipped = { released: [], issueErrors: [] }
  for (const t of candidates) {
    if (!(await belongs(deps, s, t))) continue
    await deps.db.insert(delivery).values(
      s.tags.map((tag) => ({
        taskId: t.id,
        kind: 'release' as const,
        tag: tag.tag,
        url: tag.url,
        sha: s.promotedSha,
        actor: s.actor,
      })),
    )
    const issueError = await announce(deps.api, s, t.issueNumber)
    await enterStage(deps.db, t.id, 'released', {
      actor: s.actor,
      tag: s.tags.map((tag) => tag.tag).join(', '),
      url: s.tags[0].url,
      mergeSha: s.promotedSha,
      ...s.detail,
      ...(issueError ? { issueError } : {}),
    })
    shipped.released.push(t.id)
    if (issueError) shipped.issueErrors.push(issueError)
  }
  return shipped
}
