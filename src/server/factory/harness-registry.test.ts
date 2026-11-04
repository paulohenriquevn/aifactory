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
