import { describe, expect, it } from 'vitest'

import { FakeBranches } from '../../test/fake-branches'

import {
  ensureBranches,
  INTEGRATION_BRANCH,
  integrationBranch,
  PRE_RELEASE_BRANCH,
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

describe('ensureBranches', () => {
  it('creates the integration and the pre-release branch from the head of the default branch', async () => {
    const fake = new FakeBranches()
    expect(await ensureBranches(fake.api, 'o/r', 't', 'workspace')).toEqual([
      'workspace',
      'develop',
    ])
    expect(fake.heads.get('workspace')).toBe(fake.heads.get('main'))
    expect(fake.heads.get('develop')).toBe(fake.heads.get('main'))
  })

  it('never touches a branch that exists, and creates only the one that is missing', async () => {
    const fake = FakeBranches.prepared()
    const before = new Map(fake.heads)
    expect(await ensureBranches(fake.api, 'o/r', 't', 'workspace')).toEqual([])
    expect(fake.heads).toEqual(before)

    fake.heads.delete('develop')
    expect(await ensureBranches(fake.api, 'o/r', 't', 'workspace')).toEqual(['develop'])
    expect(fake.heads.get('workspace')).toBe('b'.repeat(40))
  })

  it('uses the branch the owner chose, whatever the default branch is called', async () => {
    const fake = new FakeBranches()
    fake.defaultName = 'trunk'
    fake.heads.set('trunk', 'f'.repeat(40))
    expect(await ensureBranches(fake.api, 'o/r', 't', 'staging')).toEqual(['staging', 'develop'])
    expect(fake.heads.get('staging')).toBe('f'.repeat(40))
  })

  it('refuses the default branch as the integration branch, because only a release reaches it', async () => {
    const fake = new FakeBranches()
    await expect(ensureBranches(fake.api, 'o/r', 't', 'main')).rejects.toThrow(
      /cannot be main.*only a release reaches/,
    )
    expect(fake.created).toEqual([])
  })

  it('refuses a repository whose default branch has no commits', async () => {
    const fake = new FakeBranches()
    fake.heads.clear()
    await expect(ensureBranches(fake.api, 'o/r', 't', 'workspace')).rejects.toThrow(/no commits/)
  })

  it('does not create the pre-release branch twice when it is also the integration branch', async () => {
    const fake = new FakeBranches()
    expect(await ensureBranches(fake.api, 'o/r', 't', 'develop')).toEqual(['develop'])
  })
})
