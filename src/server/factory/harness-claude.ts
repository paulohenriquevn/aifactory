import { assertSafeName, type HarnessOptions } from './engine-models'
import type { SandboxBackend } from '@theokit/agents/sandbox'

import {
  assertSessionId,
  detectQuota,
  PROMPT_FILE,
  SUMMARY_MAX,
  type CodingHarness,
  type HarnessInput,
  type HarnessResult,
} from './harness'

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

  async function invoke(
    backend: SandboxBackend,
    { prompt, cwd, timeoutMs }: HarnessInput,
    flags: string,
  ) {
    await backend.uploadFile(PROMPT_FILE, prompt)
    // `cwd` is a path the factory built (see run-task), never text from the issue.
    const result = await backend.execute(
      `cd ${cwd} && ${variable}=placeholder-not-a-secret CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 claude -p --output-format json --dangerously-skip-permissions${model}${effort}${flags} < ${PROMPT_FILE}`,
      { timeoutMs },
    )
    return parseClaudeResult(result.exitCode, result.stdout, result.stderr)
  }

  return {
    name: 'claude-code',
    egress: async () => [anthropicEgress(credential)],
    run: (backend, input) => invoke(backend, input, ''),
    resume: async (backend, sessionId, input) =>
      invoke(backend, input, ` --resume ${assertSessionId(sessionId)}`),
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
