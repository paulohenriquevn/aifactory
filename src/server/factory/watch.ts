import { and, eq } from 'drizzle-orm'

import type { Database } from '../db'
import { task, watch } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { CommitChecks, GithubApi } from '../github/pulls'

/** What the checks on a commit say, without waiting for ones that have not finished. */
export type MainState = { state: 'green' | 'red' | 'pending' | 'none'; failing: string[] }

/** A run that ended in one of these means the commit is broken. A cancelled run says nothing. */
const BROKEN = new Set(['failure', 'timed_out', 'action_required', 'startup_failure'])

/**
 * Reads a commit's check runs and statuses. A failing check makes it red even while others still run,
 * because waiting would only delay the revert. No checks at all is `none`, which is not green: nothing
 * said the commit is fine.
 */
export function classify(checks: CommitChecks): MainState {
  const failing = checks.checkRuns
    .filter((r) => r.status === 'completed' && r.conclusion !== null && BROKEN.has(r.conclusion))
    .map((r) => r.name)
  if (checks.statuses === 'failure' || checks.statuses === 'error') failing.push('commit status')
  if (failing.length > 0) return { state: 'red', failing }
  const running = checks.checkRuns.some((r) => r.status !== 'completed')
  if (running || checks.statuses === 'pending') return { state: 'pending', failing: [] }
  if (checks.checkRuns.length === 0 && checks.statuses === 'none')
    return { state: 'none', failing: [] }
  return { state: 'green', failing: [] }
}

/** How long after a release the watch waits for checks to report before it gives up. */
export const WATCH_WINDOW_MS = 60 * 60_000

export type WatchDeps = {
  db: Database
  github: GithubApp
  api: GithubApi
  now?: () => Date
  windowMs?: number
}

export type WatchResult = {
  green: number[]
  red: number[]
  silent: number[]
  waiting: number
}

function revertBody(input: {
  title: string
  issueNumber: number
  pullRequestNumber: number
  sha: string
  tag: string | null
  failing: string[]
}): string {
  return [
    `The default branch went red after ${input.tag ? `the release ${input.tag}` : 'a release'} of #${input.issueNumber} (${input.title}).`,
    '',
    `The checks on the merge commit \`${input.sha.slice(0, 7)}\` failed: ${input.failing.map((f) => `\`${f}\``).join(', ')}.`,
    '',
    `This pull request reverts #${input.pullRequestNumber}. The factory opened it and will not merge it: a person decides, because a revert can itself be wrong, for instance when later commits built on the one it undoes.`,
    '',
  ].join('\n')
}

/**
 * Looks at every release under watch. Green ends the watch, red opens a pull request that reverts the
 * merge (and nothing merges it), and checks that never report end it as `silent` once the window is
 * over. Nothing in here calls a merge: the revert is only ever opened.
 */
export async function pollWatches(deps: WatchDeps): Promise<WatchResult> {
  const now = (deps.now ?? (() => new Date()))()
  const windowMs = deps.windowMs ?? WATCH_WINDOW_MS
  const open = await deps.db
    .select({ w: watch, title: task.issueTitle, issueNumber: task.issueNumber })
    .from(watch)
    .innerJoin(task, eq(task.id, watch.taskId))
    .where(eq(watch.status, 'watching'))
  const result: WatchResult = { green: [], red: [], silent: [], waiting: 0 }

  const end = async (id: number, status: 'green' | 'red' | 'silent', fields: object = {}) => {
    const done = await deps.db
      .update(watch)
      .set({ status, endedAt: now, ...fields })
      .where(and(eq(watch.id, id), eq(watch.status, 'watching')))
      .returning({ id: watch.id })
    return done.length > 0
  }

  for (const { w, title, issueNumber } of open) {
    const { token } = await deps.github.installationToken(w.repository)
    const seen = classify(await deps.api.commitChecks(w.repository, token, w.sha))

    if (seen.state === 'red') {
      // Taken before the revert is made, so two passes cannot open two. It stays `reverting`, not
      // `red`, until the attempt is over: a red watch is read as "no revert was opened" if it has none.
      const taken = await deps.db
        .update(watch)
        .set({ status: 'reverting', detail: `failing: ${seen.failing.join(', ')}` })
        .where(and(eq(watch.id, w.id), eq(watch.status, 'watching')))
        .returning({ id: watch.id })
      if (taken.length === 0) continue
      result.red.push(w.id)
      let revertUrl: string | null = null
      let detail = `failing: ${seen.failing.join(', ')}`
      try {
        const revert = await deps.api.revertPullRequest(w.repository, token, w.pullRequestNumber, {
          title: `Revert: ${title} (#${issueNumber})`,
          body: revertBody({
            title,
            issueNumber,
            pullRequestNumber: w.pullRequestNumber,
            sha: w.sha,
            tag: w.tag,
            failing: seen.failing,
          }),
        })
        revertUrl = revert.url
      } catch (error) {
        detail += `; no revert was opened: ${error instanceof Error ? error.message : String(error)}`
      }
      await deps.db
        .update(watch)
        .set({ status: 'red', endedAt: now, revertUrl, detail })
        .where(eq(watch.id, w.id))
    } else if (seen.state === 'green') {
      if (await end(w.id, 'green')) result.green.push(w.id)
    } else if (now.getTime() - w.startedAt.getTime() > windowMs) {
      const why =
        seen.state === 'none'
          ? 'no check reported on the merge commit'
          : 'checks were still running'
      if (
        await end(w.id, 'silent', {
          detail: `${why} after ${Math.round(windowMs / 60_000)} minutes`,
        })
      ) {
        result.silent.push(w.id)
      }
    } else {
      result.waiting += 1
    }
  }
  return result
}
