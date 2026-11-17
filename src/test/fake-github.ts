import type { AppAccess, AppEvents, GithubApp } from '../server/github/app'
import type { IssuesApi } from '../server/github/issues-api'
import {
  AutoMergeRefused,
  type ChangedFile,
  type CheckReport,
  type CheckRun,
  type GithubApi,
  type IssueComment,
  type PullRequestMerge,
  type ReleaseInput,
} from '../server/github/pulls'

/**
 * GitHub in memory, for tests. It holds state (repositories, branches, issues, pull requests, checks,
 * releases) and answers the whole `GithubApi` from it, so two suites cannot disagree on how GitHub
 * behaves. A test arranges the state, runs the code, and then reads the state back or the calls made.
 *
 * It is lenient where a test has no reason to care: a repository, an issue or a branch nobody declared
 * comes into being the first time it is used. It is strict where the factory reacts: a draft or a
 * conflicting pull request does not merge, auto-merge is refused for a draft and for a clean pull
 * request, and any call can be told to fail (`fail`) or be observed while it runs (`before`).
 */

export type Method = keyof GithubApi

/** What a call carries after the repository and the token. */
export type Args<M extends Method> =
  Parameters<GithubApi[M]> extends [string, string, ...infer Rest] ? Rest : never

/** One call the code under test made. `failed` is true when the fake answered it with an error. */
export type Recorded<M extends Method> = {
  repo: string
  token: string
  args: Args<M>
  failed: boolean
}

/** Any call, with the method it went to. */
export type Call = { [M in Method]: { method: M } & Recorded<M> }[Method]

type Hook<M extends Method> = (call: Recorded<M>, repo: FakeRepository) => void | Promise<void>

const isCallTo = <M extends Method>(call: Call, method: M): call is Call & Recorded<M> =>
  call.method === method

/** An error worded as the real client words a refused call: the status, what was being done, the answer. */
export function githubAnswered(status: number, action: string, message = ''): Error {
  return new Error(
    `GitHub answered ${status} ${action}: ${message ? JSON.stringify({ message }) : ''}`,
  )
}

/** What GitHub says when it will not turn auto-merge on, by the reason. */
export const AUTO_MERGE_REFUSALS = {
  notAllowed: 'Auto merge is not allowed for this repository',
  clean: 'Pull request Pull request is in clean status',
  unstable: 'Pull request Pull request is in unstable status',
  draft: 'Pull request Pull request is a draft',
} as const

export type FakeIssue = {
  number: number
  title: string
  state: 'open' | 'closed'
  /** Why it was closed: `completed` is what the factory asks for. */
  stateReason?: string
  labels: string[]
  comments: IssueComment[]
}

export type FakePullRequest = {
  number: number
  url: string
  title: string
  body: string
  headRef: string
  /** `owner/name` of the repository the head branch lives in; undefined when that fork was deleted. */
  headRepo: string | undefined
  baseRef: string
  /** The head commit, when it is pinned. Left out, it is wherever the head branch points. */
  headSha?: string
  draft: boolean
  state: 'open' | 'closed'
  merged: boolean
  mergedAt?: Date
  mergeCommitSha?: string
  /** How it was merged, when a call merged it. */
  merge?: PullRequestMerge
  autoMerge: boolean
  /** The head auto-merge is pinned to. */
  autoMergeSha?: string
  /** GitHub's word for whether it can merge. Left out, it follows from the draft flag, conflicts and checks. */
  mergeableState?: string
}

/** A check run on a commit, as GitHub lists it. */
export type FakeCheckRun = {
  name: string
  status: string
  conclusion: string | null
  title: string
  summary: string
  url: string
}

/** A commit status, the older kind of check. */
export type FakeStatus = {
  context: string
  state: 'success' | 'failure' | 'error' | 'pending'
  description: string
  url: string
}

export type FakeRelease = {
  id: number
  tag: string
  sha: string
  name: string
  body: string
  prerelease: boolean
  draft: boolean
  url: string
  publishedAt: Date
}

/** What the GitHub App may do and what it hears, as its installation reads. */
export type FakeApp = {
  slug: string
  permissions: Record<string, 'read' | 'write'>
  events: string[]
}

const PASSING = new Set(['success', 'neutral', 'skipped'])

const reportState = (run: FakeCheckRun): CheckReport['state'] => {
  if (run.status !== 'completed' || run.conclusion === null) return 'pending'
  return PASSING.has(run.conclusion) ? 'success' : 'failure'
}

const statusState = (state: FakeStatus['state']): CheckReport['state'] => {
  if (state === 'success') return 'success'
  return state === 'pending' ? 'pending' : 'failure'
}

const serial = (prefix: string, n: number) => `${prefix}${String(n).padStart(4, '0')}`

/** One repository: its state, and the ways a test arranges it. */
export class FakeRepository {
  defaultBranch = 'main'
  hasIssues = true
  /** "Allow auto-merge" in the repository settings. */
  allowAutoMerge = true
  /** "Allow merge commits" in the repository settings. */
  allowMergeCommit = true
  /** The labels that exist, by name. */
  readonly labels = new Set<string>()
  /** The commit each branch points at. */
  readonly heads = new Map<string, string>([['main', 'a'.repeat(40)]])
  /** Branches GitHub does not let the App push or merge into directly. */
  readonly restricted = new Set<string>()
  /** Head branches whose work conflicts with the branch it goes into. */
  readonly conflicting = new Set<string>()
  /** Commits that are in the history of nothing: `contains` is false for them. */
  readonly unreachable = new Set<string>()
  private readonly histories = new Map<string, Set<string>>()
  /** The status checks each branch requires before anything merges into it. */
  readonly required = new Map<string, string[]>()
  readonly issues = new Map<number, FakeIssue>()
  readonly pulls: FakePullRequest[] = []
  readonly releases: FakeRelease[] = []
  /** Every tag, the ones releases made included. */
  readonly tags = new Set<string>()
  /** The number the next issue or pull request gets: GitHub counts both in one sequence. */
  nextNumber = 1

  private readonly logs = new Map<string, string[]>()
  private readonly trees = new Map<string, Map<string, string>>()
  private readonly comparisons = new Map<string, ChangedFile[]>()
  private readonly aheadBy = new Map<string, number>()
  private readonly committedAt = new Map<string, Date>()
  private readonly runs = new Map<string, FakeCheckRun[]>()
  private readonly statuses = new Map<string, FakeStatus[]>()
  private readonly merged = new Map<string, Set<string>>()
  private pullMerges = 0
  private readonly branchMerges = new Map<string, number>()
  private commentIds = 0

  constructor(
    readonly name: string,
    private readonly clock: () => Date,
  ) {}

  /** Gives the repository the integration and pre-release branches, as one the factory already worked in. */
  prepare(): this {
    this.heads.set('workspace', 'b'.repeat(40))
    this.heads.set('develop', 'c'.repeat(40))
    return this
  }

  /** Says what the last commits of a branch are, newest first. Its head becomes the first of them. */
  log(branch: string, shas: string[]): this {
    this.logs.set(branch, shas)
    if (shas[0]) this.heads.set(branch, shas[0])
    return this
  }

  /** The last commits of a branch, newest first: what a test said, or its head alone. */
  history(branch: string): string[] | undefined {
    const head = this.heads.get(branch)
    if (head === undefined) return undefined
    const said = this.logs.get(branch)
    return said?.[0] === head ? said : [head]
  }

  /** The commit a ref names: where a branch points, or the ref itself when it is not a branch. */
  resolve(ref: string): string {
    return this.heads.get(ref) ?? ref
  }

  /**
   * Says which commits are in the history of a ref, and that no other is. A ref nobody said this of holds
   * every commit that is not `unreachable`.
   */
  holds(ref: string, shas: string[]): this {
    this.histories.set(ref, new Set(shas))
    return this
  }

  /** Whether `ancestor` is in the history of `descendant`. */
  reaches(descendant: string, ancestor: string): boolean {
    const history = this.histories.get(descendant)
    return history ? history.has(ancestor) : !this.unreachable.has(ancestor)
  }

  /** Sets what a ref (a branch or a commit) holds: every file with its content. */
  files(ref: string, files: Record<string, string>): this {
    this.trees.set(ref, new Map(Object.entries(files)))
    return this
  }

  /** The files at a ref, looked up by the ref as given and then by the commit it names. */
  tree(ref: string): Map<string, string> | undefined {
    return this.trees.get(ref) ?? this.trees.get(this.resolve(ref))
  }

  /** Sets what a comparison lists, for when the two trees are not there to tell. */
  compare(base: string, head: string, files: ChangedFile[]): this {
    this.comparisons.set(`${base}...${head}`, files)
    return this
  }

  /** What `head` changes since `base`: the comparison a test set, or the difference of the two trees. */
  changes(base: string, head: string): ChangedFile[] {
    const set = this.comparisons.get(`${base}...${head}`)
    if (set) return set
    const before = this.tree(base)
    const after = this.tree(head)
    if (!before || !after) return []
    const changed: ChangedFile[] = []
    for (const [path, content] of after) {
      if (!before.has(path)) changed.push({ path, status: 'added' })
      else if (before.get(path) !== content) changed.push({ path, status: 'modified' })
    }
    for (const path of before.keys()) {
      if (!after.has(path)) changed.push({ path, status: 'removed' })
    }
    return changed
  }

  /** Says how far the branch `head` is ahead of `base`, and when its head was committed. */
  ahead(base: string, head: string, aheadBy: number, committedAt?: Date): this {
    this.aheadBy.set(`${base}...${head}`, aheadBy)
    const sha = this.heads.get(head)
    if (sha && committedAt) this.committedAt.set(sha, committedAt)
    return this
  }

  aheadOf(base: string, head: string): number {
    return this.aheadBy.get(`${base}...${head}`) ?? 0
  }

  committed(sha: string): Date {
    return this.committedAt.get(sha) ?? this.clock()
  }

  /** The issue with this number, created open when nobody declared it. */
  issue(number: number, over: Partial<Omit<FakeIssue, 'number'>> = {}): FakeIssue {
    let issue = this.issues.get(number)
    if (!issue) {
      issue = { number, title: `Issue ${number}`, state: 'open', labels: [], comments: [] }
      this.issues.set(number, issue)
      this.nextNumber = Math.max(this.nextNumber, number + 1)
    }
    return Object.assign(issue, over)
  }

  /** A comment on an issue. Left to the defaults, the repository's owner wrote it now. */
  comment(issueNumber: number, over: Partial<IssueComment> = {}): IssueComment {
    const comment: IssueComment = {
      id: String(9000 + ++this.commentIds),
      body: '',
      author: this.name.split('/')[0],
      authorType: 'User',
      association: 'OWNER',
      createdAt: this.clock(),
      ...over,
    }
    this.issue(issueNumber).comments.push(comment)
    return comment
  }

  /** A pull request as it stands on GitHub. Left to the defaults: open, ready, from this repository. */
  pullRequest(over: Partial<FakePullRequest> = {}): FakePullRequest {
    const number = over.number ?? this.nextNumber
    this.nextNumber = Math.max(this.nextNumber, number + 1)
    const pull: FakePullRequest = {
      number,
      url: `https://github.com/${this.name}/pull/${number}`,
      title: `Pull request ${number}`,
      body: '',
      headRef: `branch-${number}`,
      headRepo: this.name,
      baseRef: this.defaultBranch,
      draft: false,
      state: 'open',
      merged: false,
      autoMerge: false,
      ...over,
    }
    const at = this.pulls.findIndex((p) => p.number === number)
    if (at >= 0) this.pulls[at] = pull
    else this.pulls.push(pull)
    return pull
  }

  /** The pull request with this number, or undefined. */
  pull(number: number): FakePullRequest | undefined {
    return this.pulls.find((p) => p.number === number)
  }

  /** The head of a pull request: the pinned one, or where its branch points, or nothing known. */
  headOf(pull: FakePullRequest): string {
    return pull.headSha ?? this.heads.get(pull.headRef) ?? ''
  }

  /**
   * GitHub's word for whether a pull request can merge: what a test set, or `draft`, `dirty` for a
   * conflict, `blocked` while a required check has not passed, `unstable` when another check failed,
   * and `clean` otherwise.
   */
  mergeableState(pull: FakePullRequest): string {
    if (pull.mergeableState) return pull.mergeableState
    if (pull.draft) return 'draft'
    if (this.conflicting.has(pull.headRef)) return 'dirty'
    const reports = this.reports(this.headOf(pull))
    const passed = (name: string) =>
      reports.some((r) => r.name === name && r.state === 'success') &&
      !reports.some((r) => r.name === name && r.state !== 'success')
    if (!(this.required.get(pull.baseRef) ?? []).every(passed)) return 'blocked'
    return reports.some((r) => r.state === 'failure') ? 'unstable' : 'clean'
  }

  /** Puts a check run on a commit, in place of the one with the same name. Left to the defaults, it passed. */
  checkRun(sha: string, run: Partial<FakeCheckRun> & { name: string }): this {
    const runs = (this.runs.get(sha) ?? []).filter((r) => r.name !== run.name)
    runs.push({
      status: 'completed',
      conclusion: 'success',
      title: '',
      summary: '',
      url: '',
      ...run,
    })
    this.runs.set(sha, runs)
    return this
  }

  /** Puts a check on a commit by what it reports: `pending` is a run in progress, with no conclusion. */
  report(sha: string, report: Partial<CheckReport> & { name: string }): this {
    const state = report.state ?? 'success'
    return this.checkRun(sha, {
      name: report.name,
      status: state === 'pending' ? 'in_progress' : 'completed',
      conclusion: state === 'pending' ? null : state,
      summary: report.detail ?? '',
      url: report.url ?? '',
    })
  }

  /** Puts a commit status on a commit, in place of the one with the same context. */
  status(sha: string, status: Partial<FakeStatus> & { context: string }): this {
    const statuses = (this.statuses.get(sha) ?? []).filter((s) => s.context !== status.context)
    statuses.push({ state: 'success', description: '', url: '', ...status })
    this.statuses.set(sha, statuses)
    return this
  }

  /** Takes every check run and commit status off a commit, as before anything reported on it. */
  clearChecks(sha: string): this {
    this.runs.delete(sha)
    this.statuses.delete(sha)
    return this
  }

  checkRuns(sha: string): FakeCheckRun[] {
    return this.runs.get(sha) ?? []
  }

  commitStatuses(sha: string): FakeStatus[] {
    return this.statuses.get(sha) ?? []
  }

  /** Every check run and commit status on a commit, as `checkReports` answers. */
  reports(sha: string): CheckReport[] {
    return [
      ...this.checkRuns(sha).map((r) => ({
        name: r.name,
        state: reportState(r),
        detail: r.summary,
        url: r.url,
      })),
      ...this.commitStatuses(sha).map((s) => ({
        name: s.context,
        state: statusState(s.state),
        detail: s.description,
        url: s.url,
      })),
    ]
  }

  /** A release the repository already published, with its tag. Left to the defaults, a full release made now. */
  release(over: Partial<FakeRelease> & { tag: string }): FakeRelease {
    const release: FakeRelease = {
      id: this.releases.length + 1,
      sha: '',
      name: over.tag,
      body: '',
      prerelease: false,
      draft: false,
      url: `https://github.com/${this.name}/releases/tag/${over.tag}`,
      publishedAt: this.clock(),
      ...over,
    }
    this.releases.push(release)
    this.tags.add(release.tag)
    return release
  }

  /** Merges a pull request as GitHub does: a merge commit on the base, and the pull request closed. */
  mergePull(pull: FakePullRequest, merge?: PullRequestMerge): string {
    const sha = serial('merge', ++this.pullMerges)
    Object.assign(pull, {
      headSha: this.headOf(pull),
      state: 'closed',
      merged: true,
      mergedAt: this.clock(),
      mergeCommitSha: sha,
      merge,
      autoMerge: false,
      autoMergeSha: undefined,
    })
    this.heads.set(pull.baseRef, sha)
    return sha
  }

  /** Merges a commit into a branch. Nothing changes when the branch already has it. */
  mergeInto(base: string, head: string): { sha: string; changed: boolean } {
    const at = this.heads.get(base)
    const sha = this.resolve(head)
    const already = this.merged.get(base) ?? new Set<string>()
    if (at !== undefined && (at === sha || already.has(sha))) return { sha: at, changed: false }
    const count = (this.branchMerges.get(base) ?? 0) + 1
    this.branchMerges.set(base, count)
    this.merged.set(base, already.add(sha))
    const made = serial(base, count)
    this.heads.set(base, made)
    return { sha: made, changed: true }
  }
}

export class FakeGithub implements GithubApi {
  /** What the App may do and hears, which `appClient` answers from. */
  readonly app: FakeApp = {
    slug: 'aifactory',
    permissions: {
      metadata: 'read',
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      checks: 'write',
      workflows: 'write',
      statuses: 'read',
    },
    events: ['issues'],
  }
  /** The time GitHub stamps on what it creates. */
  now: () => Date = () => new Date()
  /** Every call in the order it was made, the refused ones included. */
  readonly calls: Call[] = []

  /** Repositories the App is not installed on, by name: no token can be had for them. */
  readonly unreached = new Set<string>()

  private readonly repositories = new Map<string, FakeRepository>()
  private readonly hooks: ((call: Call, repo: FakeRepository) => void | Promise<void>)[] = []

  /** The repository with this name, in any letter case as on GitHub, created when nobody declared it. */
  repo(name: string): FakeRepository {
    const key = name.toLowerCase()
    let repo = this.repositories.get(key)
    if (!repo) {
      repo = new FakeRepository(name, () => this.now())
      this.repositories.set(key, repo)
    }
    return repo
  }

  private reaches(name: string): boolean {
    return ![...this.unreached].some((other) => other.toLowerCase() === name.toLowerCase())
  }

  /**
   * The App as the factory holds it, answered from the same state: a token names its repository
   * (`token-for-<repo>`), and a repository in `unreached` gets none.
   */
  appClient(): GithubApp & AppEvents & AppAccess {
    return {
      installationToken: async (repo) => {
        if (!this.reaches(repo)) throw new Error(`the GitHub App is not installed on ${repo}`)
        return { token: `token-for-${repo}`, expiresAt: new Date(this.now().getTime() + 3_600_000) }
      },
      subscriptions: async () => ({
        events: [...this.app.events],
        settingsUrl: `https://github.com/settings/apps/${this.app.slug}/permissions`,
      }),
      installationPermissions: async (repo) =>
        this.reaches(repo) ? { ...this.app.permissions } : undefined,
    }
  }

  /** Creates a label, as the panel's `IssuesApi` does. One that is already there stays as it is. */
  ensureLabel: IssuesApi['ensureLabel'] = async (repo, _token, label) => {
    this.repo(repo).labels.add(label.name)
  }

  /** Every repository the fake holds, declared or reached by a call. */
  get repos(): FakeRepository[] {
    return [...this.repositories.values()]
  }

  /** Every call made to a method, the refused ones included, as what each carried. */
  callsTo<M extends Method>(method: M): Args<M>[] {
    return this.recorded(method).map((call) => call.args)
  }

  /** The calls to a method that GitHub answered, as what each carried. */
  answered<M extends Method>(method: M): Args<M>[] {
    return this.recorded(method)
      .filter((call) => !call.failed)
      .map((call) => call.args)
  }

  /** Every call made to a method, with the repository, the token and whether it failed. */
  recorded<M extends Method>(method: M): Recorded<M>[] {
    return this.calls.filter((call) => isCallTo(call, method))
  }

  /**
   * Runs `hook` before each call to a method, with what the call carries and the repository's state.
   * A hook that throws fails the call. `once` drops the hook after its first run.
   */
  before<M extends Method>(method: M, hook: Hook<M>, options: { once?: boolean } = {}): this {
    const run = async (call: Call, repo: FakeRepository) => {
      if (!isCallTo(call, method)) return
      if (options.once) this.hooks.splice(this.hooks.indexOf(run), 1)
      await hook(call, repo)
    }
    this.hooks.push(run)
    return this
  }

  /**
   * Makes a method fail with `error`: every call, or only those `when` picks, and at most `times` of
   * them. A 5xx is `fail('readPullRequest', githubAnswered(502, 'reading o/r#1'))`.
   */
  fail<M extends Method>(
    method: M,
    error: Error,
    options: { when?: (...args: Args<M>) => boolean; times?: number } = {},
  ): this {
    let left = options.times ?? Infinity
    return this.before(method, (call) => {
      if (left <= 0 || (options.when && !options.when(...call.args))) return
      left -= 1
      throw error
    })
  }

  private async call<T>(call: Call, work: (repo: FakeRepository) => T): Promise<T> {
    this.calls.push(call)
    const state = this.repo(call.repo)
    try {
      for (const hook of [...this.hooks]) await hook(call, state)
      return work(state)
    } catch (error) {
      call.failed = true
      throw error
    }
  }

  private pullOrRefuse(repo: FakeRepository, number: number, action: string): FakePullRequest {
    const pull = repo.pull(number)
    if (!pull) throw githubAnswered(404, action, 'Not Found')
    return pull
  }

  async createCheckRun(repo: string, token: string, check: CheckRun): Promise<void> {
    return this.call(
      { method: 'createCheckRun', repo, token, args: [check], failed: false },
      (r) => {
        r.checkRun(check.headSha, {
          name: check.name,
          conclusion: check.conclusion,
          title: check.title,
          summary: check.summary,
        })
      },
    )
  }

  async openPullRequest(
    repo: string,
    token: string,
    pull: { head: string; base?: string; title: string; body: string; draft?: boolean },
  ) {
    return this.call(
      { method: 'openPullRequest', repo, token, args: [pull], failed: false },
      (r) => {
        const open = r.pulls.find(
          (p) => p.state === 'open' && p.headRef === pull.head && p.headRepo === r.name,
        )
        if (open) {
          return { number: open.number, url: open.url, draft: open.draft, title: open.title }
        }
        const made = r.pullRequest({
          headRef: pull.head,
          baseRef: pull.base ?? r.defaultBranch,
          title: pull.title,
          body: pull.body,
          draft: pull.draft ?? false,
        })
        return { number: made.number, url: made.url }
      },
    )
  }

  async createRelease(repo: string, token: string, release: ReleaseInput) {
    return this.call(
      { method: 'createRelease', repo, token, args: [release], failed: false },
      (r) => {
        const { id, tag, url } =
          r.releases.find((existing) => existing.tag === release.tag) ?? r.release({ ...release })
        return { id, tag, url }
      },
    )
  }

  async versionTags(repo: string, token: string) {
    return this.call({ method: 'versionTags', repo, token, args: [], failed: false }, (r) =>
      [...r.tags].filter((tag) => tag.startsWith('v')),
    )
  }

  async changedFiles(repo: string, token: string, base: string, head: string) {
    return this.call(
      { method: 'changedFiles', repo, token, args: [base, head], failed: false },
      (r) => r.changes(base, head),
    )
  }

  async filePaths(repo: string, token: string, ref: string) {
    return this.call({ method: 'filePaths', repo, token, args: [ref], failed: false }, (r) => [
      ...(r.tree(ref)?.keys() ?? []),
    ])
  }

  async readFile(repo: string, token: string, path: string, ref: string) {
    return this.call({ method: 'readFile', repo, token, args: [path, ref], failed: false }, (r) =>
      r.tree(ref)?.get(path),
    )
  }

  async listDirectory(repo: string, token: string, path: string, ref: string) {
    return this.call(
      { method: 'listDirectory', repo, token, args: [path, ref], failed: false },
      (r) => {
        const tree = r.tree(ref)
        if (tree?.has(path)) throw new Error(`${path} at ${ref} on ${repo} is not a directory`)
        const names = [...(tree?.keys() ?? [])]
          .filter((file) => file.startsWith(`${path}/`))
          .map((file) => file.slice(path.length + 1).split('/')[0])
        return names.length > 0 ? [...new Set(names)] : undefined
      },
    )
  }

  async releasesSince(repo: string, token: string, since: Date) {
    return this.call({ method: 'releasesSince', repo, token, args: [since], failed: false }, (r) =>
      r.releases
        .filter((release) => !release.prerelease && !release.draft)
        .filter((release) => release.publishedAt.getTime() >= since.getTime())
        .map(({ tag, url, publishedAt }) => ({ tag, url, publishedAt }))
        .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime()),
    )
  }

  async contains(repo: string, token: string, descendant: string, ancestor: string) {
    return this.call(
      { method: 'contains', repo, token, args: [descendant, ancestor], failed: false },
      (r) => r.reaches(descendant, ancestor),
    )
  }

  async findPullRequest(repo: string, token: string, head: string) {
    return this.call(
      { method: 'findPullRequest', repo, token, args: [head], failed: false },
      (r) => {
        const pull = r.pulls.filter((p) => p.headRef === head && p.headRepo === r.name).at(-1)
        if (!pull) return undefined
        return {
          number: pull.number,
          url: pull.url,
          headSha: r.headOf(pull),
          draft: pull.draft,
          state: pull.state,
          merged: pull.merged,
          mergedAt: pull.mergedAt,
        }
      },
    )
  }

  async openPullRequestsBetween(repo: string, token: string, head: string, base: string) {
    return this.call(
      { method: 'openPullRequestsBetween', repo, token, args: [head, base], failed: false },
      (r) =>
        r.pulls
          .filter((p) => p.state === 'open' && p.headRef === head && p.baseRef === base)
          .map((p) => ({
            number: p.number,
            url: p.url,
            headSha: r.headOf(p),
            headRef: p.headRef,
            headRepo: p.headRepo,
            baseRef: p.baseRef,
            draft: p.draft,
          })),
    )
  }

  async mergePullRequest(
    repo: string,
    token: string,
    number: number,
    sha: string,
    merge: PullRequestMerge,
  ) {
    return this.call(
      { method: 'mergePullRequest', repo, token, args: [number, sha, merge], failed: false },
      (r) => {
        const action = `merging ${repo}#${number}`
        const pull = this.pullOrRefuse(r, number, action)
        if (pull.state !== 'open')
          throw githubAnswered(405, action, 'Pull Request is not mergeable')
        if (pull.draft) throw githubAnswered(405, action, 'Pull Request is still a draft')
        if (r.mergeableState(pull) === 'dirty') {
          throw githubAnswered(405, action, 'Pull Request has merge conflicts')
        }
        const head = r.headOf(pull)
        if (head && head !== sha) {
          throw githubAnswered(
            409,
            action,
            'Head branch was modified. Review and try the merge again.',
          )
        }
        pull.headSha = sha
        return { sha: r.mergePull(pull, merge) }
      },
    )
  }

  async requiredChecks(repo: string, token: string, branch: string) {
    return this.call(
      { method: 'requiredChecks', repo, token, args: [branch], failed: false },
      (r) => [...new Set(r.required.get(branch) ?? [])],
    )
  }

  async readPullRequest(repo: string, token: string, number: number) {
    return this.call(
      { method: 'readPullRequest', repo, token, args: [number], failed: false },
      (r) => {
        const pull = this.pullOrRefuse(r, number, `reading ${repo}#${number}`)
        return {
          number: pull.number,
          url: pull.url,
          state: pull.state,
          merged: pull.merged,
          mergeCommitSha: pull.merged ? pull.mergeCommitSha : undefined,
          mergedAt: pull.mergedAt,
          headSha: r.headOf(pull),
          autoMerge: pull.autoMerge,
          mergeableState: r.mergeableState(pull),
        }
      },
    )
  }

  async enableAutoMerge(repo: string, token: string, number: number, sha: string): Promise<void> {
    return this.call(
      { method: 'enableAutoMerge', repo, token, args: [number, sha], failed: false },
      (r) => {
        const pull = this.pullOrRefuse(r, number, `reading ${repo}#${number}`)
        const refuse = (why: string) => new AutoMergeRefused(repo, number, why)
        if (pull.draft) throw refuse(AUTO_MERGE_REFUSALS.draft)
        if (!r.allowAutoMerge) throw refuse(AUTO_MERGE_REFUSALS.notAllowed)
        const state = r.mergeableState(pull)
        if (state === 'clean') throw refuse(AUTO_MERGE_REFUSALS.clean)
        if (state === 'unstable') throw refuse(AUTO_MERGE_REFUSALS.unstable)
        pull.autoMerge = true
        pull.autoMergeSha = sha
      },
    )
  }

  async markReadyForReview(
    repo: string,
    token: string,
    number: number,
    title: string,
  ): Promise<void> {
    return this.call(
      { method: 'markReadyForReview', repo, token, args: [number, title], failed: false },
      (r) => {
        const pull = this.pullOrRefuse(r, number, `reading ${repo}#${number}`)
        pull.draft = false
        pull.title = title
      },
    )
  }

  async disableAutoMerge(repo: string, token: string, number: number): Promise<void> {
    return this.call(
      { method: 'disableAutoMerge', repo, token, args: [number], failed: false },
      (r) => {
        const pull = this.pullOrRefuse(r, number, `reading ${repo}#${number}`)
        pull.autoMerge = false
        pull.autoMergeSha = undefined
      },
    )
  }

  async checkReports(repo: string, token: string, sha: string) {
    return this.call({ method: 'checkReports', repo, token, args: [sha], failed: false }, (r) =>
      r.reports(sha),
    )
  }

  async commitChecks(repo: string, token: string, sha: string) {
    return this.call({ method: 'commitChecks', repo, token, args: [sha], failed: false }, (r) => {
      const states = r.commitStatuses(sha).map((s) => s.state)
      const combined = () => {
        if (states.length === 0) return 'none' as const
        if (states.includes('error')) return 'error' as const
        if (states.includes('failure')) return 'failure' as const
        return states.includes('pending') ? ('pending' as const) : ('success' as const)
      }
      return {
        checkRuns: r
          .checkRuns(sha)
          .map(({ name, status, conclusion }) => ({ name, status, conclusion })),
        statuses: combined(),
      }
    })
  }

  async revertPullRequest(
    repo: string,
    token: string,
    number: number,
    revert: { title: string; body: string },
  ) {
    return this.call(
      { method: 'revertPullRequest', repo, token, args: [number, revert], failed: false },
      (r) => {
        const pull = r.pull(number)
        if (!pull?.merged) {
          throw new Error(
            `GitHub would not open a revert of ${repo}#${number}: ${pull ? 'the pull request is not merged' : 'Could not resolve to a node'}`,
          )
        }
        const made = r.pullRequest({
          headRef: `revert-${number}-${pull.headRef}`,
          baseRef: pull.baseRef,
          title: revert.title,
          body: revert.body,
        })
        return { number: made.number, url: made.url }
      },
    )
  }

  async repositorySettings(repo: string, token: string) {
    return this.call(
      { method: 'repositorySettings', repo, token, args: [], failed: false },
      (r) => ({
        hasIssues: r.hasIssues,
        defaultBranch: r.defaultBranch,
        allowAutoMerge: r.allowAutoMerge,
        allowMergeCommit: r.allowMergeCommit,
      }),
    )
  }

  async labelExists(repo: string, token: string, name: string) {
    return this.call({ method: 'labelExists', repo, token, args: [name], failed: false }, (r) =>
      r.labels.has(name),
    )
  }

  async recentCommits(repo: string, token: string, branch: string, count: number) {
    return this.call(
      { method: 'recentCommits', repo, token, args: [branch, count], failed: false },
      (r) => {
        const history = r.history(branch)
        if (!history) {
          throw githubAnswered(404, `listing the commits of ${branch} on ${repo}`, 'Not Found')
        }
        return history.slice(0, count)
      },
    )
  }

  async recentPullRequestHeads(repo: string, token: string, base: string, count: number) {
    return this.call(
      { method: 'recentPullRequestHeads', repo, token, args: [base, count], failed: false },
      (r) =>
        r.pulls
          .filter((pull) => pull.baseRef === base)
          .reverse()
          .slice(0, count)
          .map((pull) => r.headOf(pull)),
    )
  }

  async defaultBranch(repo: string, token: string) {
    return this.call(
      { method: 'defaultBranch', repo, token, args: [], failed: false },
      (r) => r.defaultBranch,
    )
  }

  async branchHead(repo: string, token: string, branch: string) {
    return this.call({ method: 'branchHead', repo, token, args: [branch], failed: false }, (r) =>
      r.heads.get(branch),
    )
  }

  async branchAhead(repo: string, token: string, base: string, head: string) {
    return this.call(
      { method: 'branchAhead', repo, token, args: [base, head], failed: false },
      (r) => {
        const sha = r.heads.get(head)
        if (sha === undefined) return undefined
        return { sha, aheadBy: r.aheadOf(base, head), committedAt: r.committed(sha) }
      },
    )
  }

  async createBranch(repo: string, token: string, branch: string, sha: string): Promise<void> {
    return this.call(
      { method: 'createBranch', repo, token, args: [branch, sha], failed: false },
      (r) => {
        if (r.heads.has(branch)) {
          throw githubAnswered(
            422,
            `creating the branch ${branch} of ${repo}`,
            'Reference already exists',
          )
        }
        r.heads.set(branch, sha)
      },
    )
  }

  async mergeBranch(repo: string, token: string, base: string, head: string) {
    return this.call(
      { method: 'mergeBranch', repo, token, args: [base, head], failed: false },
      (r) => {
        const action = `merging ${head.slice(0, 40)} into ${base} on ${repo}`
        if (!r.heads.has(base)) throw githubAnswered(404, action, 'Base does not exist')
        if (r.restricted.has(base)) {
          throw githubAnswered(
            409,
            action,
            `${base} is a protected branch: changes must be made through a pull request`,
          )
        }
        if (r.conflicting.has(head)) throw githubAnswered(409, action, 'Merge conflict')
        return r.mergeInto(base, head)
      },
    )
  }

  async deleteBranch(repo: string, token: string, branch: string): Promise<void> {
    return this.call(
      { method: 'deleteBranch', repo, token, args: [branch], failed: false },
      (r) => {
        r.heads.delete(branch)
        for (const pull of r.pulls) {
          if (pull.state === 'open' && pull.headRef === branch && pull.headRepo === r.name) {
            pull.state = 'closed'
          }
        }
      },
    )
  }

  async commentOnIssue(repo: string, token: string, issueNumber: number, body: string) {
    return this.call(
      { method: 'commentOnIssue', repo, token, args: [issueNumber, body], failed: false },
      (r) => {
        const isPull = r.pull(issueNumber) !== undefined
        if (!r.hasIssues && !isPull) {
          throw githubAnswered(
            410,
            `commenting on ${repo}#${issueNumber}`,
            'Issues are disabled for this repo',
          )
        }
        return r.comment(issueNumber, {
          body,
          author: `${this.app.slug}[bot]`,
          authorType: 'Bot',
          association: 'NONE',
        }).id
      },
    )
  }

  async closeIssue(repo: string, token: string, issueNumber: number): Promise<void> {
    return this.call(
      { method: 'closeIssue', repo, token, args: [issueNumber], failed: false },
      (r) => {
        if (!r.hasIssues) {
          throw githubAnswered(
            410,
            `closing ${repo}#${issueNumber}`,
            'Issues are disabled for this repo',
          )
        }
        r.issue(issueNumber, { state: 'closed', stateReason: 'completed' })
      },
    )
  }

  async listIssueComments(repo: string, token: string, issueNumber: number, since: Date) {
    return this.call(
      { method: 'listIssueComments', repo, token, args: [issueNumber, since], failed: false },
      (r) =>
        r
          .issue(issueNumber)
          .comments.filter((comment) => comment.createdAt.getTime() >= since.getTime())
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    )
  }
}
