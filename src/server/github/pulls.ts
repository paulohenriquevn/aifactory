import type { FetchLike } from './app'

export type CheckRun = {
  name: string
  headSha: string
  conclusion: 'success' | 'failure'
  title: string
  summary: string
}

export type PullRequest = { number: number; url: string }

export type GithubApi = {
  createCheckRun(repo: string, token: string, check: CheckRun): Promise<void>
  /** Opens a pull request from `head`, or returns the one already open for it. */
  openPullRequest(
    repo: string,
    token: string,
    pull: { head: string; title: string; body: string },
  ): Promise<PullRequest>
}

/** Runs on the factory host with an installation token, never in the sandbox. */
export function createGithubApi(fetchImpl: FetchLike = (url, init) => fetch(url, init)): GithubApi {
  const call = (repo: string, token: string, path: string, init: RequestInit = {}) =>
    fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    })

  async function ensure(response: Response, action: string, status: number[]) {
    if (!status.includes(response.status)) {
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      throw new Error(`GitHub answered ${response.status} ${action}: ${detail}`)
    }
    return response
  }

  return {
    async createCheckRun(repo, token, check) {
      await ensure(
        await call(repo, token, '/check-runs', {
          method: 'POST',
          body: JSON.stringify({
            name: check.name,
            head_sha: check.headSha,
            status: 'completed',
            conclusion: check.conclusion,
            output: { title: check.title, summary: check.summary },
          }),
        }),
        `creating the check run on ${repo}`,
        [201],
      )
    },

    async openPullRequest(repo, token, pull) {
      const owner = repo.split('/')[0]
      const open = (await (
        await ensure(
          await call(
            repo,
            token,
            `/pulls?state=open&head=${owner}:${encodeURIComponent(pull.head)}`,
          ),
          `listing pull requests of ${repo}`,
          [200],
        )
      ).json()) as { number: number; html_url: string }[]
      if (open[0]) return { number: open[0].number, url: open[0].html_url }

      const { default_branch: base } = (await (
        await ensure(await call(repo, token, ''), `reading ${repo}`, [200])
      ).json()) as { default_branch: string }
      const created = (await (
        await ensure(
          await call(repo, token, '/pulls', {
            method: 'POST',
            body: JSON.stringify({ head: pull.head, base, title: pull.title, body: pull.body }),
          }),
          `opening a pull request on ${repo}`,
          [201],
        )
      ).json()) as { number: number; html_url: string }
      return { number: created.number, url: created.html_url }
    },
  }
}
