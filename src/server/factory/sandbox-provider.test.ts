import { describe, expect, it } from 'vitest'

import { sandboxProviderFromEnv } from './sandbox-provider'

describe('sandboxProviderFromEnv', () => {
  it('is Vercel Sandbox unless the owner chose another place', () => {
    expect(sandboxProviderFromEnv({}).name).toBe('vercel-sandbox')
    expect(sandboxProviderFromEnv({ FACTORY_SANDBOX: '' }).name).toBe('vercel-sandbox')
    expect(sandboxProviderFromEnv({ FACTORY_SANDBOX: 'vercel' }).name).toBe('vercel-sandbox')
  })

  it('is containers on this machine for docker, with no snapshots to resume from', () => {
    const provider = sandboxProviderFromEnv({ FACTORY_SANDBOX: ' docker ' })
    expect(provider.name).toBe('docker')
    expect(provider.restore).toBeUndefined()
    expect(provider.listSnapshots).toBeUndefined()
  })

  it('refuses a place it does not know, rather than running somewhere else', () => {
    expect(() => sandboxProviderFromEnv({ FACTORY_SANDBOX: 'e2b' })).toThrow('use vercel or docker')
  })
})
