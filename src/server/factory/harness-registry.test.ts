import { describe, expect, it } from 'vitest'

import { harnessRegistry, pickHarness } from './harness-registry'

const env = { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' }

describe('pickHarness', () => {
  const registry = harnessRegistry(env)

  it('uses the default when the issue names no agent', () => {
    expect(pickHarness(registry, 'claude-code', ['bug', 'factory']).name).toBe('claude-code')
  })

  it('uses the agent a harness:<name> label asks for', () => {
    expect(pickHarness(registry, 'claude-code', ['factory', 'harness:codex']).name).toBe('codex')
    expect(pickHarness(registry, 'claude-code', ['Harness:Codex']).name).toBe('codex')
  })

  it('accepts the same label twice and refuses two different agents', () => {
    expect(pickHarness(registry, 'claude-code', ['harness:codex', 'harness:codex']).name).toBe(
      'codex',
    )
    expect(() =>
      pickHarness(registry, 'claude-code', ['harness:codex', 'harness:claude-code']),
    ).toThrow(/more than one harness/)
  })

  it('refuses an unknown agent and lists the known ones', () => {
    expect(() => pickHarness(registry, 'claude-code', ['harness:gemini'])).toThrow(
      /unknown agent "gemini" \(known: claude-code, codex\)/,
    )
  })

  it('picks the reviewer from its own label, apart from the builder', () => {
    expect(
      pickHarness(registry, 'claude-code', ['harness:codex', 'reviewer:claude-code'], 'reviewer')
        .name,
    ).toBe('claude-code')
    expect(() =>
      pickHarness(registry, 'claude-code', ['reviewer:codex', 'reviewer:claude-code'], 'reviewer'),
    ).toThrow(/more than one reviewer/)
  })

  it('only needs the credential of the agent it builds', () => {
    const onlyClaude = harnessRegistry({ ANTHROPIC_API_KEY: 'k', FACTORY_CODEX_HOME: '/nope' })
    expect(pickHarness(onlyClaude, 'claude-code', []).name).toBe('claude-code')
    expect(() => pickHarness(onlyClaude, 'claude-code', ['harness:codex'])).toThrow(
      /OPENAI_API_KEY/,
    )
  })
})

describe('what an agent is told about its model', () => {
  it('asks for the options of the agent that ends up chosen, not of the one that was the default', () => {
    const asked: string[] = []
    const registry = {
      'claude-code': () => ({ name: 'claude-code' }) as never,
      codex: () => ({ name: 'codex' }) as never,
    }
    const built: Record<string, unknown> = {}
    const spy = {
      'claude-code': (o?: unknown) => ((built['claude-code'] = o), registry['claude-code']()),
      codex: (o?: unknown) => ((built.codex = o), registry.codex()),
    }
    const optionsFor = (engine: string) => (
      asked.push(engine),
      engine === 'codex' ? { model: 'gpt-6.1-sol' } : { model: 'opus' }
    )

    pickHarness(spy, 'claude-code', [], 'harness', optionsFor)
    pickHarness(spy, 'claude-code', ['harness:codex'], 'harness', optionsFor)

    expect(asked).toEqual(['claude-code', 'codex'])
    expect(built).toEqual({ 'claude-code': { model: 'opus' }, codex: { model: 'gpt-6.1-sol' } })
  })

  it('builds the agent with no options when none are asked for', () => {
    let seen: unknown = 'untouched'
    pickHarness(
      { 'claude-code': (o) => ((seen = o), { name: 'claude-code' } as never) },
      'claude-code',
      [],
    )
    expect(seen).toBeUndefined()
  })
})
