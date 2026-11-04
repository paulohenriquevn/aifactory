import { describe, expect, it } from 'vitest'

import { buildPrompt } from './harness'
import {
  anthropicEgress,
  claudeCodeHarness,
  claudeCredentialFromEnv,
  parseClaudeResult,
} from './harness-claude'
import { FakeSandbox } from './fake-sandbox'

describe('parseClaudeResult', () => {
  it('reads the answer and the cost of a finished run', () => {
    expect(
      parseClaudeResult(
        0,
        JSON.stringify({ is_error: false, result: 'done', total_cost_usd: 0.4 }),
        '',
      ),
    ).toEqual({ ok: true, summary: 'done', costUsd: 0.4 })
  })

  it('is not ok when claude reports an error, even with exit code 0', () => {
    const result = parseClaudeResult(
      0,
      JSON.stringify({ is_error: true, result: 'Invalid API key' }),
      '',
    )
    expect(result).toMatchObject({ ok: false, summary: 'Invalid API key' })
  })

  it('is not ok on a non-zero exit', () => {
    expect(parseClaudeResult(1, JSON.stringify({ is_error: false, result: 'x' }), '').ok).toBe(
      false,
    )
  })

  it('keeps the tail of the output when there is no JSON', () => {
    const result = parseClaudeResult(2, 'boom', 'segfault')
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('exited 2')
    expect(result.summary).toContain('segfault')
  })
})

describe('claudeCodeHarness', () => {
  it('feeds the prompt by file and carries only a placeholder key', async () => {
    const sandbox = new FakeSandbox(() => ({
      stdout: JSON.stringify({ is_error: false, result: 'ok' }),
    }))
    const { backend } = await sandbox.create({ timeoutMs: 1, egress: [{ domain: 'github.com' }] })

    const result = await claudeCodeHarness({ kind: 'api-key', secret: 'k' }).run(backend, {
      prompt: 'PROMPT',
      cwd: '/vercel/work',
      timeoutMs: 5,
    })

    expect(result.ok).toBe(true)
    expect(sandbox.backend.files.get('/tmp/factory-prompt.md')).toBe('PROMPT')
    const [command] = sandbox.backend.commands
    expect(command).toContain('cd /vercel/work &&')
    expect(command).toContain('claude -p')
    expect(command).toContain('< /tmp/factory-prompt.md')
    expect(command).toContain('ANTHROPIC_API_KEY=placeholder-not-a-secret')
  })
})

describe('claudeCodeHarness with a subscription', () => {
  it('carries a placeholder for the OAuth token and none for an API key', async () => {
    const sandbox = new FakeSandbox(() => ({ stdout: JSON.stringify({ result: 'ok' }) }))
    const { backend } = await sandbox.create({ timeoutMs: 1, egress: [{ domain: 'github.com' }] })

    await claudeCodeHarness({ kind: 'subscription', secret: 't' }).run(backend, {
      prompt: 'P',
      cwd: '/w',
      timeoutMs: 5,
    })

    const [command] = sandbox.backend.commands
    expect(command).toContain('CLAUDE_CODE_OAUTH_TOKEN=placeholder-not-a-secret')
    expect(command).not.toContain('ANTHROPIC_API_KEY')
  })
})

describe('anthropicEgress', () => {
  it('signs an API key as x-api-key and a subscription token as a bearer token', () => {
    expect(anthropicEgress({ kind: 'api-key', secret: 'k' })).toEqual({
      domain: 'api.anthropic.com',
      headers: { 'x-api-key': 'k' },
    })
    expect(anthropicEgress({ kind: 'subscription', secret: 't' })).toEqual({
      domain: 'api.anthropic.com',
      headers: { authorization: 'Bearer t' },
    })
  })
})

describe('claudeCredentialFromEnv', () => {
  it('uses whichever credential exists, the API key first', () => {
    expect(claudeCredentialFromEnv({ ANTHROPIC_API_KEY: 'k' })).toEqual({
      kind: 'api-key',
      secret: 'k',
    })
    expect(claudeCredentialFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: 't' })).toEqual({
      kind: 'subscription',
      secret: 't',
    })
    expect(
      claudeCredentialFromEnv({ ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' }).kind,
    ).toBe('api-key')
  })

  it('lets FACTORY_CLAUDE_AUTH pick when both are set', () => {
    const env = { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' }
    expect(claudeCredentialFromEnv({ ...env, FACTORY_CLAUDE_AUTH: 'subscription' }).secret).toBe(
      't',
    )
  })

  it('names what is missing instead of picking something else', () => {
    expect(() => claudeCredentialFromEnv({})).toThrow(/ANTHROPIC_API_KEY.*CLAUDE_CODE_OAUTH_TOKEN/)
    expect(() =>
      claudeCredentialFromEnv({ ANTHROPIC_API_KEY: 'k', FACTORY_CLAUDE_AUTH: 'subscription' }),
    ).toThrow(/setup-token/)
    expect(() => claudeCredentialFromEnv({ FACTORY_CLAUDE_AUTH: 'oauth' })).toThrow(
      /api-key or subscription/,
    )
  })
})

describe('claudeCodeHarness resume and quota', () => {
  const id = '7db0be59-83ce-4961-a568-391f7b5c0327'

  it('resumes the same session and refuses an id that is not a UUID', async () => {
    const sandbox = new FakeSandbox(() => ({
      stdout: JSON.stringify({ result: 'ok', session_id: id }),
    }))
    const { backend } = await sandbox.create({ timeoutMs: 1, egress: [{ domain: 'github.com' }] })
    const harness = claudeCodeHarness({ kind: 'api-key', secret: 'k' })
    const input = { prompt: 'P', cwd: '/w', timeoutMs: 5 }

    const first = await harness.run(backend, input)
    await harness.resume?.(backend, first.sessionId!, input)

    expect(first.sessionId).toBe(id)
    expect(sandbox.backend.commands.at(-1)).toContain(`--resume ${id}`)
    await expect(harness.resume?.(backend, '$(reboot)', input)).rejects.toThrow(/UUID/)
  })

  it('reads a usage limit as a quota stop', () => {
    const result = parseClaudeResult(
      1,
      JSON.stringify({ is_error: true, result: "You've hit your limit · resets 3pm" }),
      '',
    )
    expect(result.quota).toMatchObject({ resetsAt: '3pm' })
    expect(
      parseClaudeResult(1, JSON.stringify({ is_error: true, result: 'Invalid API key' }), '').quota,
    ).toBeUndefined()
  })
})

describe('buildPrompt', () => {
  it('names the branch and the issue, and forbids the agent from pushing', () => {
    const prompt = buildPrompt({
      repo: 'o/r',
      issueNumber: 7,
      title: 'Add truncate',
      body: 'Do the thing.',
      branch: 'factory/7',
    })
    expect(prompt).toContain('factory/7')
    expect(prompt).toContain('Add truncate (#7)')
    expect(prompt).toContain('Do the thing.')
    expect(prompt).toMatch(/Do not run git commit, git push/)
  })

  it('says when the issue has no description', () => {
    const prompt = buildPrompt({ repo: 'o/r', issueNumber: 1, title: 't', body: '', branch: 'b' })
    expect(prompt).toContain('the issue has no description')
  })
})
