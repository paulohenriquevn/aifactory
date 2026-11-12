import { describe, expect, it } from 'vitest'

import { highestVersion, nextVersion, preReleaseNotes, preReleaseTag } from './release'

describe('preReleaseTag', () => {
  it('names the issue and the commit, so each delivered commit has its own', () => {
    expect(preReleaseTag(7, 'abcdef1234567890')).toBe('pre/7-abcdef1')
    expect(preReleaseTag(7, 'abcdef1234567890')).not.toBe(preReleaseTag(7, '1234567abcdef'))
  })
})

describe('highestVersion', () => {
  it('takes the highest version by number, not by name or by order', () => {
    expect(highestVersion(['v1.2.0', 'v1.10.0', 'v1.9.3', 'v0.9.0'])).toBe('v1.10.0')
    expect(highestVersion(['v1.9.9', 'v2.0.0', 'v1.10.0'])).toBe('v2.0.0')
    expect(highestVersion(['v1.2.10', 'v1.2.9'])).toBe('v1.2.10')
    expect(highestVersion(['v1.2.9', 'v1.2.10'])).toBe('v1.2.10')
    expect(highestVersion(['v2.0.0', 'v1.99.99'])).toBe('v2.0.0')
  })

  it('leaves out pre-release versions and tags of another shape', () => {
    expect(highestVersion(['v1.2.0', 'v2.0.0-rc.1', 'vendor-drop', 'v3'])).toBe('v1.2.0')
  })

  it('is nothing when no tag is a version', () => {
    expect(highestVersion(['vendor'])).toBeUndefined()
    expect(highestVersion([])).toBeUndefined()
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

describe('versions and notes, at their edges', () => {
  it('reads every digit of a version, and nothing that merely contains one', () => {
    expect(nextVersion('v10.20.30', 'patch')).toBe('v10.20.31')
    expect(nextVersion('v10.20.30', 'minor')).toBe('v10.21.0')
    expect(nextVersion('v10.20.30', 'major')).toBe('v11.0.0')
    for (const bad of ['v1.2.3-rc1', 'xv1.2.3', 'v1.2.3.4', 'v1.2.3 ']) {
      expect(() => nextVersion(bad, 'patch')).toThrow(/not a version/)
    }
  })

  const notes = {
    issueNumber: 7,
    title: 'T',
    sha: 'abcdef1234567890',
    pullRequestUrl: 'https://github.com/o/r/pull/9',
    checks: [],
    review: undefined,
    attempts: 1,
    costUsd: 0,
    agentSummary: '',
  }

  it('puts the pull request on its own line, followed by a blank one', () => {
    const lines = preReleaseNotes(notes).body.split('\n')
    const at = lines.indexOf('Pull request: https://github.com/o/r/pull/9')
    expect(at).toBeGreaterThan(0)
    expect(lines[at + 1]).toBe('')
  })

  it('keeps no more than three thousand characters of what the agent said', () => {
    const { body } = preReleaseNotes({
      ...notes,
      agentSummary: `${'a'.repeat(3_000)}${'Z'.repeat(2_000)}`,
    })
    expect(body).toContain('a'.repeat(3_000))
    expect(body).not.toContain('Z')
  })
})
