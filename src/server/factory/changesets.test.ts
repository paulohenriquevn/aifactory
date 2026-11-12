import { describe, expect, it } from 'vitest'

import {
  CHANGESET_CHECK,
  changesetIgnore,
  changesetsOn,
  enclosingPackages,
  isIgnored,
  packageDirs,
  parseManifest,
  publishedTouched,
  isPackageTag,
  pickBackMerge,
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

describe('pickBackMerge', () => {
  const branches = { repo: 'usetheokit/theokit', release: 'main', integration: 'workspace' }
  const backMerge = {
    number: 1738,
    url: 'https://github.com/usetheokit/theokit/pull/1738',
    headSha: 'main-head',
    headRef: 'main',
    headRepo: 'usetheokit/theokit',
    baseRef: 'workspace',
    draft: false,
  }

  it('takes the pull request from the release branch into the integration branch of the same repository', () => {
    expect(pickBackMerge([backMerge], branches)).toBe(backMerge)
  })

  it('finds it among other open pull requests', () => {
    const other = { ...backMerge, number: 1, headRef: 'factory/7' }
    expect(pickBackMerge([other, backMerge], branches)).toBe(backMerge)
  })

  it('never takes a pull request from another head into the integration branch', () => {
    expect(pickBackMerge([{ ...backMerge, headRef: 'factory/7' }], branches)).toBeUndefined()
    expect(pickBackMerge([{ ...backMerge, headRef: 'develop' }], branches)).toBeUndefined()
  })

  it('never takes the release branch into another base', () => {
    expect(pickBackMerge([{ ...backMerge, baseRef: 'develop' }], branches)).toBeUndefined()
  })

  it('never takes a release branch of the same name pushed to a fork', () => {
    expect(pickBackMerge([{ ...backMerge, headRepo: 'someone/theokit' }], branches)).toBeUndefined()
  })

  it('is nothing when no pull request is open', () => {
    expect(pickBackMerge([], branches)).toBeUndefined()
  })
})

describe('packageDirs', () => {
  it('names the directory of every package.json, the root as the empty one', () => {
    expect(
      packageDirs([
        'package.json',
        'README.md',
        'packages/ui/package.json',
        'packages/ui/src/index.ts',
        'apps/theoclaw/package.json',
      ]),
    ).toEqual(['', 'packages/ui', 'apps/theoclaw'])
  })

  it('leaves out a vendored node_modules and a file merely ending in package.json', () => {
    expect(packageDirs(['vendor/node_modules/x/package.json', 'docs/not-a-package.json'])).toEqual(
      [],
    )
  })
})

describe('enclosingPackages', () => {
  const dirs = ['', 'packages/ui', 'packages/ui/fixtures/app', 'apps/theoclaw']

  it('is every package directory a file is under, the root included', () => {
    expect(enclosingPackages('packages/ui/fixtures/app/a.ts', dirs)).toEqual([
      '',
      'packages/ui',
      'packages/ui/fixtures/app',
    ])
    expect(enclosingPackages('pnpm-lock.yaml', dirs)).toEqual([''])
  })

  it('does not take a directory that only shares a prefix with the file', () => {
    expect(enclosingPackages('packages/ui-kit/a.ts', ['packages/ui'])).toEqual([])
    expect(enclosingPackages('apps/theoclaw/src/a.ts', ['apps/theoclaw'])).toEqual([
      'apps/theoclaw',
    ])
  })

  it('is nothing for a file outside every package', () => {
    expect(enclosingPackages('docs/a.md', ['packages/ui'])).toEqual([])
  })
})

describe('isIgnored', () => {
  it('matches a name in the ignore list, exactly', () => {
    expect(isIgnored('theoclaw', ['theoclaw'])).toBe(true)
    expect(isIgnored('theoclaw-cli', ['theoclaw'])).toBe(false)
    expect(isIgnored('theoclaw', [])).toBe(false)
  })

  it('takes a star as any part of a name without a slash, as in a scope', () => {
    expect(isIgnored('@theokit/example-chat', ['@theokit/example-*'])).toBe(true)
    expect(isIgnored('@theokit/ui', ['@theokit/example-*'])).toBe(false)
    expect(isIgnored('@other/example-chat', ['@theokit/example-*'])).toBe(false)
    expect(isIgnored('@theokit/a/b', ['@theokit/*'])).toBe(false)
  })

  it('reads the other characters of a pattern literally', () => {
    expect(isIgnored('axb', ['a.b'])).toBe(false)
    expect(isIgnored('a.b', ['a.b'])).toBe(true)
  })
})

describe('parseManifest', () => {
  it('reads the name and whether the package is private', () => {
    expect(parseManifest('{"name":"theoclaw","private":true}', 'apps/theoclaw')).toEqual({
      name: 'theoclaw',
      private: true,
    })
    expect(parseManifest('{"name":"@theokit/ui"}', 'packages/ui')).toEqual({
      name: '@theokit/ui',
      private: false,
    })
  })

  it('is a package with no name, and not private, when the manifest says neither', () => {
    expect(parseManifest('{"private":"yes"}', 'x')).toEqual({ name: undefined, private: false })
    expect(parseManifest('{"name":5}', 'x')).toEqual({ name: undefined, private: false })
  })

  it('names the file when it is not JSON', () => {
    expect(() => parseManifest('{', 'packages/ui')).toThrow(
      /^packages\/ui\/package.json is not valid JSON/,
    )
    expect(() => parseManifest('{', '')).toThrow(/^package.json is not valid JSON/)
  })
})

describe('changesetIgnore', () => {
  it('reads the ignore list of .changeset/config.json, empty when there is none', () => {
    expect(changesetIgnore('{"ignore":["theoclaw"]}')).toEqual(['theoclaw'])
    expect(changesetIgnore('{"access":"public"}')).toEqual([])
  })

  it('says which file is not JSON', () => {
    expect(() => changesetIgnore('nope')).toThrow(/^\.changeset\/config.json is not valid JSON/)
  })
})

describe('publishedTouched', () => {
  const manifests = new Map([
    ['', { name: 'theokit-monorepo', private: true }],
    ['packages/ui', { name: '@theokit/ui', private: false }],
    ['packages/sdk', { name: '@theokit/sdk', private: false }],
    ['apps/theoclaw', { name: 'theoclaw', private: false }],
    ['apps/site', { name: 'site', private: true }],
    ['apps/unnamed', { name: undefined, private: false }],
  ])

  it('is nothing when every change is in an ignored or private package, or at the private root', () => {
    expect(
      publishedTouched(
        ['apps/theoclaw/src/a.ts', 'apps/site/page.tsx', 'pnpm-lock.yaml', 'apps/unnamed/x.ts'],
        manifests,
        ['theoclaw'],
      ),
    ).toEqual([])
  })

  it('names each published package a change touches, once and in order', () => {
    expect(
      publishedTouched(
        ['packages/ui/b.ts', 'apps/theoclaw/a.ts', 'packages/sdk/x.ts', 'packages/ui/a.ts'],
        manifests,
        ['theoclaw'],
      ),
    ).toEqual(['@theokit/sdk', '@theokit/ui'])
  })

  it('counts a file of a package nested in a published one as a change to the published one', () => {
    const nested = new Map([
      ...manifests,
      ['packages/ui/fixtures/app', { name: 'fixture', private: true }],
    ])
    expect(publishedTouched(['packages/ui/fixtures/app/a.ts'], nested, [])).toEqual(['@theokit/ui'])
  })

  it('takes a published root package, as in a repository that is one package', () => {
    const single = new Map([['', { name: 'tool', private: false }]])
    expect(publishedTouched(['src/a.ts'], single, [])).toEqual(['tool'])
  })

  it('is nothing for a file in no package', () => {
    expect(publishedTouched(['docs/a.md'], new Map(), [])).toEqual([])
  })
})
