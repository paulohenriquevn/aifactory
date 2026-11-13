/** What the panel's API returns. The server builds these, the interface reads them. */

export type Stage =
  | 'intake'
  | 'sandbox'
  | 'plan'
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
  | 'cancelled'

/** Where a stage sits on the board. */
export type Column =
  'queued' | 'working' | 'waiting' | 'retrying' | 'review' | 'released' | 'resolved' | 'attention'

export const COLUMNS: { id: Column; title: string }[] = [
  { id: 'queued', title: 'Queued' },
  { id: 'working', title: 'Working' },
  { id: 'waiting', title: 'Waiting for you' },
  { id: 'retrying', title: 'Will retry itself' },
  { id: 'review', title: 'Delivered' },
  { id: 'released', title: 'Released' },
  { id: 'resolved', title: 'Already resolved' },
  { id: 'attention', title: 'Needs a person' },
]

/**
 * Why a failed task is not waiting for a person: the agent's usage limit, the environment (GitHub, the
 * network, the sandbox, a restart), or an issue it is blocked by that is still open. Each passes, and the
 * factory runs the task again once it has. A failure of the work itself is none of them, and stays with a
 * person.
 */
export type Retryable = 'quota' | 'environment' | 'blocked' | null

const ENVIRONMENT =
  /Internal Server Error|remote rejected|GitHub answered 5\d\d|\b50[234]\b|\b429\b|ECONN|ETIMEDOUT|ENOTFOUND|socket|fetch failed|out of memory|OOM|heap|is not running|killed \(most likely out of memory|was restarted|usage limit exceeded|Status code 402|timed out after \d+ ms|clone failed/i

/**
 * An agent that used all the time a run gives it. Nothing around it failed: a new run of the same issue on
 * the same code stops at the same place and spends the same quota, so it goes to a person, who splits the
 * issue or gives the agent more time. A command of the environment that timed out (a clone, an install) is
 * not this one.
 */
const AGENT_OUT_OF_TIME = /^the agent did not finish\b.*\btimed out\b/is

/** From the detail the factory recorded when a task failed. */
export function retryableFailure(detail: Record<string, unknown> | null | undefined): Retryable {
  if (!detail) return null
  if (detail.quota === true) return 'quota'
  if (Array.isArray(detail.blockedBy) && detail.blockedBy.length > 0) return 'blocked'
  if (typeof detail.error !== 'string' || AGENT_OUT_OF_TIME.test(detail.error)) return null
  return ENVIRONMENT.test(detail.error) ? 'environment' : null
}

/** What a done task left behind, which decides whether a release still has something to carry. */
export type DoneOutcome = { resolved?: boolean; integrated?: boolean }

/**
 * Delivered means waiting for a release. A done task resolved with no change (the code already did what
 * the issue asks, or a person resolved it another way) has nothing merged for a release to carry, so it
 * goes to its own column until its resolving commit is on the release branch, when it becomes `released`
 * (`factory/resolved-release.ts`).
 */
export function columnOf(
  stage: Stage,
  retryable: Retryable = null,
  { resolved = false, integrated = false }: DoneOutcome = {},
): Column {
  if (stage === 'failed' && retryable) return 'retrying'
  if (stage === 'done' && resolved && !integrated) return 'resolved'
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
    // Nothing enters it yet. Until something does and says where it belongs, a person sees it.
    case 'cancelled':
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

/**
 * Where an indicator's latest day stands: no baseline yet, inside its band, or the strongest tier of the
 * rules it broke (`log`, `show`, `act`).
 */
export type MetricBand = 'no_baseline' | 'in_band' | 'log' | 'show' | 'act'

/** The latest day of one indicator for one repository, or for all of them when `repository` is `*`. */
export type MetricRow = {
  metric: string
  label: string
  unit: 'share' | 'count' | 'minutes' | 'hours' | 'usd'
  worse: 'up' | 'down'
  repository: string
  day: string
  value: number
  samples: number
  /** The baseline, when there are enough days before the latest ones to make one. */
  mean: number | null
  sd: number | null
  band: MetricBand
  rules: string[]
}

/** A rule an indicator broke that the owner should see: shown on the panel, or filed as an issue. */
export type MetricSignalView = {
  metric: string
  label: string
  repository: string
  day: string
  rule: string
  tier: 'show' | 'act'
  value: number
  mean: number
  sd: number
  issueUrl: string | null
  error: string | null
}

export type MetricsReport = { rows: MetricRow[]; signals: MetricSignalView[] }

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
  /**
   * The pull request waits for the integration branch's required checks: GitHub merges it once they pass,
   * and the factory finishes the integration then. It is not a merge GitHub refused.
   */
  waitingForChecks: boolean
  /**
   * Delivered without a pull request: the agent changed nothing, the checks passed at the commit and the
   * reviewer confirmed the code already does what the issue asks. The factory closed the issue.
   */
  resolved: boolean
  /** A failed task the factory will run again by itself once a limit or an outage has passed. */
  retryable: Retryable
  /** When the factory runs it again on its own, set exactly when `retryable` is. */
  retryAt: string | null
  /** The factory's delivery of the commit the pull request is at, if it made one. */
  preRelease: { tag: string; url: string } | null
  release: { tag: string; url: string } | null
  /** The default branch went red after this task's release and nobody has dealt with it yet. */
  mainRed: boolean
  /**
   * A release of this task that waits for the release branch's required checks, or the last one that was
   * refused, while the task is not released. Null when none waited, or once one merged.
   */
  releaseWait: ReleaseWaitView | null
}

/** A release that waits for the release branch's required checks, or why it did not happen. */
export type ReleaseWaitView = {
  status: 'waiting' | 'refused'
  pullRequestUrl: string
  /** The checks the release branch required when the release was asked for. */
  checks: string[]
  /** Why a refused release did not happen. */
  reason: string | null
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

/** A plan the builder wrote before it changed anything; the latest one is what the reviewer measured by. */
export type ChangePlanView = {
  id: number
  baseSha: string
  harness: string
  files: { path: string; why: string }[]
  order: string[]
  risks: string[]
  proof: string[]
  outOfScope: string[]
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
  kind: 'approve' | 'request_changes' | 'retry' | 'release' | 'would_release' | 'resolve'
  sha: string | null
  note: string
  at: string
}

export type TaskDetail = {
  task: TaskCard
  timeline: TimelineEvent[]
  evidence: EvidenceView[]
  reviews: ReviewView[]
  /** Oldest first. */
  plans: ChangePlanView[]
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

/** One step of an agent at work: what it said, a tool it called, what came back. */
export type TranscriptEvent = {
  /** The order of the step within the task, across every run of its agents. */
  seq: number
  role: 'builder' | 'reviewer'
  attempt: number
  kind: 'message' | 'tool_use' | 'tool_result' | 'cost' | 'error'
  tool: string | null
  content: string
  at: string
}

/** A page of a task's transcript, oldest first. `more` says there are steps after the last one. */
export type TranscriptPage = { events: TranscriptEvent[]; more: boolean }

/** Sent over the event stream: a task entered a stage, or one of its agents took a step. */
export type StreamEvent =
  | { type: 'stage'; taskId: number; stage: Stage; at: string }
  | { type: 'agent'; taskId: number; event: TranscriptEvent }

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

/** A project's `.factory/setup.json` on its default branch, and which of its domains wait for the owner. */
export type RecipeView = {
  fullName: string
  recipe: {
    install?: string
    checks?: { name: string; command: string }[]
    egress: string[]
  } | null
  /** Domains the recipe asks for that the sandbox does not reach until the owner approves them. */
  pending: string[]
  approved: string[]
  /** Why the recipe cannot be used; a run fails with the same reason. */
  problem: string | null
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

/** One block of instructions an agent is given, as it is written in the code. */
export type AgentPrompt = {
  id: string
  title: string
  /** When the agent is given this one. */
  when: string
  text: string
  /** True when the text has ‹marks› where a task's own data goes. */
  template: boolean
}

export type AgentTool = {
  name: string
  /** What the model is told the tool is for. */
  description: string
  /**
   * What calling it does: only reads; changes something, and so waits for the owner's approval; or acts,
   * but only inside the sandbox, which is closed off from everything else.
   */
  effect: 'reads' | 'asks' | 'sandbox'
}

export type AgentEntry = {
  id: string
  group: 'factory' | 'panel'
  name: string
  /** One sentence on what it does. */
  role: string
  runsIn: 'sandbox' | 'server'
  /** The model or the coding agent behind it, as configured now, and how it is changed. */
  engine: { value: string; change: string }
  when: string
  tools: AgentTool[]
  prompts: AgentPrompt[]
  /** Ids of shared context that is added to every message it gets. */
  shared: string[]
  /** The files its instructions and tools are written in. */
  source: string[]
}

export type AgentsView = {
  agents: AgentEntry[]
  /** Text added to what every panel agent is given, kept in one file for all of them. */
  shared: AgentPrompt[]
  /** Which coding agent builds, plans and reviews, and what can be changed about it. */
  settings: AgentSettings
}

/** The three roles of a coding agent that the owner can give to one agent or another. */
export type AgentRole = 'builder' | 'planner' | 'reviewer'

export type EngineOption = {
  id: string
  /** False when the agent cannot start now, with what is missing. */
  ready: boolean
  problem?: string
}

export type AgentSettings = {
  /** Every coding agent the factory can run, and whether it could start now. */
  options: EngineOption[]
  /** What the owner chose; null where nothing was, so the environment or the default decides. */
  chosen: Record<AgentRole, string | null>
  /** What each role really uses now. */
  effective: Record<AgentRole, string>
  /** The model and the effort the owner chose for a role, when they belong to the agent it uses; null for the agent's own default. */
  chosenModel: Record<AgentRole, string | null>
  chosenEffort: Record<AgentRole, string | null>
  /** The models and effort levels each agent can be given. */
  engines: Record<string, EngineModels>
  /** Repositories that name an agent of their own, which wins over what is chosen here. */
  repositoriesWithOwn: { repository: string; builder: string | null; reviewer: string | null }[]
}

/** A model a coding agent can be told to use, and the effort levels it takes. */
export type ModelOption = {
  id: string
  label: string
  note: string
  efforts: string[]
}

export type EngineModels = {
  models: ModelOption[]
  /** The effort levels the agent takes when no model is chosen. */
  efforts: string[]
}

/** Where the change of Claude Code account is, as the panel shows it. The token itself is never part of it. */
export type ClaudeLoginState =
  | { status: 'idle' }
  | { status: 'waiting'; url: string; expiresAt: string }
  | { status: 'checking' }
  | { status: 'done' }
  | { status: 'error'; message: string }

/** Where the change of the factory's Codex account is, as the panel shows it. No token is ever part of it. */
export type CodexLoginState =
  | { status: 'idle' }
  | { status: 'waiting'; userCode: string; verificationUri: string }
  | { status: 'checking' }
  | { status: 'done' }
  | { status: 'error'; message: string }

/** The factory's Codex account: who it is, and where a change of account is. */
export type CodexConnection = {
  account:
    { connected: false; problem?: string } | { connected: true; email?: string; plan?: string }
  login: CodexLoginState
}
