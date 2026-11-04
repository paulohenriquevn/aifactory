import type { SandboxBackend } from '@theokit/agents/sandbox'

import type { EgressRule } from './sandbox'

export type HarnessInput = {
  prompt: string
  /** Directory of the checked-out repository inside the sandbox. */
  cwd: string
  timeoutMs: number
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

export const PROMPT_FILE = '/tmp/factory-prompt.md'

export function buildPrompt(input: {
  repo: string
  issueNumber: number
  title: string
  body: string
  branch: string
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
- Finish with a short summary of what you changed.
`
}
