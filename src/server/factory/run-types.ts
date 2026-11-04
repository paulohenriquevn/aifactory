import type { Database } from '../db'
import type { question as questionTable } from '../db/schema'
import type { FetchLike, GithubApp } from '../github/app'
import type { Issue } from '../github/issues'
import type { GithubApi } from '../github/pulls'

import type { ReleaseMode } from './deliver'
import type { CheckSpec } from './evidence'
import type { CodingHarness } from './harness'
import type { IsolatedSandboxProvider } from './sandbox'

export type HarnessChoice = CodingHarness | ((labels: string[]) => CodingHarness)

export type RunTaskDeps = {
  db: Database
  github: GithubApp
  sandbox: IsolatedSandboxProvider
  /** One agent for every task, or a function that chooses it from the issue's labels. */
  harness: HarnessChoice
  /**
   * The independent reviewer. A function may return nothing, and the builder then reviews its own
   * work in a fresh session, which is weaker: set a different agent for a real second opinion.
   */
  reviewer?: CodingHarness | ((labels: string[]) => CodingHarness | undefined)
  /** The commit author, so the pull request shows who wrote it. */
  author: { name: string; email: string }
  fetchIssue?: (repo: string, number: number, token: string, fetch?: FetchLike) => Promise<Issue>
  githubApi?: GithubApi
  /**
   * What the factory does with a release, the promotion of its work to the default branch. It always
   * makes a pre-release. `manual` (the default) leaves the release to a person, `trial` records what
   * an agent would have released, and `auto` releases a commit with green checks and an approval.
   */
  releaseMode?: ReleaseMode
  /** What must pass on the pushed commit before a pull request opens. */
  checks?: CheckSpec[]
  timeouts?: { sandboxMs: number; agentMs: number; checkMs?: number; reviewMs?: number }
  /** Wait between push attempts. */
  pushRetryDelayMs?: number
}

export type RunResult =
  | {
      status: 'done'
      branch: string
      sha: string
      pullRequestUrl: string
      summary: string
      preRelease?: string
      released?: string
    }
  | {
      status: 'handoff'
      branch: string
      sha: string
      pullRequestUrl: string
      reason: string
      preRelease?: string
    }
  | { status: 'waiting'; question: string }
  | { status: 'failed'; stage: string; error: string }

/** A question that parked a run, taken back to be resumed. */
export type Parked = typeof questionTable.$inferSelect
