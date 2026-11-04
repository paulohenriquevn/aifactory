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
export type Column = 'queued' | 'working' | 'waiting' | 'review' | 'released' | 'attention'

export const COLUMNS: { id: Column; title: string }[] = [
  { id: 'queued', title: 'Queued' },
  { id: 'working', title: 'Working' },
  { id: 'waiting', title: 'Waiting for you' },
  { id: 'review', title: 'Pull request' },
  { id: 'released', title: 'Released' },
  { id: 'attention', title: 'Needs a person' },
]

export function columnOf(stage: Stage): Column {
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
