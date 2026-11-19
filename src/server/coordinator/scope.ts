import { z } from 'zod'

import { blockingCount, jsonObjects, renderFindings, type Finding } from '../factory/review'

/**
 * The `scope` action without its side effects: what the drafter is given, how its answer is read, what is
 * refused in it, and the text written to GitHub. Everything here is pure; `draft.ts` calls the model and
 * `apply.ts` writes.
 */

const text = z.string().trim().min(1)

/** What the drafter answers: the requests that belong to the issue, the rest, a follow-up and the note. */
export const scopeDraftSchema = z.object({
  inScope: z.array(text),
  outOfScope: z.array(text),
  followUp: z.object({ title: text, body: text }).nullable(),
  note: text,
})

export type ScopeDraft = z.infer<typeof scopeDraftSchema>

export type ParsedDraft = { ok: true; draft: ScopeDraft } | { ok: false; error: string }

/**
 * Reads the drafter's answer as a draft: the last object in it that is one. When none is, the error is the
 * one of its longest object, the one the drafter most likely meant.
 */
export function parseScopeDraft(answer: string): ParsedDraft {
  const candidates = jsonObjects(answer)
  if (candidates.length === 0) return { ok: false, error: 'the answer holds no JSON object' }
  const parsed = candidates.map(parseCandidate)
  const draft = [...parsed].reverse().find((p) => p.ok)
  if (draft) return draft
  const longest = candidates.reduce((a, b) => (b.length > a.length ? b : a))
  return parsed[candidates.indexOf(longest)]
}

function parseCandidate(candidate: string): ParsedDraft {
  let value: unknown
  try {
    value = JSON.parse(candidate)
  } catch (error) {
    return { ok: false, error: `the answer is not JSON: ${(error as Error).message}` }
  }
  const parsed = scopeDraftSchema.safeParse(value)
  if (parsed.success) return { ok: true, draft: parsed.data }
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
  return { ok: false, error: `the answer is not a scope draft: ${issues.join('; ')}` }
}

/**
 * Names of the quality configuration a scope decision may never ask the builder to touch. A draft whose
 * note or in-scope requests name one is refused: no gate is loosened to make a review converge.
 */
export const QUALITY_CONFIGURATION = [
  'quality/',
  'stryker',
  '.jscpd',
  'crap-baseline',
  'coverage threshold',
] as const

/** The first quality configuration a text names, or nothing. */
export function qualityConfigurationIn(text: string): string | undefined {
  const told = text.toLowerCase()
  return QUALITY_CONFIGURATION.find((name) => told.includes(name))
}

/** The first quality configuration the builder would be told to touch, or nothing. */
export function qualityConfigurationNamed(draft: ScopeDraft): string | undefined {
  return qualityConfigurationIn([draft.note, ...draft.inScope].join('\n'))
}

const list = (items: string[]) =>
  (items.length > 0 ? items : ['nothing']).map((item) => `- ${item}`).join('\n')

/** The section appended to the issue body, naming the follow-up when one was filed. */
export function scopeSection(draft: ScopeDraft, date: string, followUp: number | undefined) {
  return [
    `## Scope decision (${date})`,
    '',
    'The review of this issue did not converge, so the coordinator decided which requests belong to it.',
    '',
    'In scope:',
    '',
    list(draft.inScope),
    '',
    followUp === undefined ? 'Out of scope:' : `Out of scope, filed as #${followUp}:`,
    '',
    list(draft.outOfScope),
  ].join('\n')
}

/** The follow-up issue the draft files, its body ending with a line linking the original issue. */
export function followUpIssue(draft: ScopeDraft, repo: string, issueNumber: number) {
  if (!draft.followUp) return undefined
  return {
    title: draft.followUp.title,
    body: `${draft.followUp.body}\n\nFollow-up of ${repo}#${issueNumber}.`,
  }
}

/** One review round of the task, as the `review` table holds it. */
export type ReviewRound = {
  round: number
  sha: string
  verdict: 'approve' | 'changes' | 'invalid'
  summary: string
  findings: Finding[]
}

/**
 * The rounds of the run that handed over: its last review for each attempt, oldest first, with the
 * blocking findings of each, which is what `roundsNote` counts.
 */
export function roundsOfRun(reviews: ReviewRound[], attempts: number) {
  const ofRun = attempts > 0 ? reviews.slice(-attempts) : []
  return { reviews: ofRun, counts: ofRun.map((r) => blockingCount(r.findings)) }
}

/** What the drafter reads: the issue, the plan, every round of the review and what the last one asked. */
export type ScopeInput = {
  repo: string
  issueNumber: number
  title: string
  body: string
  /** The task's plan as markdown, when it has one. */
  plan: string | undefined
  reviews: ReviewRound[]
  /** What the reviewer still asked for when the run handed over. */
  findings: Finding[]
  roundsNote: string
}

const BODY_MAX = 12_000
const PLAN_MAX = 6_000
const ROUND_MAX = 2_500

const round = (r: ReviewRound) =>
  `Round ${r.round} on ${r.sha.slice(0, 7)} (${r.verdict}): ${r.summary}\n${renderFindings(r.findings)}`.slice(
    0,
    ROUND_MAX,
  )

/** The message the drafter gets. The issue and the plan sit inside markers, as data. */
export function scopeMessage(input: ScopeInput): string {
  return [
    `Issue ${input.repo}#${input.issueNumber}: ${input.title}`,
    '',
    `<issue-body>\n${input.body.slice(0, BODY_MAX)}\n</issue-body>`,
    '',
    `<plan>\n${(input.plan ?? 'The task has no stored plan.').slice(0, PLAN_MAX)}\n</plan>`,
    '',
    `<review-rounds>\n${input.reviews.map(round).join('\n\n')}\n</review-rounds>`,
    '',
    `<last-findings>\n${renderFindings(input.findings).slice(0, ROUND_MAX)}\n</last-findings>`,
    '',
    `Rounds: ${input.roundsNote.trim() || 'no count of the rounds was kept'}`,
  ].join('\n')
}
