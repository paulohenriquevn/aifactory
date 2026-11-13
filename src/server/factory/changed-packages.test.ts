import { describe, expect, it } from 'vitest'

import type { GithubApi } from '../github/pulls'

import { publishedPackagesChanged, versionedTags } from './changed-packages'

/** A repository on GitHub: what each file on `head` holds. */
function repository(files: Record<string, string>) {
  const reads: string[] = []
  const api = {
    filePaths: async () => Object.keys(files),
    readFile: async (_repo: string, _token: string, path: string, ref: string) => {
      reads.push(`${ref}:${path}`)
      return files[path]
    },
  } as unknown as GithubApi
  return { api, reads }
}

/** What a comparison lists for files `head` changed. */
const changed = (...paths: string[]) => paths.map((path) => ({ path, status: 'modified' }))

const theokit = {
  'package.json': '{"name":"theokit-monorepo","private":true}',
  '.changeset/config.json': '{"ignore":["theoclaw"]}',
  'packages/ui/package.json': '{"name":"@theokit/ui"}',
  'apps/theoclaw/package.json': '{"name":"theoclaw"}',
}

describe('publishedPackagesChanged', () => {
  it('is nothing for a change only to an ignored package and the private root', async () => {
    const { api } = repository(theokit)
    const files = changed('apps/theoclaw/a.ts', 'pnpm-lock.yaml')

    expect(await publishedPackagesChanged(api, 'o/r', 't', { head: 'develop', files })).toEqual([])
  })

  it('names a published package the change touches, reading only the manifests it needs, on the head', async () => {
    const { api, reads } = repository(theokit)
    const files = changed('packages/ui/src/a.ts')

    expect(await publishedPackagesChanged(api, 'o/r', 't', { head: 'develop', files })).toEqual([
      '@theokit/ui',
    ])
    expect(reads.sort()).toEqual([
      'develop:.changeset/config.json',
      'develop:package.json',
      'develop:packages/ui/package.json',
    ])
  })

  it('counts the old name of a rename out of a published package', async () => {
    const { api } = repository(theokit)
    const files = [{ path: 'docs/a.ts', status: 'renamed', previousPath: 'packages/ui/a.ts' }]

    expect(await publishedPackagesChanged(api, 'o/r', 't', { head: 'develop', files })).toEqual([
      '@theokit/ui',
    ])
  })

  it('fails, naming the file, when a manifest the listing named cannot be read', async () => {
    const listed = repository(theokit)
    const files = changed('packages/ui/a.ts')
    const gone = {
      ...listed.api,
      readFile: async (_r: string, _t: string, path: string) =>
        path === 'packages/ui/package.json' ? undefined : '{}',
    } as unknown as GithubApi

    await expect(
      publishedPackagesChanged(gone, 'o/r', 't', { head: 'develop', files }),
    ).rejects.toThrow('packages/ui/package.json is not on develop of o/r')
  })
})

describe('versionedTags', () => {
  /** The Version Packages merge `vm`: each file as it is on its first parent and on the merge. */
  function merge(files: Record<string, { before?: string; after?: string }>) {
    const reads: string[] = []
    const compared: string[] = []
    const status = (f: { before?: string; after?: string }) => {
      if (f.after === undefined) return 'removed'
      return f.before === undefined ? 'added' : 'modified'
    }
    const api = {
      changedFiles: async (_repo: string, _token: string, base: string, head: string) => {
        compared.push(`${base}...${head}`)
        return Object.entries(files).map(([path, f]) => ({ path, status: status(f) }))
      },
      readFile: async (_repo: string, _token: string, path: string, ref: string) => {
        reads.push(`${ref}:${path}`)
        return ref === 'vm' ? files[path]?.after : files[path]?.before
      },
    } as unknown as GithubApi
    return { api, reads, compared }
  }

  it('is the release of every published package whose version the merge moved', async () => {
    const { api, compared } = merge({
      'packages/gateway/package.json': {
        before: '{"name":"@theokit/gateway","version":"0.16.0"}',
        after: '{"name":"@theokit/gateway","version":"0.16.1"}',
      },
      'packages/gateway/CHANGELOG.md': { before: '', after: '## 0.16.1' },
      'packages/slack/package.json': {
        before: '{"name":"@theokit/gateway-slack","version":"0.5.0"}',
        after: '{"name":"@theokit/gateway-slack","version":"0.5.1"}',
      },
      'examples/demo/package.json': {
        before: '{"name":"demo","version":"0.1.0","private":true}',
        after: '{"name":"demo","version":"0.1.1","private":true}',
      },
      'packages/kept/package.json': {
        before: '{"name":"@theokit/kept","version":"1.0.0","dependencies":{"a":"1"}}',
        after: '{"name":"@theokit/kept","version":"1.0.0","dependencies":{"a":"2"}}',
      },
      'node_modules/x/package.json': { before: '{}', after: '{"name":"x","version":"9.0.0"}' },
    })

    expect(await versionedTags(api, 'o/r', 't', 'vm')).toEqual([
      '@theokit/gateway@0.16.1',
      '@theokit/gateway-slack@0.5.1',
    ])
    expect(compared).toEqual(['vm^...vm'])
  })

  it('reads each manifest on the merge and on its first parent', async () => {
    const { api, reads } = merge({
      'package.json': {
        before: '{"name":"one","version":"1.0.0"}',
        after: '{"name":"one","version":"1.1.0"}',
      },
    })

    expect(await versionedTags(api, 'o/r', 't', 'vm')).toEqual(['one@1.1.0'])
    expect(reads.sort()).toEqual(['vm:package.json', 'vm^:package.json'])
  })

  it('skips a manifest the merge removed', async () => {
    const { api, reads } = merge({
      'packages/old/package.json': { before: '{"name":"old","version":"1.0.0"}' },
    })

    expect(await versionedTags(api, 'o/r', 't', 'vm')).toEqual([])
    expect(reads).toEqual([])
  })
})
