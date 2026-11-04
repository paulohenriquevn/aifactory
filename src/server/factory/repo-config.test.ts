import { describe, expect, it } from 'vitest'

import { DOMAIN, labelsWithRepoChoice, NO_CONFIG } from './repo-config'

describe('labelsWithRepoChoice', () => {
  it('adds the repository agents when the issue names none', () => {
    expect(
      labelsWithRepoChoice(['bug'], { egress: [], harness: 'codex', reviewer: 'claude-code' }),
    ).toEqual(['bug', 'harness:codex', 'reviewer:claude-code'])
  })

  it('lets a label on the issue win, whatever case it is written in, for each kind alone', () => {
    const config = { egress: [], harness: 'codex', reviewer: 'claude-code' }
    expect(labelsWithRepoChoice(['Harness:claude-code'], config)).toEqual([
      'Harness:claude-code',
      'reviewer:claude-code',
    ])
    expect(labelsWithRepoChoice(['REVIEWER:codex'], config)).toEqual([
      'REVIEWER:codex',
      'harness:codex',
    ])
  })

  it('changes nothing when the repository chose nothing', () => {
    expect(labelsWithRepoChoice(['x'], NO_CONFIG)).toEqual(['x'])
    expect(labelsWithRepoChoice([], NO_CONFIG)).toEqual([])
  })

  it('does not mistake a label that merely contains the word for a choice', () => {
    expect(labelsWithRepoChoice(['not-harness:x'], { egress: [], harness: 'codex' })).toEqual([
      'not-harness:x',
      'harness:codex',
    ])
  })
})

describe('DOMAIN', () => {
  it('accepts hostnames with a dot, and nothing else the firewall could not take', () => {
    for (const ok of ['pypi.org', 'files.pythonhosted.org', 'a-b.example.co', 'x1.io']) {
      expect(DOMAIN.test(ok), ok).toBe(true)
    }
    for (const bad of [
      'localhost',
      'a..b.com',
      '-a.com',
      'a-.com',
      'a.c',
      'a b.com',
      'a.com/path',
      'a.com:443',
      'https://a.com',
      '1.2.3.4',
      '*.a.com',
      'A.com',
      '',
    ]) {
      expect(DOMAIN.test(bad), bad).toBe(false)
    }
    expect(DOMAIN.test(`${'a'.repeat(64)}.com`)).toBe(false)
    expect(DOMAIN.test(`${'a'.repeat(63)}.com`)).toBe(true)
  })
})
