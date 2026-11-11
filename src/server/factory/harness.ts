import { knowledgeRules, LEARNED_RULE } from '../knowledge/prompt'
import type { SandboxBackend } from '@theokit/agents/sandbox'

import { streams, type EgressRule, type ExecuteResult } from './sandbox'
import type { CheckSpec } from './evidence'
import type { AgentEvent } from './transcript'

export type HarnessInput = {
  prompt: string
  /** Directory of the checked-out repository inside the sandbox. */
  cwd: string
  timeoutMs: number
  /** Called with each step of the agent while it works, when the sandbox can stream its output. */
  onEvent?: (event: AgentEvent) => void
}

/** The agent stopped because its account's quota ran out: a wait, not a flaw in the work. */
export type QuotaStop = { message: string; resetsAt?: string }

export type HarnessResult = {
  ok: boolean
  summary: string
  costUsd?: number
  /** What `resume` needs to continue this conversation. */
  sessionId?: string
  quota?: QuotaStop
}

/**
 * An external coding agent, run inside a sandbox. A new agent is one file that implements this: the
 * orchestrator never names a specific one.
 */
export interface CodingHarness {
  readonly name: string
  /**
   * The firewall rules that sign this agent's calls. The secret lives here, on the factory host,
   * and the sandbox only ever gets a placeholder, so this is the one place a credential is read.
   */
  egress(): Promise<EgressRule[]>
  /** Installs and configures the agent in a fresh sandbox, when it is not already there. */
  prepare?(backend: SandboxBackend): Promise<void>
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
  return `- Before you finish, run what the factory runs on your commit, in the repository root, and fix what fails:\n${checks
    .map((c) => `  - \`${c.command}\``)
    .join('\n')}\n`
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
  /** False when nobody is there to answer: the agent decides, and says what it assumed. */
  askQuestions?: boolean
  /** Where the knowledge base is in the sandbox, when the factory delivered one. */
  knowledgeDir?: string
  /** What the factory runs on the commit. */
  checks?: CheckSpec[]
}): string {
  return `You are working on the repository ${input.repo}, on the branch ${input.branch}.

Implement this issue.

# ${input.title} (#${input.issueNumber})

${input.body || '(the issue has no description)'}

Rules:
- Read AGENTS.md first and follow it.
- Add or update tests for the behavior you change, and run the project's tests until they pass.
- Keep the change small and limited to what the issue asks.
- Do not run git commit, git push or any other git command that writes. The factory commits and pushes.
- Do not edit anything under .github/.
${checksRule(input.checks)}${
    input.askQuestions === false
      ? '- Nobody is there to answer a question, so do not ask one. When a decision is missing, choose the most reasonable option, say in your final message what you assumed, and go on.'
      : '- If you cannot go on without a decision only a person can make, do not guess. Leave the repository as it is and end your final message with a line that starts with `QUESTION:`, followed by one specific question (offer the options you see).'
  }
${input.knowledgeDir ? `${LEARNED_RULE}\n` : ''}- Finish with a short summary of what you changed.
${input.knowledgeDir ? `\n${knowledgeRules(input.knowledgeDir)}\n` : ''}${
    input.feedback
      ? `\n${input.feedbackFrom === 'checks' ? "The repository's required checks failed on your earlier pull request:" : 'A person reviewed your earlier pull request and asked for these changes:'}\n\n${input.feedback}\n\nThe branch already holds your earlier work. Build on it.\n`
      : ''
  }`
}
