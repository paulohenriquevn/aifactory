import { describe, expect, it } from 'vitest'

import { nextVersion, preReleaseNotes, preReleaseTag } from './release'

describe('preReleaseTag', () => {
  it('names the issue and the commit, so each delivered commit has its own', () => {
    expect(preReleaseTag(7, 'abcdef1234567890')).toBe('pre/7-abcdef1')
    expect(preReleaseTag(7, 'abcdef1234567890')).not.toBe(preReleaseTag(7, '1234567abcdef'))
  })
})

describe('nextVersion', () => {
  it('bumps the part asked for and resets the ones after it', () => {
    expect(nextVersion('v1.2.3', 'patch')).toBe('v1.2.4')
    expect(nextVersion('v1.2.3', 'minor')).toBe('v1.3.0')
    expect(nextVersion('v1.2.3', 'major')).toBe('v2.0.0')
    expect(nextVersion('1.2.3', 'patch')).toBe('v1.2.4')
  })

  it('starts at v0.1.0, whatever the bump, when there is no release yet', () => {
    for (const bump of ['patch', 'minor', 'major'] as const) {
      expect(nextVersion(undefined, bump)).toBe('v0.1.0')
    }
  })

  it('refuses a latest tag that is not a version instead of guessing', () => {
    expect(() => nextVersion('release-2026', 'patch')).toThrow(/not a version like v1.2.3/)
    expect(() => nextVersion('v1.2', 'patch')).toThrow()
  })
})

describe('preReleaseNotes', () => {
  const base = {
    issueNumber: 7,
    title: 'Add truncate',
    sha: 'abcdef1234567890',
    pullRequestUrl: 'https://github.com/o/r/pull/9',
    checks: [{ command: 'npm test', passed: true, durationMs: 1840 }],
    review: { reviewer: 'codex', verdict: 'approve', summary: 'Matches the issue.' },
    attempts: 2,
    costUsd: 0.131,
    agentSummary: 'Added truncate with tests.',
  }

  it('says what the pre-release is, what stands behind it and what it is not', () => {
    const { name, body } = preReleaseNotes(base)
    expect(name).toBe('#7 Add truncate')
    expect(body).toContain('at `abcdef1`')
    expect(body).toContain('Pull request: https://github.com/o/r/pull/9')
    expect(body).toContain('- passed: `npm test` (1.8 s)')
    expect(body).toContain('Independent review: codex: approve. Matches the issue.')
    expect(body).toContain('Attempts: 2. Cost: $0.13.')
    expect(body).toContain('Added truncate with tests.')
    expect(body).toContain('Nothing was merged into the default branch.')
  })

  it('is honest about a commit nobody reviewed and checks that did not run', () => {
    const { body } = preReleaseNotes({
      ...base,
      review: undefined,
      checks: [],
      pullRequestUrl: undefined,
    })
    expect(body).toContain('Independent review: not reviewed')
    expect(body).toContain('- none ran')
    expect(body).not.toContain('Pull request:')
  })
})
