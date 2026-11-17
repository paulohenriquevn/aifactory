import { describe, expect, it } from 'vitest'

import { repositoryPatchSchema } from './repository-schema'

const parse = (runLimitMinutes: unknown) => repositoryPatchSchema.safeParse({ runLimitMinutes })

describe('runLimitMinutes', () => {
  it('accepts a value in range, and null to clear it', () => {
    expect(parse(150).success).toBe(true)
    expect(parse(50).success).toBe(true)
    expect(parse(240).success).toBe(true)
    expect(parse(null).success).toBe(true)
  })
  it('refuses a value outside the range, or one that is not a whole number', () => {
    expect(parse(49).success).toBe(false)
    expect(parse(241).success).toBe(false)
    expect(parse(90.5).success).toBe(false)
  })
})
