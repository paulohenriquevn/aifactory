import { knowledgeRules } from '../knowledge/prompt'
import type { CheckSpec } from './evidence'
import { checksRule } from './harness'
import type { RequiredByCheck } from './required-files'

export type Severity = 'blocker' | 'major' | 'minor'

export type Finding = { severity: Severity; file?: string; issue: string }

export type ReviewVerdict = {
  verdict: 'approve' | 'changes' | 'invalid'
  summary: string
  findings: Finding[]
}

/** The reviews a task gets before it goes to a person, counting the first one. */
export const MAX_ATTEMPTS = 3

/** The reviews a task gets while its blocking findings keep going down from one round to the next. */
export const MAX_CONVERGING_ATTEMPTS = 6

/** The finding the factory adds itself for a file the plan does not cover. */
export const OUTSIDE_THE_PLAN = 'changed outside the plan'

/** Findings that block: major and above, without the entries the factory adds for files outside the plan. */
export function blockingCount(findings: Finding[]): number {
  return findings.filter((f) => f.severity !== 'minor' && f.issue !== OUTSIDE_THE_PLAN).length
}

/** Did the blocking findings go down from the round before? */
export function converging(counts: number[]): boolean {
  const [before, last] = counts.slice(-2)
  return before !== undefined && last !== undefined && last < before
}

/**
 * May a review that asked for changes at `attempt` send the work back for another round? The first
 * `MAX_ATTEMPTS` always may; after that only while the blocking findings fell in the last round, up to
 * `MAX_CONVERGING_ATTEMPTS`. `counts` has the blocking findings of each review round so far.
 */
export function reviewAllowsRework(attempt: number, counts: number[]): boolean {
  if (attempt < MAX_ATTEMPTS) return true
  return attempt < MAX_CONVERGING_ATTEMPTS && converging(counts)
}

/** What a handoff says about the rounds, once the first limit is passed; empty before that. */
export function roundsNote(attempt: number, counts: number[]): string {
  if (attempt < MAX_ATTEMPTS || counts.length === 0) return ''
  const per = `blocking findings per round: ${counts.join(', ')}`
  return converging(counts)
    ? ` (still converging, but this is the limit; ${per})`
    : ` (the review is not converging; ${per})`
}

export function reviewPrompt(input: {
  repo: string
  issueNumber: number
  title: string
  body: string
  branch: string
  baseSha: string
  /** Where the knowledge base is in the sandbox, when the factory delivered one. */
  knowledgeDir?: string
  /** The plan the builder wrote before it changed anything, as markdown. */
  plan?: string
  /** The changed files the plan does not cover, found without a model. */
  unplanned?: string[]
  /** What the builder said when it finished, where it gives its reasons. */
  builderSummary?: string
  /** The factory checks that failed on an earlier attempt and pass now, with the files added since. */
  required?: RequiredByCheck[]
  /** The review this one follows in the same run, when it asked for changes. */
  earlier?: EarlierReview
}): string {
  const required = input.required ?? []
  return `You are an independent code reviewer for the repository ${input.repo}. Another agent implemented the issue below on the branch ${input.branch}. You did not write this code and you must not change it.

# ${input.title} (#${input.issueNumber})

${input.body || '(the issue has no description)'}
${input.plan === undefined ? saidSection(input.builderSummary) : planSection(input.plan, input.unplanned ?? [], input.builderSummary, required)}${requiredSection(required)}
Review the work:
- Read the change with \`git diff ${input.baseSha}...HEAD\` and the files it touches.
- Decide whether it does what the issue asks, no more and no less.
- Check that the tests test the behavior: not weakened, skipped, deleted or made to pass by changing the test command.
- Look for bugs, missed edge cases, unrelated changes, secrets, and anything under .github/.
- When you find a defect, name its class and the invariant a fix must hold (for example: every path operation is relative to a directory opened once), and list every instance of that class in the change, in this round, each with its file and line. Make that one finding, so the builder fixes the class at once instead of one instance per round.
- You may run the project's tests. Do not edit, create or delete files, and do not run any git command that writes.
${
  input.knowledgeDir
    ? `- A change that breaks one of the owner's rules under ${input.knowledgeDir}/knowledge/ is a finding, at least major.\n\n${knowledgeRules(input.knowledgeDir)}\n`
    : ''
}${input.earlier ? earlierSection(input.earlier, input.baseSha) : ''}
Finish with one JSON object on its own, and nothing after it:

{"verdict":"approve"|"changes","summary":"one or two sentences","findings":[{"severity":"blocker"|"major"|"minor","file":"path or omit","issue":"what is wrong and what to do"}]}

Use "changes" when there is any blocker or major finding. Use "approve" only when you would merge it as it is; minor findings may stay in an approval.
`
}

/** A review round that asked for changes: the commit it read and what it found. */
export type EarlierReview = { sha: string; findings: Finding[] }

/**
 * The command that shows what the task itself changed since the reviewed commit `earlier`: its own commits, with
 * no merge commit and nothing reachable from `base`, the merge base of HEAD and the integration branch
 * (`reviewBase`). A plain \`git diff earlier HEAD\` also holds every commit a merge of the integration branch
 * brought in, which a later round then blames on the task.
 */
export function changedSinceCommand(earlier: string, base: string): string {
  return `git log -p --no-merges ${earlier}..HEAD ^${base}`
}

/**
 * What a later round is told about the one before it. A review that reads the whole diff again every round
 * finds something new every round and never ends (the `review_plateau` handoffs), so a later round checks
 * the earlier findings first, judges the reason the builder gave for one it declined, and raises a new blocker
 * only in code the task changed since, on another instance of a class it already named, or on unchanged code the
 * change breaks. Minor findings
 * never blocked, so they are not carried.
 */
function earlierSection(earlier: EarlierReview, base: string): string {
  const blocking = earlier.findings.filter((f) => f.severity !== 'minor')
  const listed = blocking.length > 0 ? renderFindings(blocking) : '(none that blocked)'
  const short = earlier.sha.slice(0, 7)
  return `
# Your earlier review of ${short}

You asked for changes on ${short}. What blocked it then:

${listed}

In this round:
- First check each of those findings at HEAD. One that is not fixed stays, unless the builder answered it (see what the builder said, when it is given): the builder may have declined it with a reason.
- For each finding the builder declined, judge the reason, and do not repeat the finding without answering it. Keep it blocking only by saying, in the finding, why the reason is wrong; otherwise lower it to minor with a note for the owner. A finding the builder did not answer and did not fix stays, in the same words.
- Read what the task changed since then with \`${changedSinceCommand(earlier.sha, base)}\`. It leaves out what a merge of the integration branch brought in: that is other work, not this task's.
- A new blocker or major finding goes only on code the task changed since ${short}, or on another instance of a class of defect you already named, or on code that did not change when the change breaks it: a caller, a contract or a behaviour that worked on the review base and no longer does. Say which in the finding, and for a break give the evidence of what breaks. A concern about code that was already there, unchanged, that the change does not break is minor, not blocking. Anything else you notice now and did not raise before is minor.
`
}

/** The plan in the review: what the builder meant to change, and where the diff left it. */
function planSection(
  plan: string,
  unplanned: string[],
  builderSummary: string | undefined,
  required: RequiredByCheck[],
): string {
  const covered = required.some((check) => check.files.length > 0)
    ? 'Every file the diff changes is in the plan or was added after a factory check failed (see below).'
    : 'Every file the diff changes is in the plan.'
  const outside =
    unplanned.length === 0
      ? covered
      : `A check without a model found these files changed outside the plan:\n\n${unplanned.map((p) => `- \`${p}\``).join('\n')}`
  return `
# The builder's plan

The builder wrote this before it changed anything:

${plan}

${outside}

Measure the diff against the plan. A file changed outside the plan is a finding, at least major, unless the builder's summary gives a reason the issue needs it; then judge the reason. Edits the issue does not need (a reformat, a lint fix in an unrelated file) are not a reason.
${saidSection(builderSummary)}`
}

/** What the builder said when it finished, where it gives its reasons for a finding it did not fix. */
function saidSection(builderSummary: string | undefined): string {
  return builderSummary
    ? `\nWhat the builder said when it finished:\n\n${builderSummary.slice(0, 3_000)}\n`
    : ''
}

/**
 * What the factory's own checks asked for. Without it the reviewer reads a file a check demanded (an empty
 * changeset in a private package) as outside the plan and asks to remove it, which the builder cannot do
 * without failing the check again.
 */
function requiredSection(required: RequiredByCheck[]): string {
  if (required.length === 0) return ''
  const checks = required.map((check) => {
    const files =
      check.files.length === 0
        ? 'No file was added between the two commits.'
        : `Files added between the two commits:\n\n${check.files.map((p) => `- \`${p}\``).join('\n')}`
    return `The check \`${check.name}\` (\`${check.command}\`) failed on ${check.failedSha.slice(0, 7)} with:\n\n> ${check.error}\n\nIt passes on ${check.passedSha.slice(0, 7)} and on the commit under review. ${files}`
  })
  return `
# What the factory's checks required

The factory runs its own checks on every commit and accepts no work while one fails. On an earlier attempt of this task:

${checks.join('\n\n')}

A file listed here that the error of its check calls for is legitimate: the factory required it. Do not report it as outside the plan or as an unrelated change, and do not ask to remove it, even when a rule of the knowledge base says such a file is not needed. Its content is still yours to review, and so is any listed file the error does not explain.
`
}

/**
 * What the reviewer reads when the builder changed nothing and said the issue is already resolved. An
 * approval closes the issue on GitHub, so the reviewer checks the claim in the code and the tests instead
 * of trusting it.
 */
export function resolvedPrompt(input: {
  repo: string
  issueNumber: number
  title: string
  body: string
  baseSha: string
  /** What the builder said when it changed nothing. */
  claim: string
  knowledgeDir?: string
}): string {
  return `You are an independent code reviewer for the repository ${input.repo}. Another agent was given the issue below, changed nothing, and said the code at ${input.baseSha} already does what the issue asks. You did not write that answer and you must not change the code.

# ${input.title} (#${input.issueNumber})

${input.body || '(the issue has no description)'}

What the other agent said:

${input.claim}

That is a claim, not evidence. Check it at ${input.baseSha}, the commit checked out here:
- Find the code that does each thing the issue asks for, and the tests that cover it. Read them.
- Run the tests that cover it when you can.
- Decide whether anything the issue asks for is still missing or wrong.
- Do not edit, create or delete files, and do not run any git command that writes.
${
  input.knowledgeDir
    ? `
${knowledgeRules(input.knowledgeDir)}
`
    : ''
}
Finish with one JSON object on its own, and nothing after it:

{"verdict":"approve"|"changes","summary":"one or two sentences: where the code and the tests are, or what is missing","findings":[{"severity":"blocker"|"major"|"minor","file":"path or omit","issue":"what is still missing or wrong"}]}

Use "approve" only when everything the issue asks for is already in the code and tested: the issue is closed with your summary as the reason. Use "changes" when anything is missing, wrong or untested, and say what in the findings.
`
}

const SEVERITIES: Severity[] = ['blocker', 'major', 'minor']

/** Every top-level `{...}` in the text, balanced and string-aware, in order. */
export function jsonObjects(text: string): string[] {
  const found: string[] = []
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    for (let i = start; i < text.length; i++) {
      const c = text[i]
      if (inString) {
        if (c === '\\') i++
        else if (c === '"') inString = false
      } else if (c === '"') inString = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        found.push(text.slice(start, i + 1))
        break
      }
    }
  }
  return found
}

/**
 * Reads the verdict an agent wrote at the end of its answer. An answer that has none, or a verdict
 * word that is not one of the two, is `invalid`, and so is an approval that lists a blocker or a
 * major finding: when the reviewer contradicts itself, the factory does not pick the kinder reading.
 */
export function parseVerdict(text: string): ReviewVerdict {
  for (const candidate of jsonObjects(text).reverse()) {
    let parsed: { verdict?: unknown; summary?: unknown; findings?: unknown }
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (typeof parsed.verdict !== 'string') continue
    const findings: Finding[] = (Array.isArray(parsed.findings) ? parsed.findings : [])
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
      .map((f) => ({
        severity: SEVERITIES.includes(f.severity as Severity) ? (f.severity as Severity) : 'major',
        ...(typeof f.file === 'string' ? { file: f.file.slice(0, 200) } : {}),
        issue: String(f.issue ?? '').slice(0, 600),
      }))
      .filter((f) => f.issue !== '')
    const summary = String(parsed.summary ?? '').slice(0, 600)
    const verdict = parsed.verdict.toLowerCase()
    if (verdict === 'changes') return { verdict: 'changes', summary, findings }
    if (verdict === 'approve') {
      const blocking = findings.some((f) => f.severity !== 'minor')
      return blocking
        ? { verdict: 'invalid', summary: `approved with a blocking finding: ${summary}`, findings }
        : { verdict: 'approve', summary, findings }
    }
  }
  return { verdict: 'invalid', summary: 'the reviewer did not end with a verdict', findings: [] }
}

export function renderFindings(findings: Finding[]): string {
  return findings
    .map((f) => `- **${f.severity}**${f.file ? ` \`${f.file}\`` : ''}: ${f.issue}`)
    .join('\n')
}

/**
 * What the builder is told when it said the issue needs no change and the reviewer, reading the code,
 * found it is not resolved. It may still be right that the work cannot be done here, so it may say so.
 */
export function notResolvedPrompt(input: {
  summary: string
  findings: Finding[]
  checks?: CheckSpec[]
}): string {
  return [
    'You changed nothing and said the issue needs no change. A reviewer read the code and found it is not resolved:',
    input.summary,
    ...(input.findings.length > 0 ? [renderFindings(input.findings)] : []),
    'Make the change the issue asks for, with tests, and run them. Where the code differs from what the issue names (a file, a type or a function that is not there), build on what is there and say in your final message what you assumed.',
    'Change nothing only when the work truly cannot be done in this repository, because it needs something outside it (another package, a release, an account, a person). Then say exactly what is missing.',
    ...(input.checks?.length ? [checksRule(input.checks).trimEnd()] : []),
    'Do not run git commit or git push: the factory commits and pushes. Finish with a short summary.',
  ].join('\n\n')
}

/**
 * How the builder works through a reviewer's findings. A rework round that fixes one finding and adds the next
 * never converges (#207): the later round reads only what changed since the reviewed commit, so the builder
 * reads that same diff before it finishes, proves each fix with a test, and accounts for every finding and
 * every file outside its plan in the summary the reviewer reads.
 */
function findingsMethod(reviewedSha: string | undefined, changeBase: string | undefined): string {
  // The factory commits after the builder, so while it works HEAD is still the reviewed commit and its edits
  // are in the working tree: the diff is taken against the working tree, not HEAD.
  const diff = reviewedSha
    ? `The reviewer looks for new blockers only in what changed since ${reviewedSha.slice(0, 7)}, so before you finish read your own change with \`git diff ${reviewedSha}\``
    : 'Before you finish, read your own change with `git diff HEAD`'
  const whole = changeBase
    ? `read your whole change again with \`git diff ${changeBase}\` and look for the same class`
    : 'read your whole change again and look for the same class'
  return [
    'Work through the findings one by one:',
    '- For each finding, fix the class of defect it names, not only the line it quotes: find every place in your change that breaks the same invariant and fix them all, with a test for each instance. For each one, first write a test that fails without the fix, then fix it at its cause with the smallest change that does it, and run that test.',
    `- ${diff} the way the reviewer will: errors swallowed, races, input not checked, cases the new code misses. Fix what you find.`,
    `- Before you finish, ${whole} of defect in code the reviewer did not quote. A fix that brings a new instance of the class back is the most common reason a review does not end.`,
    '- A finding you cannot fix inside this issue, because it needs a release, another package or a decision only the owner can make: change nothing for it and say what is missing. Do not half-fix it.',
    '- A finding you decline: give the concrete reason and its evidence: a test, the specification, or the words of the issue. The reviewer keeps it blocking unless it can say why that reason is wrong.',
    '- In your summary, list each finding with what you changed and the test that shows it, and give the reason for every file you changed that your plan did not name.',
  ].join('\n')
}

/** What the builder is told when it has to go back to its work. */
export function reworkPrompt(input: {
  findings: Finding[]
  failedChecks: { command: string; output: string }[]
  checks?: CheckSpec[]
  /** The commit the reviewer read, when the work comes back from a review. */
  reviewedSha?: string
  /** Where the task's change starts, as the review measured it: the builder reads the whole change from there. */
  changeBase?: string
}): string {
  const parts = [
    'Your change was not accepted. Fix what follows, then finish with a short summary.',
  ]
  if (input.failedChecks.length > 0) {
    parts.push(
      'These checks failed on your commit:',
      ...input.failedChecks.map(
        (c) => `\`${c.command}\` output (tail):\n\n${c.output.slice(-1500)}`,
      ),
    )
  }
  if (input.findings.length > 0) {
    parts.push(
      'A reviewer found:',
      renderFindings(input.findings),
      findingsMethod(input.reviewedSha, input.changeBase),
    )
  }
  if (input.checks?.length) parts.push(checksRule(input.checks).trimEnd())
  parts.push(
    'Keep the change limited to what the issue asks. Do not run git commit or git push: the factory commits and pushes.',
  )
  return parts.join('\n\n')
}
