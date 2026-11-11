import type { FetchLike } from './app'

/** An open promotion pull request and the commit its checks run on. */
export type PromotionPull = { number: number; url: string; headSha: string }

/** A check run that failed. `actions` is true for a GitHub Actions job, whose id is the job's. */
export type FailedRun = {
  id: number
  name: string
  url: string
  summary: string
  actions: boolean
}

/** What the promotion watch reads from GitHub, and the one thing it does there: rerun a failed job. */
export type PromotionApi = {
  openPullRequest(
    repo: string,
    token: string,
    head: string,
    base: string,
  ): Promise<PromotionPull | undefined>
  failedChecks(repo: string, token: string, sha: string): Promise<FailedRun[]>
  jobAttempt(
    repo: string,
    token: string,
    jobId: number,
  ): Promise<{ runId: number; attempt: number }>
  jobLog(repo: string, token: string, jobId: number): Promise<string>
  annotations(repo: string, token: string, checkRunId: number): Promise<string[]>
  rerunFailedJobs(repo: string, token: string, runId: number): Promise<void>
  issueOpen(repo: string, token: string, issueNumber: number): Promise<boolean>
}

/** A run that ended this way says the commit is broken. A cancelled or skipped one says nothing. */
const FAILED = new Set(['failure', 'timed_out', 'startup_failure'])

/** Runs on the factory host with an installation token for one repository. */
export function createPromotionApi(
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): PromotionApi {
  const call = async (
    repo: string,
    token: string,
    path: string,
    action: string,
    ok: number[],
    method = 'GET',
  ) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${token}`,
      },
    })
    if (!ok.includes(response.status)) {
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      throw new Error(`GitHub answered ${response.status} ${action} on ${repo}: ${detail}`)
    }
    return response
  }

  return {
    async openPullRequest(repo, token, head, base) {
      const owner = repo.split('/')[0]
      const query = `state=open&head=${owner}:${encodeURIComponent(head)}&base=${encodeURIComponent(base)}`
      const pulls = (await (
        await call(
          repo,
          token,
          `/pulls?${query}`,
          `listing pull requests ${head} -> ${base}`,
          [200],
        )
      ).json()) as { number: number; html_url: string; head: { sha: string } }[]
      const pull = pulls[0]
      return pull ? { number: pull.number, url: pull.html_url, headSha: pull.head.sha } : undefined
    },

    async failedChecks(repo, token, sha) {
      const answer = (await (
        await call(
          repo,
          token,
          `/commits/${sha}/check-runs?filter=latest&per_page=100`,
          `reading the check runs of ${sha.slice(0, 7)}`,
          [200],
        )
      ).json()) as {
        check_runs: {
          id: number
          name: string
          status: string
          conclusion: string | null
          html_url?: string | null
          app?: { slug?: string } | null
          output?: { summary?: string | null } | null
        }[]
      }
      return answer.check_runs
        .filter((run) => run.status === 'completed' && FAILED.has(run.conclusion ?? ''))
        .map((run) => ({
          id: run.id,
          name: run.name,
          url: run.html_url ?? '',
          summary: run.output?.summary ?? '',
          actions: run.app?.slug === 'github-actions',
        }))
    },

    async jobAttempt(repo, token, jobId) {
      const job = (await (
        await call(repo, token, `/actions/jobs/${jobId}`, `reading job ${jobId}`, [200])
      ).json()) as { run_id: number; run_attempt: number }
      return { runId: job.run_id, attempt: job.run_attempt }
    },

    async jobLog(repo, token, jobId) {
      // GitHub answers with a redirect to the log's storage, which fetch follows without the token.
      return (
        await call(
          repo,
          token,
          `/actions/jobs/${jobId}/logs`,
          `reading the log of job ${jobId}`,
          [200],
        )
      ).text()
    },

    async annotations(repo, token, checkRunId) {
      const found = (await (
        await call(
          repo,
          token,
          `/check-runs/${checkRunId}/annotations?per_page=50`,
          `reading the annotations of check run ${checkRunId}`,
          [200],
        )
      ).json()) as { path: string; start_line: number; title: string | null; message: string }[]
      return found.map(
        (a) => `${a.path}:${a.start_line} ${a.title ? `${a.title}: ` : ''}${a.message}`,
      )
    },

    async rerunFailedJobs(repo, token, runId) {
      await call(
        repo,
        token,
        `/actions/runs/${runId}/rerun-failed-jobs`,
        `rerunning the failed jobs of run ${runId}`,
        [201],
        'POST',
      )
    },

    async issueOpen(repo, token, issueNumber) {
      const issue = (await (
        await call(repo, token, `/issues/${issueNumber}`, `reading issue #${issueNumber}`, [200])
      ).json()) as { state: string }
      return issue.state === 'open'
    },
  }
}
