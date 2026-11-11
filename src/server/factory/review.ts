import { knowledgeRules } from '../knowledge/prompt'
import type { CheckSpec } from './evidence'
import { checksRule } from './harness'

export type Severity = 'blocker' | 'major' | 'minor'

export type Finding = { severity: Severity; file?: string; issue: string }

export type ReviewVerdict = {
  verdict: 'approve' | 'changes' | 'invalid'
  summary: string
  findings: Finding[]
}

/** The reviews a task gets before it goes to a person, counting the first one. */
export const MAX_ATTEMPTS = 3

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
}): string {
  return `You are an independent code reviewer for the repository ${input.repo}. Another agent implemented the issue below on the branch ${input.branch}. You did not write this code and you must not change it.

# ${input.title} (#${input.issueNumber})

${input.body || '(the issue has no description)'}
${input.plan === undefined ? '' : planSection(input.plan, input.unplanned ?? [], input.builderSummary)}
Review the work:
- Read the change with \`git diff ${input.baseSha}...HEAD\` and the files it touches.
- Decide whether it does what the issue asks, no more and no less.
- Check that the tests test the behavior: not weakened, skipped, deleted or made to pass by changing the test command.
- Look for bugs, missed edge cases, unrelated changes, secrets, and anything under .github/.
- You may run the project's tests. Do not edit, create or delete files, and do not run any git command that writes.
${
  input.knowledgeDir
    ? `- A change that breaks one of the owner's rules under ${input.knowledgeDir}/knowledge/ is a finding, at least major.\n\n${knowledgeRules(input.knowledgeDir)}\n`
    : ''
}
Finish with one JSON object on its own, and nothing after it:

{"verdict":"approve"|"changes","summary":"one or two sentences","findings":[{"severity":"blocker"|"major"|"minor","file":"path or omit","issue":"what is wrong and what to do"}]}

Use "changes" when there is any blocker or major finding. Use "approve" only when you would merge it as it is; minor findings may stay in an approval.
`
}

/** The plan in the review: what the builder meant to change, and where the diff left it. */
function planSection(plan: string, unplanned: string[], builderSummary?: string): string {
  const outside =
    unplanned.length === 0
      ? 'Every file the diff changes is in the plan.'
      : `A check without a model found these files changed outside the plan:\n\n${unplanned.map((p) => `- \`${p}\``).join('\n')}`
  return `
# The builder's plan

The builder wrote this before it changed anything:

${plan}

${outside}

Measure the diff against the plan. A file changed outside the plan is a finding, at least major, unless the builder's summary gives a reason the issue needs it; then judge the reason. Edits the issue does not need (a reformat, a lint fix in an unrelated file) are not a reason.
${builderSummary ? `\nWhat the builder said when it finished:\n\n${builderSummary.slice(0, 3_000)}\n` : ''}`
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

/** What the builder is told when it has to go back to its work. */
export function reworkPrompt(input: {
  findings: Finding[]
  failedChecks: { command: string; output: string }[]
  checks?: CheckSpec[]
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
    parts.push('A reviewer found:', renderFindings(input.findings))
  }
  if (input.checks?.length) parts.push(checksRule(input.checks).trimEnd())
  parts.push(
    'Keep the change limited to what the issue asks. Do not run git commit or git push: the factory commits and pushes.',
  )
  return parts.join('\n\n')
}
