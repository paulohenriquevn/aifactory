import type { FetchLike } from './app'

export type NewIssue = {
  title: string
  body: string
  labels?: string[]
  milestone?: number
}

export type CreatedIssue = { number: number; url: string }

/** What the panel writes to GitHub: issues, the labels they carry and the milestone that gathers them. */
export type IssuesApi = {
  createIssue(repo: string, token: string, issue: NewIssue): Promise<CreatedIssue>
  /** Makes sure a label exists. One that is already there is left as it is. */
  ensureLabel(
    repo: string,
    token: string,
    label: { name: string; color: string; description: string },
  ): Promise<void>
  createMilestone(
    repo: string,
    token: string,
    milestone: { title: string; description: string },
  ): Promise<number>
  addLabels(repo: string, token: string, issueNumber: number, labels: string[]): Promise<void>
}

/** Runs on the factory host with an installation token for one repository. */
export function createIssuesApi(fetchImpl: FetchLike = (url, init) => fetch(url, init)): IssuesApi {
  const call = (repo: string, token: string, path: string, body: unknown) =>
    fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    })

  async function expect(response: Response, action: string, statuses: number[]) {
    if (!statuses.includes(response.status)) {
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      throw new Error(`GitHub answered ${response.status} ${action}: ${detail}`)
    }
    return response
  }

  return {
    async createIssue(repo, token, issue) {
      const response = await expect(
        await call(repo, token, '/issues', issue),
        `creating an issue on ${repo}`,
        [201],
      )
      const created = (await response.json()) as { number: number; html_url: string }
      return { number: created.number, url: created.html_url }
    },

    async ensureLabel(repo, token, label) {
      // 422 is "already exists": the label the owner may have colored already stays as it is.
      await expect(
        await call(repo, token, '/labels', label),
        `creating the ${label.name} label on ${repo}`,
        [201, 422],
      )
    },

    async createMilestone(repo, token, milestone) {
      const response = await expect(
        await call(repo, token, '/milestones', milestone),
        `creating a milestone on ${repo}`,
        [201],
      )
      return ((await response.json()) as { number: number }).number
    },

    async addLabels(repo, token, issueNumber, labels) {
      await expect(
        await call(repo, token, `/issues/${issueNumber}/labels`, { labels }),
        `labelling ${repo}#${issueNumber}`,
        [200],
      )
    },
  }
}
