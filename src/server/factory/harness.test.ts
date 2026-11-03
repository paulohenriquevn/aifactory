import { describe, expect, it } from 'vitest'

import { buildPrompt, claudeCodeHarness, parseClaudeResult } from './harness'
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

    const result = await claudeCodeHarness().run(backend, {
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
