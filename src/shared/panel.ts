/** What the panel's API returns. The server builds these, the interface reads them. */

export type Stage =
  | 'intake'
  | 'sandbox'
  | 'build'
  | 'push'
  | 'verify'
  | 'review'
  | 'waiting'
  | 'pr'
  | 'done'
  | 'released'
  | 'handoff'
  | 'failed'

/** Where a stage sits on the board. */
export type Column =
  'queued' | 'working' | 'waiting' | 'retrying' | 'review' | 'released' | 'attention'

export const COLUMNS: { id: Column; title: string }[] = [
  { id: 'queued', title: 'Queued' },
  { id: 'working', title: 'Working' },
  { id: 'waiting', title: 'Waiting for you' },
  { id: 'retrying', title: 'Will retry itself' },
  { id: 'review', title: 'Delivered' },
  { id: 'released', title: 'Released' },
  { id: 'attention', title: 'Needs a person' },
]

/**
 * Why a failed task is not waiting for a person: the agent's usage limit, or the environment (GitHub, the
 * network, the sandbox, a restart). Both pass, and the factory runs the task again once they have. A failure
 * of the work itself is neither, and stays with a person.
 */
export type Retryable = 'quota' | 'environment' | null

const ENVIRONMENT =
  /Internal Server Error|remote rejected|GitHub answered 5\d\d|\b50[234]\b|\b429\b|ECONN|ETIMEDOUT|ENOTFOUND|socket|fetch failed|out of memory|OOM|heap|is not running|killed \(most likely out of memory|was restarted|usage limit exceeded|Status code 402|timed out after \d+ ms|clone failed/i

/** From the detail the factory recorded when a task failed. */
export function retryableFailure(detail: Record<string, unknown> | null | undefined): Retryable {
  if (!detail) return null
  if (detail.quota === true) return 'quota'
  return typeof detail.error === 'string' && ENVIRONMENT.test(detail.error) ? 'environment' : null
}

export function columnOf(stage: Stage, retryable: Retryable = null): Column {
  if (stage === 'failed' && retryable) return 'retrying'
  switch (stage) {
    case 'intake':
      return 'queued'
    case 'waiting':
      return 'waiting'
    case 'done':
      return 'review'
    case 'released':
      return 'released'
    case 'handoff':
    case 'failed':
      return 'attention'
    default:
      return 'working'
  }
}

export type DeliveryView = {
  id: number
  kind: 'prerelease' | 'release'
  tag: string
  url: string
  sha: string
  actor: string
  at: string
}

export type WatchView = {
  id: number
  sha: string
  tag: string | null
  status: 'watching' | 'reverting' | 'green' | 'red' | 'silent'
  revertUrl: string | null
  detail: string | null
  startedAt: string
  endedAt: string | null
  /** A person said they dealt with a red main. */
  acknowledged: boolean
}

export type RunView = {
  id: number
  role: 'builder' | 'reviewer'
  harness: string
  attempt: number
  /** Empty for an agent that does not report a cost. */
  costUsd: number | null
  durationMs: number
  ok: boolean
  quota: boolean
  at: string
}

export type FindingView = {
  id: number
  kind: 'stalled' | 'orphaned'
  subject: 'run' | 'queued_run' | 'answer_resume' | 'snapshot' | 'revert'
  taskId: number | null
  taskTitle: string | null
  ref: string | null
  detail: string
  firstSeenAt: string
  lastSeenAt: string
}

export type CostGroup = {
  harness: string
  role: 'builder' | 'reviewer'
  runs: number
  /** How many of them reported a cost, since some agents report none. */
  reportedRuns: number
  costUsd: number
  avgDurationMs: number
  failed: number
  quota: number
}

export type HealthReport = {
  cost: {
    last24HoursUsd: number
    last7DaysUsd: number
    totalUsd: number
    /** Tasks that spent anything, and what one costs on average. */
    tasks: number
    avgPerTaskUsd: number
    groups: CostGroup[]
  }
  findings: FindingView[]
}

export type TaskCard = {
  id: number
  repository: string
  issueNumber: number
  title: string
  stage: Stage
  column: Column
  pullRequestUrl: string | null
  headSha: string | null
  costUsd: number
  /** How many times the checks ran, which is how many attempts the task has used. */
  attempts: number
  createdAt: string
  /** The last time anything happened to the task. */
  updatedAt: string
  /** Whether a person approved the commit the pull request is at. */
  approved: boolean
  /** The pull request was merged into the integration branch, so it is on the pre-release branch too. */
  integrated: boolean
  /** A failed task the factory will run again by itself once a limit or an outage has passed. */
  retryable: Retryable
  /** The factory's delivery of the commit the pull request is at, if it made one. */
  preRelease: { tag: string; url: string } | null
  release: { tag: string; url: string } | null
  /** The default branch went red after this task's release and nobody has dealt with it yet. */
  mainRed: boolean
}

export type TimelineEvent = {
  id: number
  stage: Stage
  at: string
  detail: Record<string, unknown> | null
}

export type EvidenceView = {
  id: number
  name: string
  command: string
  sha: string
  passed: boolean
  exitCode: number
  timedOut: boolean
  durationMs: number
  output: string
  at: string
}

export type ReviewView = {
  id: number
  round: number
  sha: string
  reviewer: string
  verdict: 'approve' | 'changes' | 'invalid'
  summary: string
  findings: { severity: string; file?: string; issue: string }[]
  at: string
}

export type QuestionView = {
  id: number
  body: string
  askedAt: string
  answer: string | null
  answeredBy: string | null
  answeredAt: string | null
}

export type DecisionView = {
  id: number
  kind: 'approve' | 'request_changes' | 'retry' | 'release' | 'would_release'
  sha: string | null
  note: string
  at: string
}

export type TaskDetail = {
  task: TaskCard
  timeline: TimelineEvent[]
  evidence: EvidenceView[]
  reviews: ReviewView[]
  questions: QuestionView[]
  decisions: DecisionView[]
  deliveries: DeliveryView[]
  watches: WatchView[]
  runs: RunView[]
}

/** What the inbox lists: a task that waits for a person, and why. */
export type InboxItem = {
  task: TaskCard
  kind: 'question' | 'review' | 'handoff' | 'failed' | 'main_red'
  /** One line that says what is wanted. */
  summary: string
  at: string
}

/** Sent over the event stream whenever a task enters a stage. */
export type StreamEvent = { type: 'stage'; taskId: number; stage: Stage; at: string }

export type RepositoryView = {
  fullName: string
  private: boolean
  defaultBranch: string
  /** False for a repository the owner enabled that the GitHub App no longer reaches. */
  reachable: boolean
  enabled: boolean
  checks: { name: string; command: string }[] | null
  egress: string[]
  /** The branch work starts from and pull requests target; null means the default branch. */
  baseBranch: string | null
  /** The branch a release lands on; null means the default branch. */
  releaseBranch: string | null
  /** False when the agent decides what is unclear instead of asking on the issue. */
  askQuestions: boolean
  harness: string | null
  reviewer: string | null
  releaseMode: 'manual' | 'trial' | 'auto' | null
}

export type RepositoriesView = {
  repositories: RepositoryView[]
  /** The agents the owner can pick for a repository. */
  agents: string[]
  /** Where GitHub lets the owner install the App on another account. */
  installUrl: string | null
  /** The accounts the App is installed on, each with the page where its repositories are chosen. */
  installations: { account: string; selection: 'all' | 'selected'; url: string }[]
  /** The account that owns the App. A private App can only be installed by it. */
  owner: string | null
  /** Set when GitHub could not be asked, so the list is only what is already saved. */
  error: string | null
}

export type PlanItemView = {
  id: number
  position: number
  title: string
  body: string
  selected: boolean
  issueNumber: number | null
  issueUrl: string | null
  started: boolean
}

export type PlanView = {
  id: number
  repository: string
  goal: string
  status: 'planning' | 'ready' | 'failed' | 'created'
  summary: string
  error: string | null
  costUsd: number
  milestoneNumber: number | null
  createdAt: string
  items: PlanItemView[]
}

export type SetupItem = {
  id: string
  label: string
  status: 'ok' | 'warn' | 'missing'
  detail: string
  /** Where to go to fix it, when the fix is a page on GitHub or here. */
  link?: { label: string; href: string }
}

export type SetupReport = { ready: boolean; items: SetupItem[] }

/** A conversation as the side menu lists it. */
export type ChatSummary = {
  id: string
  title: string
  pinned: boolean
  model: ChatModel
  updatedAt: string
}

/** Which agent answers: the OpenRouter one, or the one that uses the owner's ChatGPT (Codex) subscription. */
export type ChatModel = 'openrouter' | 'codex'

/** A message as the page renders it: an id, a role, and parts (text, tool calls, ...). */
export type ChatMessageView = {
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: Record<string, unknown>[]
}

export type ChatDetail = { chat: ChatSummary; messages: ChatMessageView[] }
