import { z } from 'zod'

import type { Read } from '../factory/doctor'
import { declaredBlockers, nameOf, type IssueRef } from '../factory/blockers'
import { jsonObjects, renderFindings } from '../factory/review'

import { RELEASE_KINDS, type Decision, type RecordedAction } from './decide'
import { ciFailingOutput, type CiFailure, type TaskException } from './exceptions'
import { qualityConfigurationIn, roundsOfRun, type ReviewRound } from './scope'

/**
 * The unblocker without its side effects: when it runs, what it reads, how its answer is read and what is refused
 * in it. Everything here is pure; `unblock.ts` reads the facts and calls the model, and `unblocker-apply.ts`
 * carries out what it picked through the panel's actions.
 */

/** What an owner decides and nobody else: the only reasons the unblocker may leave a task with a person. */
export const OWNER_CATEGORIES = [
  'credentials',
  'repository_settings',
  'agent_configuration',
  'product_decision',
  'spending',
] as const

const text = z.string().trim().min(1)
const reason = text.max(2_000)

/**
 * What the unblocker answers: one action from a closed set, with why. A category and evidence are read as any
 * text, so an escalation without an owner category, or a resolution without evidence, is refused with the reason
 * rather than lost as an answer that did not parse.
 */
export const unblockerVerdictSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('answer'), text: text.max(4_000), reason }),
  z.object({ action: z.literal('send_back'), note: text.max(4_000), reason }),
  z.object({ action: z.literal('rerun_checks'), reason }),
  z.object({ action: z.literal('merge_base'), reason }),
  z.object({ action: z.literal('blocked_by'), issue: text, reason }),
  z.object({ action: z.literal('retry'), reason }),
  z.object({ action: z.literal('scope'), reason }),
  z.object({ action: z.literal('resolve_elsewhere'), evidence: z.string().optional(), reason }),
  z.object({ action: z.literal('escalate'), category: z.string().optional(), reason }),
])

export type UnblockerVerdict = z.infer<typeof unblockerVerdictSchema>
export type UnblockerAction = UnblockerVerdict['action']

export type ParsedVerdict = { ok: true; verdict: UnblockerVerdict } | { ok: false; error: string }

function parseCandidate(candidate: string): ParsedVerdict {
  let value: unknown
  try {
    value = JSON.parse(candidate)
  } catch (error) {
    return { ok: false, error: `the answer is not JSON: ${(error as Error).message}` }
  }
  const parsed = unblockerVerdictSchema.safeParse(value)
  if (parsed.success) return { ok: true, verdict: parsed.data }
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'action'}: ${i.message}`)
  return { ok: false, error: `the answer is not an action of the unblocker: ${issues.join('; ')}` }
}

/**
 * Reads the unblocker's answer: the last object in it that is an action. When none is, the error is the one of
 * its longest object, the one it most likely meant.
 */
export function parseUnblockerVerdict(answer: string): ParsedVerdict {
  const candidates = jsonObjects(answer)
  if (candidates.length === 0) return { ok: false, error: 'the answer holds no JSON object' }
  const parsed = candidates.map(parseCandidate)
  const verdict = [...parsed].reverse().find((p) => p.ok)
  if (verdict) return verdict
  const longest = candidates.reduce((a, b) => (b.length > a.length ? b : a))
  return parsed[candidates.indexOf(longest)]
}

/** How long a builder's question waits for a person before the unblocker reads it. */
export const QUESTION_WAIT_MS = 15 * 60_000

/** A question the builder asked that nobody answered, on a task waiting for it. */
export type OpenQuestion = {
  taskId: number
  questionId: number
  body: string
  askedAt: Date
}

const QUESTION_MAX = 1_500

/** The question as an exception, once it waited `QUESTION_WAIT_MS`; until then it is a person's to answer. */
export function recogniseQuestion(open: OpenQuestion, now: Date): TaskException | undefined {
  if (now.getTime() - open.askedAt.getTime() < QUESTION_WAIT_MS) return undefined
  return {
    kind: 'question',
    taskId: open.taskId,
    head: `question:${open.questionId}`,
    evidence: open.body.slice(0, QUESTION_MAX),
    questionId: open.questionId,
  }
}

/** The most actions the unblocker applies on one commit of a task; the next escalation stays with a person. */
export const UNBLOCKER_MAX_APPLIED = 3

/**
 * The most actions the unblocker applies on a task in all. Each send-back makes a new commit, so a limit per
 * commit alone would let a task that never converges run forever.
 */
export const UNBLOCKER_MAX_PER_TASK = 6

/** The commit a head names: a failure is told apart by its event (`<sha>@<event id>`), not by another commit. */
export const commitOf = (head: string): string => head.split('@')[0]

const short = (sha: string) => sha.slice(0, 7)

/**
 * Whether the unblocker looks at a decision: only at an escalation of a task's exception, never at a release or a
 * reordering of a repository. Past its limits it does not run, and the escalation says so.
 */
export function unblockerGate(
  exception: TaskException,
  decision: Decision,
  recorded: RecordedAction[],
): 'skip' | 'run' | Decision {
  if (decision.action !== 'escalate' || exception.trialOnly) return 'skip'
  if (RELEASE_KINDS.includes(exception.kind)) return 'skip'
  const applied = recorded.filter((r) => r.unblocker && r.outcome === 'applied')
  const commit = commitOf(exception.head)
  const onCommit = applied.filter((r) => commitOf(r.headSha) === commit)
  if (onCommit.length >= UNBLOCKER_MAX_APPLIED) {
    return {
      ...decision,
      reason: `${decision.reason}; the unblocker already applied ${onCommit.length} actions on ${short(commit)}: a person decides what comes next`,
    }
  }
  if (applied.length >= UNBLOCKER_MAX_PER_TASK) {
    return {
      ...decision,
      reason: `${decision.reason}; the unblocker already applied ${applied.length} actions on this task: a person decides what comes next`,
    }
  }
  return 'run'
}

/** An issue reference as the unblocker writes it, `owner/repo#123` or `#123`, or nothing. */
export function issueRefOf(ref: string, repository: string): IssueRef | undefined {
  const found = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/.exec(ref.trim())
  if (!found) return undefined
  return { repository: found[1] ?? repository, number: Number(found[2]) }
}

/**
 * The issue body with a `Blocked by` line for `ref` at its end, or nothing when the body already declares it: the
 * run reads that line before any sandbox exists and waits for the blocker (`openBlockersOf`).
 */
export function withBlocker(body: string, ref: IssueRef, repository: string): string | undefined {
  const declared = declaredBlockers(body, repository).map(nameOf)
  if (declared.includes(nameOf(ref))) return undefined
  return [body.trimEnd(), `Blocked by ${nameOf(ref)}`].filter((part) => part !== '').join('\n\n')
}

const FULL_SHA = /^[0-9a-f]{40}$/i

/**
 * Whether a resolution names what holds the work: the full sha of a commit, which the apply step then finds in the
 * integration branch. A run shows no change on that branch and a short sha can name more than one commit, so
 * neither is evidence.
 */
export const isEvidence = (evidence: string): boolean => FULL_SHA.test(evidence.trim())

/** Where the task the unblocker decides for is, which its references are read against. */
export type UnblockerTarget = { repository: string; issueNumber: number }

/** The texts of a verdict that reach the builder or GitHub, where no quality configuration may be named. */
const toldOf = (verdict: UnblockerVerdict): string => {
  if (verdict.action === 'answer') return verdict.text
  if (verdict.action === 'send_back') return verdict.note
  return ''
}

/** Why a verdict may not be applied, or nothing. */
export function refusalOf(
  exception: TaskException,
  verdict: UnblockerVerdict,
  target: UnblockerTarget,
): string | undefined {
  const asked = exception.kind === 'question'
  if (asked && verdict.action !== 'answer' && verdict.action !== 'escalate') {
    return 'the task waits for the answer to its question, so only an answer or an escalation moves it'
  }
  if (!asked && verdict.action === 'answer') return 'the task has no open question to answer'
  const named = qualityConfigurationIn(toldOf(verdict))
  if (named) return `it names ${named}, and no quality gate is loosened to make work pass`
  if (verdict.action === 'escalate' && !OWNER_CATEGORIES.some((c) => c === verdict.category)) {
    return `an escalation names one of ${OWNER_CATEGORIES.join(', ')}, and this one named ${verdict.category ?? 'none'}`
  }
  if (verdict.action === 'resolve_elsewhere' && !isEvidence(verdict.evidence ?? '')) {
    return `a resolution elsewhere names the full sha of the commit that holds the work, and this one named ${verdict.evidence || 'none'}`
  }
  if (verdict.action === 'blocked_by') return blockerRefusal(verdict.issue, target)
  return undefined
}

function blockerRefusal(issue: string, target: UnblockerTarget): string | undefined {
  const ref = issueRefOf(issue, target.repository)
  if (!ref) return `${issue} is not an issue reference (owner/repo#123 or #123)`
  if (ref.repository === target.repository && ref.number === target.issueNumber) {
    return 'an issue cannot be blocked by itself'
  }
  return undefined
}

/** What the record says the unblocker decided, as a person reads it. */
function reasonOf(verdict: UnblockerVerdict): string {
  if (verdict.action === 'escalate') {
    return `the unblocker escalated it to the owner as ${verdict.category ?? 'no category'}: ${verdict.reason}`
  }
  if (verdict.action === 'blocked_by') {
    return `the unblocker found it blocked by ${verdict.issue}: ${verdict.reason}`
  }
  if (verdict.action === 'resolve_elsewhere') {
    return `the unblocker found it resolved elsewhere (${verdict.evidence ?? 'no evidence'}): ${verdict.reason}`
  }
  return `the unblocker decided ${verdict.action.replace('_', ' ')}: ${verdict.reason}`
}

/** The note the run gets, or the record of why a run with no agent is queued. */
function noteOf(verdict: UnblockerVerdict): string | undefined {
  if (verdict.action === 'answer') return verdict.text
  if (verdict.action === 'send_back') return verdict.note
  if (verdict.action === 'merge_base') {
    return `The coordinator's unblocker merges the integration branch into this branch: ${verdict.reason} No agent runs; the checks and the review read the merge.`
  }
  if (verdict.action === 'resolve_elsewhere') {
    return `The coordinator's unblocker resolved this elsewhere, as ${verdict.evidence} shows: ${verdict.reason}`
  }
  return undefined
}

/** How much of an answer that did not parse is kept for a person. */
const ANSWER_MAX = 4_000

/**
 * The decision the unblocker's answer makes of an escalation. An answer that does not parse leaves the escalation
 * with the parse error and the answer kept; a verdict that may not be applied is recorded as refused with why.
 */
export function unblockerDecision(
  exception: TaskException,
  escalation: Decision,
  answer: { response: string; cost: number },
  target: UnblockerTarget,
): Decision {
  const parsed = parseUnblockerVerdict(answer.response)
  if (!parsed.ok) {
    return {
      action: 'escalate',
      reason: `${escalation.reason}; the unblocker's answer could not be used: ${parsed.error}`,
      answer: answer.response.slice(0, ANSWER_MAX),
      costUsd: answer.cost,
    }
  }
  const { verdict } = parsed
  const note = noteOf(verdict)
  const refusal = refusalOf(exception, verdict, target)
  return {
    action: verdict.action,
    reason: reasonOf(verdict),
    unblocker: verdict,
    costUsd: answer.cost,
    ...(note === undefined ? {} : { note }),
    ...(refusal === undefined ? {} : { refusal }),
  }
}

/** A comment on the issue, as the unblocker reads it. */
export type ReadComment = { author: string; association: string; body: string; at: Date }

/** One event of the task's history, reduced to what it says. */
export type HistoryEvent = { stage: string; at: Date; said: string }

/** The pull request of the task as GitHub reports it. */
export type PullView = { url: string; state: string; mergeableState: string; headSha: string }

/** What the coordinator already decided on the task, oldest first. */
export type PastAction = Pick<RecordedAction, 'exceptionKind' | 'action' | 'outcome'> & {
  reason: string
}

/** Everything the unblocker reads, each read bounded when the message is written. */
export type UnblockerFacts = {
  exception: TaskException
  /** Why the coordinator would escalate. */
  escalation: string
  repository: string
  issueNumber: number
  stage: string
  title: string
  body: Read<string>
  comments: Read<ReadComment[]>
  history: Read<HistoryEvent[]>
  reviews: Read<ReviewRound[]>
  pullRequest: Read<PullView | null>
  ciFailures: Read<CiFailure[]> | undefined
  past: Read<PastAction[]>
}

const BODY_MAX = 10_000
const COMMENT_MAX = 1_200
const COMMENTS_KEPT = 12
const EVENT_MAX = 400
const EVENTS_KEPT = 20
const REVIEWS_KEPT = 3
const REVIEW_MAX = 2_500
const REASON_MAX = 2_000
const PAST_KEPT = 10

/** A fact that could not be read is said as such: the unblocker decides on what it has. */
const shown = <T>(fact: Read<T>, render: (value: T) => string): string =>
  fact.read ? render(fact.value) : `(could not read ${fact.tried}: ${fact.error})`

/** Text that came from outside, kept inside its marker: a closing marker inside it is broken. */
const data = (value: string, max: number) => value.slice(0, max).replace(/<\//g, '< /')

const renderComments = (comments: ReadComment[]) =>
  comments.length === 0
    ? '(no comments)'
    : comments
        .slice(-COMMENTS_KEPT)
        .map(
          (c) =>
            `${c.author} (${c.association}, ${c.at.toISOString()}):\n${data(c.body, COMMENT_MAX)}`,
        )
        .join('\n\n')

const renderHistory = (events: HistoryEvent[]) =>
  events
    .slice(-EVENTS_KEPT)
    .map((e) => `${e.at.toISOString()} ${e.stage}${e.said ? `: ${data(e.said, EVENT_MAX)}` : ''}`)
    .join('\n') || '(no events)'

const renderReviews = (reviews: ReviewRound[]) =>
  roundsOfRun(reviews, REVIEWS_KEPT)
    .reviews.map((r) =>
      data(
        `Round ${r.round} on ${short(r.sha)} (${r.verdict}): ${r.summary}\n${renderFindings(r.findings)}`,
        REVIEW_MAX,
      ),
    )
    .join('\n\n') || '(no reviews)'

const renderPull = (pull: PullView | null) =>
  pull
    ? `${pull.url}: ${pull.state}, mergeable state ${pull.mergeableState}, head ${short(pull.headSha)}`
    : '(the task has no pull request)'

const renderCi = (failures: CiFailure[]) =>
  failures.length === 0
    ? '(no failed check on GitHub)'
    : [failures.map((f) => f.name).join(', '), data(ciFailingOutput(failures), 4_000)].join('\n\n')

const renderPast = (past: PastAction[]) =>
  past
    .slice(-PAST_KEPT)
    .map((p) => `- ${p.action} for ${p.exceptionKind} (${p.outcome}): ${data(p.reason, 400)}`)
    .join('\n') || '(nothing yet)'

/** The longest message the unblocker takes (`UNBLOCKER_SPEC`); the bounds above keep a message under it. */
export const MESSAGE_MAX = 60_000

/** The message the unblocker gets. Whatever came from outside sits inside markers, as data. */
export function unblockerMessage(facts: UnblockerFacts): string {
  const { exception } = facts
  const parts = [
    `Task of ${facts.repository}#${facts.issueNumber}, in ${facts.stage}: ${data(facts.title, 300)}`,
    `The coordinator stopped on a ${exception.kind} at ${exception.head}.`,
    '',
    `<coordinator-reason>\n${data(facts.escalation, REASON_MAX)}\n</coordinator-reason>`,
    '',
    `<issue-body>\n${shown(facts.body, (b) => data(b, BODY_MAX))}\n</issue-body>`,
    '',
    `<comments>\n${shown(facts.comments, renderComments)}\n</comments>`,
    '',
    `<history>\n${shown(facts.history, renderHistory)}\n</history>`,
    '',
    `<reviews>\n${shown(facts.reviews, renderReviews)}\n</reviews>`,
    '',
    `<pull-request>\n${shown(facts.pullRequest, renderPull)}\n</pull-request>`,
  ]
  if (facts.ciFailures) {
    parts.push('', `<ci-logs>\n${shown(facts.ciFailures, renderCi)}\n</ci-logs>`)
  }
  if (exception.kind === 'question') {
    parts.push('', `<question>\n${data(exception.evidence, QUESTION_MAX)}\n</question>`)
  }
  parts.push('', `What the coordinator already did on this task:\n${shown(facts.past, renderPast)}`)
  return parts.join('\n').slice(0, MESSAGE_MAX)
}
