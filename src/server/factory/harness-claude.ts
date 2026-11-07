import { assertSafeName, type HarnessOptions } from './engine-models'
import type { SandboxBackend } from '@theokit/agents/sandbox'

import {
  assertSessionId,
  detectQuota,
  executeAgent,
  PROMPT_FILE,
  SUMMARY_MAX,
  type CodingHarness,
  type HarnessInput,
  type HarnessResult,
  watched,
} from './harness'
import { claudeEvents } from './transcript'

/**
 * The Claude Code the factory installs in every sandbox. Pinned, so a run never meets a CLI the factory was
 * not tested with, and installed by the harness, so a sandbox image does not have to carry it: the Docker
 * image is plain Node, and a run there found no `claude` at all (paulohenriquevn/aifactory#1).
 */
export const CLAUDE_CODE_VERSION = '2.1.319'
const CLAUDE = '$HOME/.local/bin/claude'

/**
 * How Claude Code pays for its requests: a Console API key, or the owner's subscription through
 * the one-year token `claude setup-token` prints. Either way the secret stays with the factory.
 */
export type ClaudeCredential = { kind: 'api-key' | 'subscription'; secret: string }

/**
 * The firewall rule that signs Claude Code's requests. An API key travels as `x-api-key`; the
 * subscription token as the bearer token Claude Code itself sends for it.
 */
export function anthropicEgress(credential: ClaudeCredential): {
  domain: string
  headers: Record<string, string>
} {
  const headers: Record<string, string> =
    credential.kind === 'api-key'
      ? { 'x-api-key': credential.secret }
      : { authorization: `Bearer ${credential.secret}` }
  return { domain: 'api.anthropic.com', headers }
}

/**
 * Picks the credential from the environment. `FACTORY_CLAUDE_AUTH` chooses when both are set;
 * otherwise the subscription token wins over the API key, and a missing credential is an error
 * that names both.
 */
export function claudeCredentialFromEnv(env: NodeJS.ProcessEnv): ClaudeCredential {
  const apiKey = env.ANTHROPIC_API_KEY
  const token = env.CLAUDE_CODE_OAUTH_TOKEN
  const wanted = env.FACTORY_CLAUDE_AUTH
  if (wanted !== undefined && wanted !== 'api-key' && wanted !== 'subscription') {
    throw new Error(`FACTORY_CLAUDE_AUTH must be api-key or subscription, got ${wanted}`)
  }
  const kind = wanted ?? (token ? 'subscription' : apiKey ? 'api-key' : undefined)
  const secret = kind === 'api-key' ? apiKey : token
  if (!kind || !secret) {
    throw new Error(
      kind === 'subscription'
        ? 'CLAUDE_CODE_OAUTH_TOKEN is not set (run `claude setup-token`)'
        : 'CLAUDE_CODE_OAUTH_TOKEN is not set (run `claude setup-token`), and neither is ANTHROPIC_API_KEY',
    )
  }
  return { kind, secret }
}

/**
 * Claude Code in headless mode. The secret never enters the sandbox: the environment carries a
 * placeholder, and the firewall attaches the real one on the way out. Permissions are skipped
 * because the sandbox is the boundary (a microVM with an explicit egress allowlist and no
 * secrets), and a headless run has nobody to answer a prompt.
 */
export function claudeCodeHarness(
  credential: ClaudeCredential,
  options: HarnessOptions = {},
): CodingHarness {
  // Both are checked here because they end up in a command line, whatever put them there.
  const model = options.model ? ` --model ${assertSafeName(options.model, 'model')}` : ''
  const effort = options.effort ? ` --effort ${assertSafeName(options.effort, 'effort')}` : ''
  const variable = credential.kind === 'api-key' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN'

  async function invoke(backend: SandboxBackend, input: HarnessInput, flags: string) {
    await backend.uploadFile(PROMPT_FILE, input.prompt)
    // A watched run prints one event per line, and its last line is the same result `json` prints.
    const format = watched(backend, input) ? 'stream-json --verbose' : 'json'
    // `cwd` is a path the factory built (see run-task), never text from the issue.
    const result = await executeAgent(
      backend,
      `cd ${input.cwd} && ${variable}=placeholder-not-a-secret CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 ${CLAUDE} -p --output-format ${format} --dangerously-skip-permissions${model}${effort}${flags} < ${PROMPT_FILE}`,
      input,
      claudeEvents,
    )
    return parseClaudeResult(result.exitCode, resultLine(result.stdout), result.stderr)
  }

  return {
    name: 'claude-code',
    egress: async () => [anthropicEgress(credential)],

    async prepare(backend) {
      const install = await backend.execute(
        `npm i -g --prefix $HOME/.local @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} 2>&1 | tail -3`,
        { timeoutMs: 180_000 },
      )
      const check = await backend.execute(`${CLAUDE} --version`)
      if (check.exitCode !== 0) {
        throw new Error(
          `claude did not install: ${(install.stdout || check.stderr).trim().slice(-300)}`,
        )
      }
    },
    run: (backend, input) => invoke(backend, input, ''),
    resume: async (backend, sessionId, input) =>
      invoke(backend, input, ` --resume ${assertSessionId(sessionId)}`),
  }
}

/**
 * The result in what Claude printed: the last `result` line of a stream, or all of it when it printed
 * one JSON document (`--output-format json`) or something that is not JSON at all.
 */
export function resultLine(stdout: string): string {
  const lines = stdout.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    // The keys come in no fixed order, so the line is read, not matched by its first characters.
    if (isResult(lines[i])) return lines[i]
  }
  return stdout
}

function isResult(line: string): boolean {
  try {
    const value: unknown = JSON.parse(line)
    return (
      typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'result'
    )
  } catch {
    return false
  }
}

export function parseClaudeResult(exitCode: number, stdout: string, stderr: string): HarnessResult {
  try {
    const parsed = JSON.parse(stdout) as {
      is_error?: boolean
      result?: string
      total_cost_usd?: number
      session_id?: string
    }
    const summary = String(parsed.result ?? '').slice(0, SUMMARY_MAX)
    const ok = exitCode === 0 && parsed.is_error !== true
    const quota = ok ? undefined : detectQuota(summary)
    return {
      ok,
      summary,
      costUsd: parsed.total_cost_usd,
      ...(parsed.session_id ? { sessionId: parsed.session_id } : {}),
      ...(quota ? { quota } : {}),
    }
  } catch {
    const tail = (stderr || stdout).trim().slice(-1000)
    const quota = detectQuota(tail)
    return {
      ok: false,
      summary: `claude exited ${exitCode} without a JSON result: ${tail}`,
      ...(quota ? { quota } : {}),
    }
  }
}
