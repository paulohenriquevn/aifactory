import { TASK_STAGES, type TaskStage } from '../db/schema'
import type { RoutedCode } from '../ingest/decide'

/**
 * What happens to a task for every stage it can be in and every event that can reach it, in one place.
 * The panel's actions and the crons ask here whether something is allowed; nothing here reads or writes
 * anything. A new stage or a new event does not compile until every pair it adds has an outcome.
 */

/** What a person asks for in the panel. `retry_from_finding` is a retry from a supervisor finding. */
type PanelEvent =
  'approve' | 'request_changes' | 'retry' | 'retry_from_finding' | 'resolve' | 'release'

/**
 * What the factory does with no person asking. `retry_due` is a failure whose time to run again came
 * (`retryAt`), `conflict_rerun` a pull request that conflicts with its base, `integrate` approved work
 * reaching its pull request.
 */
type AutomaticEvent =
  'retry_due' | 'conflict_rerun' | 'send_back_after_ci' | 'hand_over' | 'integrate'

/** A delivery from GitHub: the label that hands an issue over, and every intent the event router gives. */
type WebhookEvent = 'issue_labeled' | RoutedCode

export type TransitionEvent = PanelEvent | AutomaticEvent | WebhookEvent

export type Action =
  | 'approve'
  /** A new run on the branch the agent pushed, with a note as feedback. */
  | 'continue_on_branch'
  /** A new run from the integration branch that still carries the note, as a first run does. */
  | 'start_from_integration_branch'
  /** The task's branch is deleted and it runs again from the beginning. */
  | 'start_over'
  | 'resolve'
  | 'release'
  | 'hand_over'
  | 'mark_ready_for_review'
  | 'merge'
  /** GitHub merges the verified commit once the required checks pass. */
  | 'auto_merge'
  | 'read_answer'
  | 'open_follow_up_issue'
  | 're_evaluate_integration'
  | 'cancel'

export type Outcome =
  | { kind: 'action'; action: Action }
  /** Nothing is done and nobody is told: the event does not concern a task in this state. */
  | { kind: 'ignored'; reason: string }
  /** Somebody asked and is told no, with the reason as it is shown. */
  | { kind: 'refused'; reason: string }

/**
 * What is known of the task when the event arrives. A task row is one of these. A fact that is not given
 * counts as absent: no commit, not a draft, not trusted.
 */
export type Facts = {
  stage: TaskStage
  headSha?: string | null
  mergedSha?: string | null
  resolvedSha?: string | null
  awaitingCiSha?: string | null
  /** GitHub no longer has the task's branch: it never pushed one, or a retry deleted it. */
  branchGone?: boolean
  /** The pull request is a draft, as a handoff leaves it. */
  draft?: boolean
  /** The integration branch requires status checks. */
  checksRequired?: boolean
  /** Those checks already passed on the commit: GitHub calls the pull request clean. */
  checksPassed?: boolean
  /** Whoever wrote the comment or the review is someone the repository trusts. */
  trusted?: boolean
}

type Rule = Outcome | ((task: Facts) => Outcome)

const act = (action: Action): Outcome => ({ kind: 'action', action })
const ignore = (reason: string): Outcome => ({ kind: 'ignored', reason })
const refuse = (reason: string): Outcome => ({ kind: 'refused', reason })

const each = <S extends TaskStage>(stages: readonly S[], rule: Rule) =>
  Object.fromEntries(stages.map((stage) => [stage, rule])) as Record<S, Rule>

/** The stages in which a run is alive. */
const WORKING = ['sandbox', 'plan', 'build', 'push', 'verify', 'review', 'pr'] as const
/** The stages the supervisor looks at for a run that stalled or was lost. `plan` is not one of them. */
const SUPERVISED = ['intake', 'sandbox', 'build', 'push', 'verify', 'review', 'pr'] as const

const START_OVER = act('start_over')

/** A done task that delivered nothing: its pull request was never merged, and it was not resolved without one. */
const whenNeverMerged =
  (otherwise: Outcome): Rule =>
  (task) =>
    !task.mergedSha && !task.resolvedSha ? START_OVER : otherwise

const NOT_APPROVED = refuse('only a task with a pull request can be approved')
const approve: Rule = (task) => (task.headSha ? act('approve') : NOT_APPROVED)

const NOT_SENT_BACK = refuse('only a task with a pull request can be sent back')
const ALREADY_INTEGRATED = refuse(
  'this work is already integrated, so there is no pull request to send back: open a new job for what should change',
)
/**
 * The run continues on the task's branch only while GitHub has it. Without it the run would fail on the
 * fetch before any agent read the note (paulohenriquevn/aifactory#54).
 */
const onBranch = (task: Facts) =>
  act(task.branchGone ? 'start_from_integration_branch' : 'continue_on_branch')
const sendBack: Rule = (task) => (task.mergedSha ? ALREADY_INTEGRATED : onBranch(task))

const NOT_RETRIED = refuse(
  'only a failed or handed-over task, or one whose pull request was never merged, can be retried',
)
const NOT_RESOLVED = refuse('only a failed or handed-over task can be resolved another way')

const NOT_RELEASABLE = refuse('only a finished task with a pull request can be released')
const NOT_INTEGRATED = refuse(
  'this work was not integrated: its pull request is still waiting to be merged into the integration branch, so it is not on the pre-release branch',
)
const release: Rule = (task) => {
  if (!task.headSha) return NOT_RELEASABLE
  return task.mergedSha ? act('release') : NOT_INTEGRATED
}

const NOT_RUN_AGAIN = refuse(
  'only a failed task, or one whose pull request was never merged, runs again on its own',
)
const NOT_AWAITING_CHECKS = refuse(
  'only work that waits for the repository checks is sent back on its own',
)

const NOBODY_WORKING = ignore(
  'no run is working on this task and nothing of it waits for the repository checks',
)
const NOT_AT_ITS_PULL_REQUEST = ignore('only a run that reached its pull request integrates it')
/**
 * GitHub merges no draft, so the draft a handoff left is marked ready first (paulohenriquevn/aifactory#56).
 * Required checks that already passed leave nothing for auto-merge to wait for, and GitHub refuses it: the
 * pull request is merged at once, like one with no required checks (paulohenriquevn/aifactory#51).
 */
const integrate: Rule = (task) => {
  if (task.draft) return act('mark_ready_for_review')
  return act(task.checksRequired && !task.checksPassed ? 'auto_merge' : 'merge')
}

const NO_QUESTION = ignore('the task asked no question that a comment could answer')
const NO_OPEN_PULL_REQUEST = ignore('the task has no pull request waiting for a person')
const UNTRUSTED = ignore('it was not written by someone the repository trusts')
const fromTrusted =
  (decide: (task: Facts) => Outcome): Rule =>
  (task) =>
    task.trusted ? decide(task) : UNTRUSTED
/** An open pull request gets the work sent back, as a person does in the panel; integrated work has none. */
const written = fromTrusted((task) =>
  task.mergedSha ? act('open_follow_up_issue') : onBranch(task),
)
/** Somebody wrote on the factory's pull request: a comment, a review, a comment on the diff. */
const WRITTEN_ON_PULL_REQUEST = {
  ...each(['intake', ...WORKING, 'waiting', 'failed', 'cancelled'], NO_OPEN_PULL_REQUEST),
  done: written,
  handoff: written,
  released: fromTrusted(() => act('open_follow_up_issue')),
}

const NOT_AWAITING_CI = ignore('no pull request of this task waits for the repository checks')
const CHECK_COMPLETED = {
  ...each(
    ['intake', ...WORKING, 'waiting', 'released', 'handoff', 'failed', 'cancelled'],
    NOT_AWAITING_CI,
  ),
  done: (task: Facts) => (task.awaitingCiSha ? act('re_evaluate_integration') : NOT_AWAITING_CI),
}

const RUN_ENDED = ignore('its run already ended, and what it left is with a person')
/** The issue no longer asks for the work: it lost the factory label, or it was closed. */
const ISSUE_WITHDRAWN = {
  // A failed task is cancelled too, or it would run again on its own.
  ...each(['intake', ...WORKING, 'waiting', 'failed'], act('cancel')),
  done: RUN_ENDED,
  handoff: RUN_ENDED,
  released: ignore('the work was already released'),
  cancelled: ignore('the task is already cancelled'),
}

const TRANSITIONS: Record<TransitionEvent, Record<TaskStage, Rule>> = {
  approve: {
    ...each(['intake', ...WORKING, 'waiting', 'released', 'failed', 'cancelled'], NOT_APPROVED),
    done: approve,
    handoff: approve,
  },
  request_changes: {
    ...each(['intake', ...WORKING, 'waiting', 'released', 'failed', 'cancelled'], NOT_SENT_BACK),
    done: sendBack,
    handoff: sendBack,
  },
  retry: {
    ...each(['intake', ...WORKING, 'waiting', 'released', 'cancelled'], NOT_RETRIED),
    done: whenNeverMerged(NOT_RETRIED),
    handoff: START_OVER,
    failed: START_OVER,
  },
  retry_from_finding: {
    ...each(SUPERVISED, START_OVER),
    ...each(['plan', 'waiting', 'released', 'cancelled'], NOT_RETRIED),
    done: whenNeverMerged(NOT_RETRIED),
    handoff: START_OVER,
    failed: START_OVER,
  },
  resolve: {
    ...each(['intake', ...WORKING, 'waiting', 'done', 'released', 'cancelled'], NOT_RESOLVED),
    handoff: act('resolve'),
    failed: act('resolve'),
  },
  release: {
    ...each(['intake', ...WORKING, 'waiting', 'handoff', 'failed', 'cancelled'], NOT_RELEASABLE),
    done: release,
    released: refuse('this task was already released'),
  },

  retry_due: {
    ...each(
      ['intake', ...WORKING, 'waiting', 'done', 'released', 'handoff', 'cancelled'],
      NOT_RUN_AGAIN,
    ),
    failed: START_OVER,
  },
  conflict_rerun: {
    ...each(
      ['intake', ...WORKING, 'waiting', 'released', 'handoff', 'failed', 'cancelled'],
      NOT_RUN_AGAIN,
    ),
    done: whenNeverMerged(NOT_RUN_AGAIN),
  },
  send_back_after_ci: {
    ...each(
      ['intake', ...WORKING, 'waiting', 'released', 'handoff', 'failed', 'cancelled'],
      NOT_AWAITING_CHECKS,
    ),
    done: (task) => (task.awaitingCiSha ? act('continue_on_branch') : NOT_AWAITING_CHECKS),
  },
  hand_over: {
    ...each(WORKING, act('hand_over')),
    ...each(['intake', 'waiting', 'released', 'handoff', 'failed', 'cancelled'], NOBODY_WORKING),
    done: (task) => (task.awaitingCiSha ? act('hand_over') : NOBODY_WORKING),
  },
  integrate: {
    ...each(
      ['intake', 'sandbox', 'plan', 'build', 'push', 'verify', 'review'],
      NOT_AT_ITS_PULL_REQUEST,
    ),
    pr: integrate,
    ...each(
      ['waiting', 'done', 'released', 'handoff', 'failed', 'cancelled'],
      NOT_AT_ITS_PULL_REQUEST,
    ),
  },

  issue_labeled: {
    ...each(
      ['intake', ...WORKING, 'waiting', 'done', 'released'],
      ignore('the issue already has a task that is running or delivered'),
    ),
    handoff: START_OVER,
    failed: START_OVER,
    cancelled: START_OVER,
  },
  issue_comment_created: {
    ...each(
      ['intake', ...WORKING, 'done', 'released', 'handoff', 'failed', 'cancelled'],
      NO_QUESTION,
    ),
    // Whose comment counts as the answer is for what reads it to say (`pickAnswer`).
    waiting: act('read_answer'),
  },
  pull_request_comment_created: WRITTEN_ON_PULL_REQUEST,
  pull_request_review_submitted: WRITTEN_ON_PULL_REQUEST,
  pull_request_review_comment_created: WRITTEN_ON_PULL_REQUEST,
  check_suite_completed: CHECK_COMPLETED,
  check_run_completed: CHECK_COMPLETED,
  issue_unlabeled: ISSUE_WITHDRAWN,
  issue_closed: ISSUE_WITHDRAWN,
  issue_reopened: each(
    TASK_STAGES,
    ignore('reopening an issue asks for nothing: the factory label does'),
  ),
}

export const EVENTS = Object.keys(TRANSITIONS) as TransitionEvent[]

/**
 * The events whose outcome is declared here and read by nothing yet. The webhook intents are only recorded
 * (`ingest/decide.ts`), and a later step will act on them as this says. A run hands its own work over and
 * integrates it where it is (`Run`, `autoMergeOrMergeable`, `integrate-after-ci`); the table states what
 * those do, and they do not ask it.
 */
export const NOT_WIRED: readonly TransitionEvent[] = [
  'hand_over',
  'integrate',
  'issue_labeled',
  'issue_comment_created',
  'pull_request_comment_created',
  'pull_request_review_submitted',
  'pull_request_review_comment_created',
  'check_suite_completed',
  'check_run_completed',
  'issue_unlabeled',
  'issue_closed',
  'issue_reopened',
]

/** What `event` does to a task in this state. */
export function outcome(task: Facts, event: TransitionEvent): Outcome {
  const rule = TRANSITIONS[event][task.stage]
  if (!rule) throw new Error(`no outcome is declared for ${event} on a task in ${task.stage}`)
  return typeof rule === 'function' ? rule(task) : rule
}

/** Every stage in which `event` leads to an action for a task with these facts. */
export function stagesWhere(event: TransitionEvent, task: Omit<Facts, 'stage'>): TaskStage[] {
  return TASK_STAGES.filter((stage) => outcome({ ...task, stage }, event).kind === 'action')
}

/**
 * How many times in a row the factory runs a task again on its own: after an environment failure, a
 * conflict with the base, a required check that failed. Past that it is not passing by itself, and the
 * task goes to a person.
 */
export const AUTOMATIC_RETRIES = 3

/** Whether a task that ran `automaticRuns` times since a person last started it may run on its own again. */
export const automaticRunsLeft = (automaticRuns: number): boolean =>
  automaticRuns < AUTOMATIC_RETRIES
