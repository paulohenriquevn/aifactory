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

export type ReleaseInput = {
  tag: string
  /** The commit the tag is created on. */
  sha: string
  name: string
  body: string
  prerelease: boolean
}

export type CreatedRelease = { id: number; tag: string; url: string }

export type PullRequestState = {
  number: number
  url: string
  headSha: string
  draft: boolean
  state: 'open' | 'closed'
  merged: boolean
  /** When it was merged, for a merged one. */
  mergedAt?: Date
}

/** A full release a repository published, as its own release workflow names it. */
export type PublishedRelease = { tag: string; url: string; publishedAt: Date }

export type CommitChecks = {
  checkRuns: { name: string; status: string; conclusion: string | null }[]
  /** The combined state of the older commit statuses. `none` when there are no statuses at all. */
  statuses: 'success' | 'failure' | 'error' | 'pending' | 'none'
}

export type PullRequest = { number: number; url: string }

/** A pull request read by its number, as the wait for the repository's checks needs it. */
export type PullRequestDetail = {
  number: number
  url: string
  state: 'open' | 'closed'
  merged: boolean
  /** The commit the merge made on the base, for a merged one. */
  mergeCommitSha?: string
  headSha: string
  /** Whether GitHub will merge it on its own once the required checks pass. */
  autoMerge: boolean
  /** GitHub's word for whether it can merge: `dirty` is a conflict with the base. */
  mergeableState: string
}

/**
 * One check on a commit, a check run or a commit status, reduced to what decides a merge. A skipped or
 * neutral run passes, as GitHub counts it for a required check. `detail` is what the check said about itself.
 */
export type CheckReport = {
  name: string
  state: 'success' | 'failure' | 'pending'
  detail: string
  url: string
}

/** GitHub would not turn auto-merge on, so the pull request would never merge on its own. */
export class AutoMergeRefused extends Error {
  constructor(repo: string, number: number, why: string) {
    super(
      `GitHub would not turn auto-merge on for ${repo}#${number}: ${why}. The integration branch requires status checks, so the factory waits for them through auto-merge: enable "Allow auto-merge" and "Allow merge commits" in the repository settings, and let the GitHub App write pull requests.`,
    )
    this.name = 'AutoMergeRefused'
  }
}

export type GithubApi = {
  createCheckRun(repo: string, token: string, check: CheckRun): Promise<void>
  /**
   * Opens a pull request from `head` into `base`, or into the default branch when `base` is not given,
   * or returns the one already open for it.
   */
  openPullRequest(
    repo: string,
    token: string,
    pull: { head: string; base?: string; title: string; body: string; draft?: boolean },
  ): Promise<PullRequest>
  /**
   * Creates a release and the tag it points at. A tag that already has a release is not an error:
   * the existing release comes back, so a repeated call delivers once.
   */
  createRelease(repo: string, token: string, release: ReleaseInput): Promise<CreatedRelease>
  /** The tag of the latest full release (not a pre-release), if there is one. */
  latestReleaseTag(repo: string, token: string): Promise<string | undefined>
  /** The names in a directory at a ref, or undefined when there is no such directory there. */
  listDirectory(
    repo: string,
    token: string,
    path: string,
    ref: string,
  ): Promise<string[] | undefined>
  /** The full releases (no pre-releases, no drafts) published at or after `since`, newest first. */
  releasesSince(repo: string, token: string, since: Date): Promise<PublishedRelease[]>
  /** Whether `ancestor` is in the history of `descendant`. */
  contains(repo: string, token: string, descendant: string, ancestor: string): Promise<boolean>
  /** The pull request opened from `head`, open or not, if there is one. */
  findPullRequest(repo: string, token: string, head: string): Promise<PullRequestState | undefined>
  /** Merges a pull request only if its head is still `sha`. Returns the merge commit. */
  mergePullRequest(
    repo: string,
    token: string,
    number: number,
    sha: string,
    merge: PullRequestMerge,
  ): Promise<{ sha: string }>
  /**
   * The status checks a branch requires before anything merges into it, from its branch protection and
   * its rulesets, each named once. Empty when it requires none.
   */
  requiredChecks(repo: string, token: string, branch: string): Promise<string[]>
  readPullRequest(repo: string, token: string, number: number): Promise<PullRequestDetail>
  /**
   * Has GitHub merge the pull request (a merge commit) once the base's required checks pass, and only if
   * its head is still `sha`. Throws `AutoMergeRefused` when GitHub will not.
   */
  enableAutoMerge(repo: string, token: string, number: number, sha: string): Promise<void>
  disableAutoMerge(repo: string, token: string, number: number): Promise<void>
  /** Every check run and commit status on a commit, with what each said. */
  checkReports(repo: string, token: string, sha: string): Promise<CheckReport[]>
  /** The check runs and commit statuses a commit has so far. */
  commitChecks(repo: string, token: string, sha: string): Promise<CommitChecks>
  /**
   * Opens a pull request that reverts a merged one. It only opens it: nothing here merges it.
   */
  revertPullRequest(
    repo: string,
    token: string,
    number: number,
    revert: { title: string; body: string },
  ): Promise<PullRequest>
  /** The repository's default branch: the one a release lands on. */
  defaultBranch(repo: string, token: string): Promise<string>
  /** The commit a branch points at, or undefined when the branch does not exist. */
  branchHead(repo: string, token: string, branch: string): Promise<string | undefined>
  /** Creates a branch at a commit. */
  createBranch(repo: string, token: string, branch: string, sha: string): Promise<void>
  /**
   * Merges `head` (a branch or a commit) into the branch `base`, on GitHub. `sha` is where `base` is
   * afterwards, and `changed` is false when `base` already had everything in `head`. A conflict, or a
   * branch GitHub does not let the App write to, is an error.
   */
  mergeBranch(
    repo: string,
    token: string,
    base: string,
    head: string,
  ): Promise<{ sha: string; changed: boolean }>
  /** Deletes a branch, which also closes a pull request that was open from it. A missing branch is fine. */
  deleteBranch(repo: string, token: string, branch: string): Promise<void>
  /** Posts a comment and returns its id. */
  commentOnIssue(repo: string, token: string, issueNumber: number, body: string): Promise<string>
  /** Closes an issue as completed: what it asked for is in the code. */
  closeIssue(repo: string, token: string, issueNumber: number): Promise<void>
  /** The comments on an issue made since a time, oldest first. */
  listIssueComments(
    repo: string,
    token: string,
    issueNumber: number,
    since: Date,
  ): Promise<IssueComment[]>
}

/**
 * How a pull request is merged. A squash names its own commit: left to GitHub, its message lists every
 * commit author as `Co-authored-by`, the factory's bot included, even when the bot is the only author
 * (observed on 2026-11-09, #13). `title` is the pull request's, and the commit is named as GitHub would
 * name it, with ` (#<number>)` after it and no body.
 */
export type PullRequestMerge =
  { readonly method: 'merge' } | { readonly method: 'squash'; readonly title: string }

function mergeFields(number: number, merge: PullRequestMerge): Record<string, string> {
  if (merge.method === 'merge') return { merge_method: 'merge' }
  return { merge_method: 'squash', commit_title: `${merge.title} (#${number})`, commit_message: '' }
}

/** Runs on the factory host with an installation token, never in the sandbox. */
/** How many times a merge is asked for when GitHub's answer is one a moment later may change. */
const MERGE_ATTEMPTS = 4
const MERGE_RETRY_MS = 3_000

/**
 * A merge refused for a moment: another merge moved the base between the request and the merge (405
 * "Base branch was modified"), or GitHub failed (5xx). A conflict is not one: it needs new work.
 */
const mergeMayPassLater = (status: number, message: string) =>
  status >= 500 || (status === 405 && /base branch was modified/i.test(message))

/** Conclusions GitHub counts as passing for a required check. */
const PASSING = new Set(['success', 'neutral', 'skipped'])

const runState = (status: string, conclusion: string | null): CheckReport['state'] => {
  if (status !== 'completed' || conclusion === null) return 'pending'
  return PASSING.has(conclusion) ? 'success' : 'failure'
}

const statusState = (state: string): CheckReport['state'] => {
  if (state === 'success') return 'success'
  return state === 'pending' ? 'pending' : 'failure'
}

type GraphqlAnswer<T> = { data?: T; errors?: { message: string }[] }

export function createGithubApi(
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): GithubApi {
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

  /** Runs a GraphQL mutation on a pull request, by its node id. Returns the answer and what went wrong. */
  async function onPullRequest<T>(
    repo: string,
    token: string,
    number: number,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<{ data?: T; why?: string }> {
    const pull = (await (
      await ensure(await call(repo, token, `/pulls/${number}`), `reading ${repo}#${number}`, [200])
    ).json()) as { node_id: string }
    const response = await fetchImpl('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables: { id: pull.node_id, ...variables } }),
    })
    const result = (await response.json().catch(() => ({}))) as GraphqlAnswer<T>
    if (result.errors?.length) return { why: result.errors.map((e) => e.message).join('; ') }
    if (!response.ok || !result.data) return { why: `HTTP ${response.status}` }
    return { data: result.data }
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

      const base =
        pull.base ??
        (
          (await (await ensure(await call(repo, token, ''), `reading ${repo}`, [200])).json()) as {
            default_branch: string
          }
        ).default_branch
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

    async createRelease(repo, token, release) {
      const response = await call(repo, token, '/releases', {
        method: 'POST',
        body: JSON.stringify({
          tag_name: release.tag,
          target_commitish: release.sha,
          name: release.name,
          body: release.body,
          prerelease: release.prerelease,
          draft: false,
          make_latest: release.prerelease ? 'false' : 'true',
        }),
      })
      if (response.status === 422) {
        const existing = await call(
          repo,
          token,
          `/releases/tags/${encodeURIComponent(release.tag)}`,
        )
        if (existing.ok) {
          const found = (await existing.json()) as {
            id: number
            tag_name: string
            html_url: string
          }
          return { id: found.id, tag: found.tag_name, url: found.html_url }
        }
      }
      const made = (await (
        await ensure(response, `creating release ${release.tag} on ${repo}`, [201])
      ).json()) as { id: number; tag_name: string; html_url: string }
      return { id: made.id, tag: made.tag_name, url: made.html_url }
    },

    async latestReleaseTag(repo, token) {
      const response = await call(repo, token, '/releases/latest')
      if (response.status === 404) return undefined
      return (
        (await (await ensure(response, `reading the latest release of ${repo}`, [200])).json()) as {
          tag_name: string
        }
      ).tag_name
    },

    async findPullRequest(repo, token, head) {
      const owner = repo.split('/')[0]
      const found = (await (
        await ensure(
          await call(repo, token, `/pulls?state=all&head=${owner}:${encodeURIComponent(head)}`),
          `listing pull requests of ${repo}`,
          [200],
        )
      ).json()) as {
        number: number
        html_url: string
        head: { sha: string }
        draft: boolean
        state: 'open' | 'closed'
        merged_at: string | null
      }[]
      const pr = found[0]
      return pr
        ? {
            number: pr.number,
            url: pr.html_url,
            headSha: pr.head.sha,
            draft: pr.draft,
            state: pr.state,
            merged: pr.merged_at !== null,
            mergedAt: pr.merged_at ? new Date(pr.merged_at) : undefined,
          }
        : undefined
    },

    async listDirectory(repo, token, path, ref) {
      const response = await call(
        repo,
        token,
        `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
      )
      if (response.status === 404) return undefined
      const body = (await (
        await ensure(response, `listing ${path} at ${ref} on ${repo}`, [200])
      ).json()) as { name: string }[] | { type: string }
      if (!Array.isArray(body)) {
        throw new Error(`${path} at ${ref} on ${repo} is not a directory`)
      }
      return body.map((entry) => entry.name)
    },

    async releasesSince(repo, token, since) {
      const releases = (await (
        await ensure(
          await call(repo, token, '/releases?per_page=100'),
          `listing the releases of ${repo}`,
          [200],
        )
      ).json()) as {
        tag_name: string
        html_url: string
        prerelease: boolean
        draft: boolean
        published_at: string | null
      }[]
      return releases
        .filter((r) => !r.prerelease && !r.draft && r.published_at !== null)
        .map((r) => ({ tag: r.tag_name, url: r.html_url, publishedAt: new Date(r.published_at!) }))
        .filter((r) => r.publishedAt.getTime() >= since.getTime())
    },

    async contains(repo, token, descendant, ancestor) {
      const body = (await (
        await ensure(
          await call(repo, token, `/compare/${ancestor}...${descendant}`),
          `comparing ${ancestor.slice(0, 7)} with ${descendant.slice(0, 7)} on ${repo}`,
          [200],
        )
      ).json()) as { status: string }
      return body.status === 'ahead' || body.status === 'identical'
    },

    async defaultBranch(repo, token) {
      const body = (await (
        await ensure(await call(repo, token, ''), `reading ${repo}`, [200])
      ).json()) as { default_branch: string }
      return body.default_branch
    },

    async branchHead(repo, token, branch) {
      const response = await call(
        repo,
        token,
        `/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
      )
      if (response.status === 404) return undefined
      const body = (await (
        await ensure(response, `reading the branch ${branch} of ${repo}`, [200])
      ).json()) as { object: { sha: string } }
      return body.object.sha
    },

    async createBranch(repo, token, branch, sha) {
      await ensure(
        await call(repo, token, '/git/refs', {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
        }),
        `creating the branch ${branch} of ${repo}`,
        [201],
      )
    },

    async mergeBranch(repo, token, base, head) {
      const response = await ensure(
        await call(repo, token, '/merges', {
          method: 'POST',
          body: JSON.stringify({
            base,
            head,
            commit_message: `Merge ${head.slice(0, 40)} into ${base}`,
          }),
        }),
        `merging ${head.slice(0, 40)} into ${base} on ${repo}`,
        [201, 204],
      )
      if (response.status === 201) {
        const body = (await response.json()) as { sha: string }
        return { sha: body.sha, changed: true }
      }
      const sha = await this.branchHead(repo, token, base)
      if (!sha) throw new Error(`the branch ${base} of ${repo} disappeared while merging into it`)
      return { sha, changed: false }
    },

    async mergePullRequest(repo, token, number, sha, merge) {
      const body = JSON.stringify({ sha, ...mergeFields(number, merge) })
      for (let attempt = 1; ; attempt += 1) {
        const response = await call(repo, token, `/pulls/${number}/merge`, { method: 'PUT', body })
        if (response.status !== 200 && attempt < MERGE_ATTEMPTS) {
          const message = await response
            .clone()
            .text()
            .catch(() => '')
          if (mergeMayPassLater(response.status, message)) {
            await wait(MERGE_RETRY_MS * attempt)
            continue
          }
        }
        const merged = (await (
          await ensure(response, `merging ${repo}#${number}`, [200])
        ).json()) as { sha: string }
        return { sha: merged.sha }
      }
    },

    async commitChecks(repo, token, sha) {
      const runs = (await (
        await ensure(
          await call(repo, token, `/commits/${sha}/check-runs?per_page=100`),
          `reading the check runs of ${sha.slice(0, 7)} on ${repo}`,
          [200],
        )
      ).json()) as {
        check_runs: { name: string; status: string; conclusion: string | null }[]
      }
      const combined = (await (
        await ensure(
          await call(repo, token, `/commits/${sha}/status`),
          `reading the statuses of ${sha.slice(0, 7)} on ${repo}`,
          [200],
        )
      ).json()) as { state: 'success' | 'failure' | 'error' | 'pending'; total_count: number }
      return {
        checkRuns: runs.check_runs.map((r) => ({
          name: r.name,
          status: r.status,
          conclusion: r.conclusion,
        })),
        statuses: combined.total_count === 0 ? 'none' : combined.state,
      }
    },

    async revertPullRequest(repo, token, number, revert) {
      const answer = await onPullRequest<{
        revertPullRequest?: { revertPullRequest?: { number: number; url: string } }
      }>(
        repo,
        token,
        number,
        'mutation($id: ID!, $title: String, $body: String) { revertPullRequest(input: { pullRequestId: $id, title: $title, body: $body }) { revertPullRequest { number url } } }',
        { title: revert.title, body: revert.body },
      )
      const made = answer.data?.revertPullRequest?.revertPullRequest
      if (!made) {
        throw new Error(
          `GitHub would not open a revert of ${repo}#${number}: ${answer.why ?? 'no pull request came back'}`,
        )
      }
      return { number: made.number, url: made.url }
    },

    async requiredChecks(repo, token, branch) {
      const path = branch.split('/').map(encodeURIComponent).join('/')
      const protection = (await (
        await ensure(
          await call(repo, token, `/branches/${path}`),
          `reading the branch ${branch} of ${repo}`,
          [200],
        )
      ).json()) as {
        protection?: {
          required_status_checks?: { contexts?: string[]; checks?: { context: string }[] }
        }
      }
      const rules = await call(repo, token, `/rules/branches/${path}`)
      const ruleset =
        rules.status === 404
          ? []
          : ((await (
              await ensure(rules, `reading the rules of the branch ${branch} of ${repo}`, [200])
            ).json()) as {
              type: string
              parameters?: { required_status_checks?: { context: string }[] }
            }[])
      const required = protection.protection?.required_status_checks
      return [
        ...new Set([
          ...(required?.contexts ?? []),
          ...(required?.checks ?? []).map((c) => c.context),
          ...ruleset
            .filter((rule) => rule.type === 'required_status_checks')
            .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
            .map((c) => c.context),
        ]),
      ]
    },

    async readPullRequest(repo, token, number) {
      const pr = (await (
        await ensure(
          await call(repo, token, `/pulls/${number}`),
          `reading ${repo}#${number}`,
          [200],
        )
      ).json()) as {
        number: number
        html_url: string
        state: 'open' | 'closed'
        merged: boolean
        merge_commit_sha: string | null
        head: { sha: string }
        auto_merge: object | null
        mergeable_state: string
      }
      return {
        number: pr.number,
        url: pr.html_url,
        state: pr.state,
        merged: pr.merged,
        // An open pull request's merge_commit_sha is GitHub's test merge, not anything on the base.
        mergeCommitSha: pr.merged ? (pr.merge_commit_sha ?? undefined) : undefined,
        headSha: pr.head.sha,
        autoMerge: pr.auto_merge !== null,
        mergeableState: pr.mergeable_state,
      }
    },

    async enableAutoMerge(repo, token, number, sha) {
      const answer = await onPullRequest(
        repo,
        token,
        number,
        'mutation($id: ID!, $sha: GitObjectID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: MERGE, expectedHeadOid: $sha }) { pullRequest { number } } }',
        { sha },
      )
      if (answer.why) throw new AutoMergeRefused(repo, number, answer.why)
    },

    async disableAutoMerge(repo, token, number) {
      const answer = await onPullRequest(
        repo,
        token,
        number,
        'mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { number } } }',
      )
      if (answer.why) {
        throw new Error(`GitHub could not turn auto-merge off on ${repo}#${number}: ${answer.why}`)
      }
    },

    async checkReports(repo, token, sha) {
      const runs = (await (
        await ensure(
          await call(repo, token, `/commits/${sha}/check-runs?per_page=100`),
          `reading the check runs of ${sha.slice(0, 7)} on ${repo}`,
          [200],
        )
      ).json()) as {
        check_runs: {
          name: string
          status: string
          conclusion: string | null
          html_url: string | null
          output?: { summary?: string | null; text?: string | null }
        }[]
      }
      const combined = (await (
        await ensure(
          await call(repo, token, `/commits/${sha}/status`),
          `reading the statuses of ${sha.slice(0, 7)} on ${repo}`,
          [200],
        )
      ).json()) as {
        statuses?: {
          context: string
          state: string
          description: string | null
          target_url: string | null
        }[]
      }
      return [
        ...runs.check_runs.map((r) => ({
          name: r.name,
          state: runState(r.status, r.conclusion),
          detail: [r.output?.summary, r.output?.text].filter(Boolean).join('\n'),
          url: r.html_url ?? '',
        })),
        ...(combined.statuses ?? []).map((s) => ({
          name: s.context,
          state: statusState(s.state),
          detail: s.description ?? '',
          url: s.target_url ?? '',
        })),
      ]
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

    async closeIssue(repo, token, issueNumber) {
      await ensure(
        await call(repo, token, `/issues/${issueNumber}`, {
          method: 'PATCH',
          body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
        }),
        `closing ${repo}#${issueNumber}`,
        [200],
      )
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
