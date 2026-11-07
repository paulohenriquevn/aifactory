import { describe, expect, it } from 'vitest'

import { buildPrompt } from './harness'
import {
  anthropicEgress,
  CLAUDE_CODE_VERSION,
  claudeCodeHarness,
  claudeCredentialFromEnv,
  parseClaudeResult,
  resultLine,
} from './harness-claude'
import type { AgentEvent } from './transcript'
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

describe('claudeCodeHarness preparing a sandbox', () => {
  it('installs a pinned Claude Code, and runs that install rather than whatever is on the PATH', async () => {
    const sandbox = new FakeSandbox(() => ({ stdout: JSON.stringify({ result: 'ok' }) }))
    const { backend } = await sandbox.create({ timeoutMs: 1, egress: [{ domain: 'github.com' }] })
    const harness = claudeCodeHarness({ kind: 'subscription', secret: 't' })

    await harness.prepare?.(backend)
    await harness.run(backend, { prompt: 'P', cwd: '/w', timeoutMs: 5 })

    expect(sandbox.backend.commands[0]).toContain(
      `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`,
    )
    expect(sandbox.backend.commands.at(-1)).toContain('$HOME/.local/bin/claude -p')
  })

  it('stops with what the install printed when claude does not run', async () => {
    const sandbox = new FakeSandbox((c) =>
      c.includes('--version') ? { exitCode: 127, stderr: 'not found' } : { stdout: 'npm ERR! 403' },
    )
    const { backend } = await sandbox.create({ timeoutMs: 1, egress: [{ domain: 'github.com' }] })

    await expect(
      claudeCodeHarness({ kind: 'api-key', secret: 'k' }).prepare?.(backend),
    ).rejects.toThrow(/claude did not install: npm ERR! 403/)
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
    ).toBe('subscription')
  })

  it('lets FACTORY_CLAUDE_AUTH pick the API key when both are set', () => {
    const env = { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' }
    expect(claudeCredentialFromEnv({ ...env, FACTORY_CLAUDE_AUTH: 'api-key' }).secret).toBe('k')
  })

  it('names what is missing instead of picking something else', () => {
    expect(() => claudeCredentialFromEnv({})).toThrow(/CLAUDE_CODE_OAUTH_TOKEN.*ANTHROPIC_API_KEY/)
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

  it('lets the agent ask by default, with a QUESTION: line', () => {
    const prompt = buildPrompt({ repo: 'o/r', issueNumber: 1, title: 't', body: 'b', branch: 'x' })
    expect(prompt).toContain('QUESTION:')
    expect(prompt).not.toContain('Nobody is there to answer')
  })

  it('tells the agent to decide and say what it assumed when nobody is there to answer', () => {
    const prompt = buildPrompt({
      repo: 'o/r',
      issueNumber: 1,
      title: 't',
      body: 'b',
      branch: 'x',
      askQuestions: false,
    })
    expect(prompt).toContain('Nobody is there to answer a question, so do not ask one')
    expect(prompt).toContain('say in your final message what you assumed')
    expect(prompt).not.toContain('QUESTION:')
  })

  it('says when the issue has no description', () => {
    const prompt = buildPrompt({ repo: 'o/r', issueNumber: 1, title: 't', body: '', branch: 'b' })
    expect(prompt).toContain('the issue has no description')
  })
})

describe('claudeCodeHarness model and effort', () => {
  const run = async (options: { model?: string; effort?: string }, resume = false) => {
    const sandbox = new FakeSandbox(() => ({
      stdout: JSON.stringify({ is_error: false, result: 'ok' }),
    }))
    const { backend } = await sandbox.create({ timeoutMs: 1, egress: [{ domain: 'github.com' }] })
    const harness = claudeCodeHarness({ kind: 'subscription', secret: 't' }, options)
    const input = { prompt: 'P', cwd: '/work', timeoutMs: 5 }
    if (resume) await harness.resume!(backend, '11111111-1111-4111-8111-111111111111', input)
    else await harness.run(backend, input)
    return sandbox.backend.commands.at(-1)!
  }

  it('tells the agent which model and how much effort, when it was chosen', async () => {
    const command = await run({ model: 'opus', effort: 'high' })
    expect(command).toContain('--dangerously-skip-permissions --model opus --effort high <')
  })

  it('tells it the same when it picks a session back up', async () => {
    const command = await run({ model: 'opus', effort: 'high' }, true)
    expect(command).toContain(
      '--model opus --effort high --resume 11111111-1111-4111-8111-111111111111',
    )
  })

  it('says nothing about either when none was chosen, so the agent uses its own default', async () => {
    const command = await run({})
    expect(command).not.toContain('--model')
    expect(command).not.toContain('--effort')
    expect(await run({ model: 'sonnet' })).not.toContain('--effort')
  })

  it('refuses a name a shell would read, instead of putting it in the command', async () => {
    expect(() =>
      claudeCodeHarness({ kind: 'api-key', secret: 'k' }, { model: 'x; rm -rf /' }),
    ).toThrow(/not a plain name/)
    expect(() => claudeCodeHarness({ kind: 'api-key', secret: 'k' }, { effort: '$(id)' })).toThrow(
      /not a plain name/,
    )
  })
})

describe('a watched Claude run', () => {
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Reading.' }] },
    }),
    JSON.stringify({ type: 'result', is_error: false, result: 'done', total_cost_usd: 0.2 }),
  ].join('\n')

  it('streams JSON events and hands each step over, with the same result as an unwatched run', async () => {
    const sandbox = new FakeSandbox(() => ({ stdout: stream }), { streaming: true })
    const { backend } = await sandbox.create({ timeoutMs: 1, egress: [] })
    const seen: AgentEvent[] = []

    const result = await claudeCodeHarness({ kind: 'api-key', secret: 'k' }).run(backend, {
      prompt: 'P',
      cwd: '/work',
      timeoutMs: 5,
      onEvent: (event) => seen.push(event),
    })

    expect(result).toEqual({ ok: true, summary: 'done', costUsd: 0.2 })
    expect(seen).toEqual([
      { kind: 'message', content: 'Reading.' },
      { kind: 'cost', content: '$0.2000' },
    ])
    expect(sandbox.backend.commands[0]).toContain('--output-format stream-json --verbose')
  })

  it('prints one JSON document when nobody listens, or the sandbox cannot stream', async () => {
    for (const [streaming, onEvent] of [
      [true, undefined],
      [false, () => {}],
    ] as const) {
      const sandbox = new FakeSandbox(() => ({ stdout: '{"result":"x"}' }), { streaming })
      const { backend } = await sandbox.create({ timeoutMs: 1, egress: [] })
      await claudeCodeHarness({ kind: 'api-key', secret: 'k' }).run(backend, {
        prompt: 'P',
        cwd: '/work',
        timeoutMs: 5,
        ...(onEvent ? { onEvent } : {}),
      })
      expect(sandbox.backend.commands[0]).toContain('--output-format json ')
    }
  })
})

describe('resultLine', () => {
  it('finds the result whatever order its keys come in, as Claude Code 2.1.319 prints them', () => {
    const result =
      '{"duration_api_ms":1995,"stop_reason":"end_turn","session_id":"s","total_cost_usd":0.1,"type":"result","is_error":false,"result":"ok"}'
    expect(resultLine(`{"type":"system"}\n${result}\n`)).toBe(result)
    expect(parseClaudeResult(0, resultLine(`{"type":"system"}\n${result}`), '')).toMatchObject({
      ok: true,
      summary: 'ok',
    })
  })


  it('takes the last result of a stream, and the whole output otherwise', () => {
    expect(resultLine('{"type":"x"}\n{"type":"result","n":1}\n{"type":"result","n":2}\n')).toBe(
      '{"type":"result","n":2}',
    )
    expect(resultLine('{"result":"x"}')).toBe('{"result":"x"}')
    expect(resultLine('boom')).toBe('boom')
  })
})
