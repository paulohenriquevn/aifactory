import { describe, expect, it } from 'vitest'

import { FakeGithub } from '../../test/fake-github'

import {
  ensureBranches,
  INTEGRATION_BRANCH,
  integrationBranch,
  PRE_RELEASE_BRANCH,
  releaseBranchOf,
} from './branches'

describe('the three branches', () => {
  it('are workspace for integration, develop for the pre-release, and the default branch for the release', () => {
    expect(INTEGRATION_BRANCH).toBe('workspace')
    expect(PRE_RELEASE_BRANCH).toBe('develop')
  })

  it('integrates into workspace unless the owner chose another branch', () => {
    expect(integrationBranch({})).toBe('workspace')
    expect(integrationBranch({ baseBranch: null })).toBe('workspace')
    expect(integrationBranch({ baseBranch: 'staging' })).toBe('staging')
  })
})

/** The branches `createBranch` made, in order. */
const created = (fake: FakeGithub) => fake.answered('createBranch').map(([branch]) => branch)
/** A repository that already has the integration and pre-release branches. */
const prepared = () => {
  const fake = new FakeGithub()
  fake.repo('o/r').prepare()
  return fake
}

describe('ensureBranches', () => {
  it('creates the integration and the pre-release branch from the head of the default branch', async () => {
    const fake = new FakeGithub()
    expect(await ensureBranches(fake, 'o/r', 't', { integration: 'workspace' })).toEqual([
      'workspace',
      'develop',
    ])
    expect(fake.repo('o/r').heads.get('workspace')).toBe(fake.repo('o/r').heads.get('main'))
    expect(fake.repo('o/r').heads.get('develop')).toBe(fake.repo('o/r').heads.get('main'))
  })

  it('never touches a branch that exists, and creates only the one that is missing', async () => {
    const fake = prepared()
    const before = new Map(fake.repo('o/r').heads)
    expect(await ensureBranches(fake, 'o/r', 't', { integration: 'workspace' })).toEqual([])
    expect(fake.repo('o/r').heads).toEqual(before)

    fake.repo('o/r').heads.delete('develop')
    expect(await ensureBranches(fake, 'o/r', 't', { integration: 'workspace' })).toEqual([
      'develop',
    ])
    expect(fake.repo('o/r').heads.get('workspace')).toBe('b'.repeat(40))
  })

  it('uses the branch the owner chose, whatever the default branch is called', async () => {
    const fake = new FakeGithub()
    fake.repo('o/r').defaultBranch = 'trunk'
    fake.repo('o/r').heads.set('trunk', 'f'.repeat(40))
    expect(await ensureBranches(fake, 'o/r', 't', { integration: 'staging' })).toEqual([
      'staging',
      'develop',
    ])
    expect(fake.repo('o/r').heads.get('staging')).toBe('f'.repeat(40))
  })

  it('refuses the default branch as the integration branch, because only a release reaches it', async () => {
    const fake = new FakeGithub()
    await expect(ensureBranches(fake, 'o/r', 't', { integration: 'main' })).rejects.toThrow(
      /cannot be main.*only a release reaches/,
    )
    expect(created(fake)).toEqual([])
  })

  it('refuses a repository whose default branch has no commits', async () => {
    const fake = new FakeGithub()
    fake.repo('o/r').heads.clear()
    await expect(ensureBranches(fake, 'o/r', 't', { integration: 'workspace' })).rejects.toThrow(
      /no commits/,
    )
  })

  it('does not create the pre-release branch twice when it is also the integration branch', async () => {
    const fake = new FakeGithub()
    expect(await ensureBranches(fake, 'o/r', 't', { integration: 'develop' })).toEqual(['develop'])
  })
})

describe('the release branch', () => {
  it('is the default branch unless the owner named another', async () => {
    const fake = new FakeGithub()
    fake.repo('o/r').defaultBranch = 'trunk'
    expect(await releaseBranchOf(fake, 'o/r', 't', {})).toBe('trunk')
    expect(await releaseBranchOf(fake, 'o/r', 't', { releaseBranch: null })).toBe('trunk')
    expect(await releaseBranchOf(fake, 'o/r', 't', { releaseBranch: 'main' })).toBe('main')
  })

  it('is where the other branches are created from, when the owner named it', async () => {
    const fake = new FakeGithub()
    fake.repo('o/r').defaultBranch = 'develop'
    fake.repo('o/r').heads.set('develop', 'd'.repeat(40))
    fake.repo('o/r').heads.set('main', 'e'.repeat(40))
    fake.repo('o/r').heads.delete('develop')
    expect(
      await ensureBranches(fake, 'o/r', 't', { integration: 'workspace', release: 'main' }),
    ).toEqual(['workspace', 'develop'])
    expect(fake.repo('o/r').heads.get('workspace')).toBe('e'.repeat(40))
  })

  it('refuses a repository whose default branch is the pre-release branch until another is named', async () => {
    const fake = new FakeGithub()
    fake.repo('o/r').defaultBranch = 'develop'
    fake.repo('o/r').heads.set('develop', 'd'.repeat(40))
    await expect(ensureBranches(fake, 'o/r', 't', { integration: 'workspace' })).rejects.toThrow(
      /default branch is develop.*name another release branch/,
    )
    expect(created(fake)).toEqual([])
  })

  it('refuses the named release branch as the integration branch and as the pre-release branch', async () => {
    const fake = prepared()
    await expect(
      ensureBranches(fake, 'o/r', 't', { integration: 'workspace', release: 'workspace' }),
    ).rejects.toThrow(/only a release reaches/)
    await expect(
      ensureBranches(fake, 'o/r', 't', { integration: 'workspace', release: 'develop' }),
    ).rejects.toThrow(/name another release branch/)
  })

  it('refuses a release branch with no commits', async () => {
    const fake = new FakeGithub()
    await expect(
      ensureBranches(fake, 'o/r', 't', { integration: 'workspace', release: 'missing' }),
    ).rejects.toThrow(/release branch missing has no commits/)
  })
})
