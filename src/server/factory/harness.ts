import { knowledgeRules, LEARNED_RULE } from '../knowledge/prompt'
import type { SandboxBackend } from '@theokit/agents/sandbox'

import { streams, type EgressRule, type ExecuteResult } from './sandbox'
import type { CheckSpec } from './evidence'
import type { AgentEvent } from './transcript'

/** What the builder may not touch. The review prompt reads the same list, so the two cannot drift apart. */
export const FORBIDDEN_PATHS = ['.github/']

/** Is the file under a path the builder may not touch? */
export function isForbiddenPath(file: string): boolean {
  const clean = file.replace(/^(\.\/)+/, '')
  return FORBIDDEN_PATHS.some((p) => clean.startsWith(p))
}

/** The builder's rule for those paths. */
export function forbiddenPathsRule(): string {
  return FORBIDDEN_PATHS.map((p) => `- Do not edit anything under ${p}.`).join('\n')
}

export type HarnessInput = {
  prompt: string
  /** Directory of the checked-out repository inside the sandbox. */
  cwd: string
  timeoutMs: number
  /** Called with each step of the agent while it works, when the sandbox can stream its output. */
  onEvent?: (event: AgentEvent) => void
}

const count = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

/** The sum of the counts that are numbers, or undefined when none is. */
export function sum(...parts: unknown[]): number | undefined {
  const given = parts.filter(count)
  return given.length === 0 ? undefined : given.reduce((a, b) => a + b, 0)
}

/** The token fields of a result, only for the counts the agent gave. */
export function tokenCounts(tokensIn: unknown, tokensOut: unknown): Partial<HarnessResult> {
  return {
    ...(count(tokensIn) ? { tokensIn } : {}),
    ...(count(tokensOut) ? { tokensOut } : {}),
  }
}

/** The agent stopped because its account's quota ran out: a wait, not a flaw in the work. */
export type QuotaStop = { message: string; resetsAt?: string }

export type HarnessResult = {
  ok: boolean
  summary: string
  costUsd?: number
  /** The model the agent reports it ran. Absent when it says nothing; null when it says several, so none is the pass's. */
  model?: string | null
  /** Tokens the agent says it read and wrote, when it says. */
  tokensIn?: number
  tokensOut?: number
  /** What `resume` needs to continue this conversation. */
  sessionId?: string
  quota?: QuotaStop
  /** The provider refused the agent's login (a 401): renewing it and running again may fix that. */
  unauthorized?: boolean
  /** The pass was cut at its time limit: what it wrote in the checkout is still there. */
  timedOut?: boolean
}

/**
 * An external coding agent, run inside a sandbox. A new agent is one file that implements this: the
 * orchestrator never names a specific one.
 */
export interface CodingHarness {
  readonly name: string
  /** The model and effort this agent was told to use; absent when it runs on its own default. */
  readonly model?: string
  readonly effort?: string
  /**
   * The firewall rules that sign this agent's calls. The secret lives here, on the factory host,
   * and the sandbox only ever gets a placeholder, so this is the one place a credential is read.
   */
  egress(): Promise<EgressRule[]>
  /** Installs and configures the agent in a fresh sandbox, when it is not already there. */
  prepare?(backend: SandboxBackend): Promise<void>
  /**
   * Renews the login the provider refused, `installed` being the credential the sandbox's firewall signs with,
   * and puts the new one in the sandbox. Answers the rules the firewall must now have.
   */
  reauthorize?(backend: SandboxBackend, installed: string): Promise<EgressRule[]>
  /** Records that the provider refused `installed` again after a renewal, so the panel can say so. */
  markRefused?(installed: string): Promise<void>
  run(backend: SandboxBackend, input: HarnessInput): Promise<HarnessResult>
  /** Continues a conversation `run` started, in the same sandbox or one restored from a snapshot. */
  resume?(backend: SandboxBackend, sessionId: string, input: HarnessInput): Promise<HarnessResult>
}

/** Whether a run can be watched: someone listens, and the sandbox hands output over as it comes. */
export const watched = (backend: SandboxBackend, input: HarnessInput): boolean =>
  input.onEvent !== undefined && streams(backend)

/**
 * Runs the agent's command. When the run is watched, each line of output goes through `read` and the
 * events it finds go to `onEvent` while the agent works; the result is the same either way.
 */
export function executeAgent(
  backend: SandboxBackend,
  command: string,
  input: HarnessInput,
  read: (line: string) => AgentEvent[],
): Promise<ExecuteResult> {
  const { onEvent, timeoutMs } = input
  if (!onEvent || !streams(backend)) return backend.execute(command, { timeoutMs })
  return backend.executeStreaming(command, {
    timeoutMs,
    onStdoutLine: (line) => read(line).forEach(onEvent),
  })
}

/** The text an unattended agent sends back when the account's limit was reached. */
const QUOTA = /usage limit|hit your (usage )?limit|limit reached|rate.?limit(ed| exceeded)/i
const RESETS = /(?:try again at|resets?(?: at)?)\s+([^.|\n]{3,40})/i

/** Reads a quota stop out of an agent's own words, or returns nothing when it is another error. */
export function detectQuota(text: string): QuotaStop | undefined {
  if (!QUOTA.test(text)) return undefined
  const resetsAt = RESETS.exec(text)?.[1]?.trim()
  return { message: text.trim().slice(0, 300), ...(resetsAt ? { resetsAt } : {}) }
}

/** Session ids are UUIDs. One is put in a shell command, so anything else is refused. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertSessionId(id: string): string {
  if (!SESSION_ID.test(id)) throw new Error(`session id must be a UUID, got ${JSON.stringify(id)}`)
  return id
}

/**
 * The longest answer a harness keeps. A reviewer's verdict is the last thing it writes, so this
 * is generous; what is stored or shown is cut shorter by whoever uses it.
 */
export const SUMMARY_MAX = 20_000

export const PROMPT_FILE = '/tmp/factory-prompt.md'

/**
 * The commands the factory runs on the agent's commit, as a rule of the prompt, or nothing when there are none.
 * An agent that knows only "run the project's tests" fixes a test and leaves the lint red.
 */
export function checksRule(checks: CheckSpec[] | undefined): string {
  if (!checks?.length) return ''
  return `- The factory runs these checks on your commit after your pass, and sends the work back when one fails:\n${checks
    .map((c) => `  - \`${c.command}\``)
    .join(
      '\n',
    )}\n  Do not run them yourself: they are slow and your pass has a time limit. Run only the tests of the files you touched.\n  One exception: when your work changes what a generated, committed file is made from (a check such as \`generated-docs\` compares them), run the generator, and the build it needs, and commit the result.\n`
}

export function buildPrompt(input: {
  repo: string
  issueNumber: number
  title: string
  body: string
  branch: string
  /** What a person asked to change in an earlier pull request from this branch. */
  feedback?: string
  /** Who sent the work back: a person (the default) or the repository's required checks. */
  feedbackFrom?: 'person' | 'checks'
  /** True when the branch the feedback was about is gone: the work starts from the integration branch. */
  startsOver?: boolean
  /** False when nobody is there to answer: the agent decides, and says what it assumed. */
  askQuestions?: boolean
  /** Where the knowledge base is in the sandbox, when the factory delivered one. */
  knowledgeDir?: string
  /** What the owner answered before any run started, when the scheduler found the issue not ready. */
  clarifications?: Clarification[]
  /** What the factory runs on the commit. */
  checks?: CheckSpec[]
}): string {
  return `You are working on the repository ${input.repo}, on the branch ${input.branch}.

Implement this issue.

# ${input.title} (#${input.issueNumber})

${input.body || '(the issue has no description)'}
${clarificationsOf(input.clarifications)}
Rules:
- Read AGENTS.md first and follow it.
- Add or update tests for the behavior you change, and run the project's tests until they pass.
- Keep the change small and limited to what the issue asks.
- Do not run git commit, git push or any other git command that writes. The factory commits and pushes.
${forbiddenPathsRule()}
${checksRule(input.checks)}${
    input.askQuestions === false
      ? '- Nobody is there to answer a question, so do not ask one. When a decision is missing, choose the most reasonable option, say in your final message what you assumed, and go on.'
      : '- If you cannot go on without a decision only a person can make, do not guess. Leave the repository as it is and end your final message with a line that starts with `QUESTION:`, followed by one specific question (offer the options you see).'
  }
${input.knowledgeDir ? `${LEARNED_RULE}\n` : ''}- Finish with a short summary of what you changed.
${input.knowledgeDir ? `\n${knowledgeRules(input.knowledgeDir)}\n` : ''}${
    input.feedback
      ? `\n${sentBackBy(input)}\n\n${input.feedback}\n\n${input.startsOver ? 'The branch of that run no longer exists, so none of its work is here. Start from what the repository holds now.' : 'The branch already holds your earlier work. Build on it.'}\n`
      : ''
  }`
}

/** A question the scheduler asked on the issue before any run, and what the owner answered. */
export type Clarification = { question: string; answer: string; by: string }

/** The owner's answers to the readiness questions, as part of the issue: they settle what it left open. */
function clarificationsOf(clarifications: Clarification[] | undefined): string {
  if (!clarifications?.length) return ''
  const each = clarifications.map(
    (c) => `Question: ${c.question}\n\nAnswer, from ${c.by}: ${c.answer}`,
  )
  return `\nBefore any work started, the factory asked about this issue, and the answers are part of it:\n\n${each.join('\n\n')}\n`
}

/** The line that says who sent the work back, above what they said. */
function sentBackBy(input: { feedbackFrom?: 'person' | 'checks'; startsOver?: boolean }): string {
  if (input.feedbackFrom === 'checks')
    return input.startsOver
      ? "The repository's required checks failed on what an earlier run of this issue delivered:"
      : "The repository's required checks failed on your earlier pull request:"
  return input.startsOver
    ? 'A person read what an earlier run of this issue ended with and asked for these changes:'
    : 'A person reviewed your earlier pull request and asked for these changes:'
}
