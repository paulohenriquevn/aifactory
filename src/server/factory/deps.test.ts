import { describe, expect, it } from 'vitest'

import { releaseModeFromEnv } from './deps'

describe('releaseModeFromEnv', () => {
  it('is manual unless told otherwise, so nothing merges by itself', () => {
    expect(releaseModeFromEnv({})).toBe('manual')
    expect(releaseModeFromEnv({ FACTORY_RELEASE_MODE: '' })).toBe('manual')
  })

  it('takes the three modes and refuses any other word', () => {
    for (const mode of ['manual', 'trial', 'auto']) {
      expect(releaseModeFromEnv({ FACTORY_RELEASE_MODE: mode })).toBe(mode)
    }
    expect(() => releaseModeFromEnv({ FACTORY_RELEASE_MODE: 'yolo' })).toThrow(
      /must be manual, trial or auto, got yolo/,
    )
  })
})
