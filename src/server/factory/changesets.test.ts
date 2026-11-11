import { describe, expect, it } from 'vitest'

import {
  CHANGESET_CHECK,
  changesetsOn,
  isPackageTag,
  versionBranchFor,
  withChangesetCheck,
} from './changesets'

describe('changesetsOn', () => {
  it('is nothing for a repository without a .changeset directory or without its config', () => {
    expect(changesetsOn(undefined)).toEqual({ uses: false, pending: [] })
    expect(changesetsOn(['README.md', 'brave-fox.md'])).toEqual({ uses: false, pending: [] })
  })

  it('lists the changesets waiting to be applied, which are the markdown files but the README', () => {
    expect(changesetsOn(['config.json', 'README.md', 'brave-fox.md', 'pre.json'])).toEqual({
      uses: true,
      pending: ['brave-fox.md'],
    })
    expect(changesetsOn(['config.json', 'README.md'])).toEqual({ uses: true, pending: [] })
  })
})

describe('versionBranchFor', () => {
  it('is the branch changesets/action opens its Version Packages pull request from', () => {
    expect(versionBranchFor('main')).toBe('changeset-release/main')
  })
})

describe('isPackageTag', () => {
  it('recognises the tags changesets publishes, scoped or not', () => {
    expect(isPackageTag('@theokit/ui@1.13.0')).toBe(true)
    expect(isPackageTag('theokit@3.0.19')).toBe(true)
    expect(isPackageTag('@theokit/sdk@5.14.0-next.1')).toBe(true)
  })

  it('leaves out a version tag of its own and the factory pre-releases', () => {
    expect(isPackageTag('v1.3.0')).toBe(false)
    expect(isPackageTag('pre/172-9095546')).toBe(false)
  })

  it('takes only a whole tag of that shape, with versions of more than one digit', () => {
    expect(isPackageTag('@theokit/gateway-slack@10.2.3')).toBe(true)
    expect(isPackageTag('release notes for @theokit/ui@1.13.0')).toBe(false)
    expect(isPackageTag('@theokit/ui@1.13.0 (draft)')).toBe(false)
  })
})

describe('withChangesetCheck', () => {
  const checks = [{ name: 'install', command: 'pnpm install --frozen-lockfile' }]

  it('adds the changeset check, against the integration branch, when the repository uses changesets', () => {
    expect(withChangesetCheck(checks, true, 'workspace')).toEqual([
      ...checks,
      { name: CHANGESET_CHECK, command: 'pnpm exec changeset status --since=origin/workspace' },
    ])
  })

  it('leaves the checks alone when the repository does not use changesets', () => {
    expect(withChangesetCheck(checks, false, 'workspace')).toBe(checks)
  })

  it('does not add it twice when the owner already lists a check of that name', () => {
    const own = [...checks, { name: CHANGESET_CHECK, command: 'pnpm changeset status' }]
    expect(withChangesetCheck(own, true, 'workspace')).toBe(own)
  })
})
