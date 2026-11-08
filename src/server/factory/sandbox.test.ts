import { describe, expect, it } from 'vitest'

import { FakeSandbox } from './fake-sandbox'
import { assertIsolated, createIsolatedSandbox, IsolationRefused } from './sandbox'

const ok = { timeoutMs: 60_000, egress: [{ domain: 'github.com' }] }

describe('assertIsolated', () => {
  it('accepts an explicit list of domains', () => {
    expect(() =>
      assertIsolated({
        ...ok,
        egress: [
          { domain: 'github.com' },
          { domain: '*.npmjs.org' },
          { domain: 'api.anthropic.com' },
        ],
      }),
    ).not.toThrow()
  })

  it.each([
    ['an empty allowlist', { ...ok, egress: [] }, /allowlist is empty/],
    ['a catch-all', { ...ok, egress: [{ domain: '*' }] }, /not an allowed destination/],
    ['an IP address', { ...ok, egress: [{ domain: '10.0.0.1' }] }, /not an allowed destination/],
    ['a bare hostname', { ...ok, egress: [{ domain: 'localhost' }] }, /not an allowed destination/],
    ['a URL', { ...ok, egress: [{ domain: 'https://github.com' }] }, /not an allowed destination/],
    ['no timeout', { ...ok, timeoutMs: 0 }, /no timeout/],
  ])('refuses %s', (_name, spec, message) => {
    expect(() => assertIsolated(spec)).toThrow(IsolationRefused)
    expect(() => assertIsolated(spec)).toThrow(message)
  })
})

describe('createIsolatedSandbox', () => {
  it('never reaches the provider when the spec is refused', async () => {
    const provider = new FakeSandbox()
    await expect(
      createIsolatedSandbox(provider, { ...ok, egress: [{ domain: '*' }] }),
    ).rejects.toThrow(IsolationRefused)
    expect(provider.specs).toHaveLength(0)
  })

  it('hands a valid spec to the provider', async () => {
    const provider = new FakeSandbox()
    await createIsolatedSandbox(provider, ok)
    expect(provider.specs).toEqual([ok])
  })
})
