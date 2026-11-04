import type { FetchLike } from './app'

export type CheckRun = {
  name: string
  headSha: string
  conclusion: 'success' | 'failure'
  title: string
  summary: string
}

export type IssueComment = {
  id: string
  body: string
  author: string
  /** `User` or `Bot`: a bot's comment is never an answer. */
  authorType: string
  /** The author's relation to the repository: `OWNER`, `MEMBER`, `COLLABORATOR`, `NONE`... */
  association: string
  createdAt: Date
}

export type PullRequest = { number: number; url: string }

export type GithubApi = {
  createCheckRun(repo: string, token: string, check: CheckRun): Promise<void>
  /** Opens a pull request from `head`, or returns the one already open for it. */
  openPullRequest(
    repo: string,
    token: string,
    pull: { head: string; title: string; body: string; draft?: boolean },
  ): Promise<PullRequest>
  /** Deletes a branch, which also closes a pull request that was open from it. A missing branch is fine. */
  deleteBranch(repo: string, token: string, branch: string): Promise<void>
  /** Posts a comment and returns its id. */
  commentOnIssue(repo: string, token: string, issueNumber: number, body: string): Promise<string>
  /** The comments on an issue made since a time, oldest first. */
  listIssueComments(
    repo: string,
    token: string,
    issueNumber: number,
    since: Date,
  ): Promise<IssueComment[]>
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
            body: JSON.stringify({
              head: pull.head,
              base,
              title: pull.title,
              body: pull.body,
              draft: pull.draft ?? false,
            }),
          }),
          `opening a pull request on ${repo}`,
          [201],
        )
      ).json()) as { number: number; html_url: string }
      return { number: created.number, url: created.html_url }
    },

    async deleteBranch(repo, token, branch) {
      const response = await call(repo, token, `/git/refs/heads/${branch}`, { method: 'DELETE' })
      // 422 is what GitHub answers for a ref that does not exist.
      await ensure(response, `deleting ${branch} on ${repo}`, [204, 404, 422])
    },

    async commentOnIssue(repo, token, issueNumber, body) {
      const response = await ensure(
        await call(repo, token, `/issues/${issueNumber}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body }),
        }),
        `commenting on ${repo}#${issueNumber}`,
        [201],
      )
      return String(((await response.json()) as { id: number }).id)
    },

    async listIssueComments(repo, token, issueNumber, since) {
      const response = await ensure(
        await call(
          repo,
          token,
          `/issues/${issueNumber}/comments?per_page=100&since=${encodeURIComponent(since.toISOString())}`,
        ),
        `listing comments on ${repo}#${issueNumber}`,
        [200],
      )
      const comments = (await response.json()) as {
        id: number
        body?: string
        user?: { login: string; type: string } | null
        author_association: string
        created_at: string
      }[]
      return comments.map((c) => ({
        id: String(c.id),
        body: c.body ?? '',
        author: c.user?.login ?? '',
        authorType: c.user?.type ?? '',
        association: c.author_association,
        createdAt: new Date(c.created_at),
      }))
    },
  }
}
