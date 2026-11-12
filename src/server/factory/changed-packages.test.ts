import { describe, expect, it } from 'vitest'

import type { GithubApi } from '../github/pulls'

import { publishedPackagesChanged } from './changed-packages'

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
