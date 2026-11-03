import type { SandboxBackend } from '@theokit/agents/sandbox'

export type HarnessInput = {
  prompt: string
  /** Directory of the checked-out repository inside the sandbox. */
  cwd: string
  timeoutMs: number
}

export type HarnessResult = { ok: boolean; summary: string; costUsd?: number }

/** An external coding agent, run inside a sandbox. */
export interface CodingHarness {
  readonly name: string
  run(backend: SandboxBackend, input: HarnessInput): Promise<HarnessResult>
}

const PROMPT_FILE = '/tmp/factory-prompt.md'

/**
 * Claude Code in headless mode. The key never enters the sandbox: the environment carries a
 * placeholder, and the firewall attaches the real `x-api-key` on the way out. Permissions are
 * skipped because the sandbox is the boundary (a microVM with an explicit egress allowlist and no
 * secrets), and a headless run has nobody to answer a prompt.
 */
export function claudeCodeHarness(): CodingHarness {
  return {
    name: 'claude-code',
    async run(backend, { prompt, cwd, timeoutMs }) {
      await backend.uploadFile(PROMPT_FILE, prompt)
      // `cwd` is a path the factory built (see run-task), never text from the issue.
      const result = await backend.execute(
        `cd ${cwd} && ANTHROPIC_API_KEY=placeholder-not-a-secret CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 claude -p --output-format json --dangerously-skip-permissions < ${PROMPT_FILE}`,
        { timeoutMs },
      )
      return parseClaudeResult(result.exitCode, result.stdout, result.stderr)
    },
  }
}

export function parseClaudeResult(exitCode: number, stdout: string, stderr: string): HarnessResult {
  try {
    const parsed = JSON.parse(stdout) as {
      is_error?: boolean
      result?: string
      total_cost_usd?: number
    }
    return {
      ok: exitCode === 0 && parsed.is_error !== true,
      summary: String(parsed.result ?? '').slice(0, 4000),
      costUsd: parsed.total_cost_usd,
    }
  } catch {
    const tail = (stderr || stdout).trim().slice(-1000)
    return { ok: false, summary: `claude exited ${exitCode} without a JSON result: ${tail}` }
  }
}

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
