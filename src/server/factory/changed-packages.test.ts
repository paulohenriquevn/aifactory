import { describe, expect, it } from 'vitest'

import type { GithubApi } from '../github/pulls'

import { publishedPackagesChanged } from './changed-packages'

/** A repository on GitHub: the files `head` changes, and what each file on `head` holds. */
function repository(changed: string[], files: Record<string, string>) {
  const reads: string[] = []
  const asked: string[] = []
  const api = {
    changedFiles: async (_repo: string, _token: string, base: string, head: string) => {
      asked.push(`${base}...${head}`)
      return changed
    },
    filePaths: async () => Object.keys(files),
    readFile: async (_repo: string, _token: string, path: string, ref: string) => {
      reads.push(`${ref}:${path}`)
      return files[path]
    },
  } as unknown as GithubApi
  return { api, reads, asked }
}

const theokit = {
  'package.json': '{"name":"theokit-monorepo","private":true}',
  '.changeset/config.json': '{"ignore":["theoclaw"]}',
  'packages/ui/package.json': '{"name":"@theokit/ui"}',
  'apps/theoclaw/package.json': '{"name":"theoclaw"}',
}
const branches = { base: 'main', head: 'develop' }

describe('publishedPackagesChanged', () => {
  it('is nothing for a change only to an ignored package and the private root', async () => {
    const { api, asked } = repository(['apps/theoclaw/a.ts', 'pnpm-lock.yaml'], theokit)

    expect(await publishedPackagesChanged(api, 'o/r', 't', branches)).toEqual([])
    expect(asked).toEqual(['main...develop'])
  })

  it('names a published package the change touches, reading only the manifests it needs, on the head', async () => {
    const { api, reads } = repository(['packages/ui/src/a.ts'], theokit)

    expect(await publishedPackagesChanged(api, 'o/r', 't', branches)).toEqual(['@theokit/ui'])
    expect(reads.sort()).toEqual([
      'develop:.changeset/config.json',
      'develop:package.json',
      'develop:packages/ui/package.json',
    ])
  })

  it('fails, naming the file, when a manifest the listing named cannot be read', async () => {
    const listed = repository(['packages/ui/a.ts'], theokit)
    const gone = {
      ...listed.api,
      readFile: async (_r: string, _t: string, path: string) =>
        path === 'packages/ui/package.json' ? undefined : '{}',
    } as unknown as GithubApi

    await expect(publishedPackagesChanged(gone, 'o/r', 't', branches)).rejects.toThrow(
      'packages/ui/package.json is not on develop of o/r',
    )
  })
})
