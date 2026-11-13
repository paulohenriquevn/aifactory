import { describe, expect, it } from 'vitest'

import { FakeGithub } from '../../test/fake-github'

import { publishedPackagesChanged, versionedTags } from './changed-packages'

/** What a fake GitHub was asked to read, as `ref:path`. */
const readsOf = (api: FakeGithub) => api.callsTo('readFile').map(([path, ref]) => `${ref}:${path}`)

/** A repository on GitHub: what each file on `develop` holds. */
function repository(files: Record<string, string>) {
  const api = new FakeGithub()
  api.repo('o/r').files('develop', files)
  return { api, reads: () => readsOf(api) }
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
    expect(reads().sort()).toEqual([
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
    const { api } = repository(theokit)
    const files = changed('packages/ui/a.ts')
    // The manifest is deleted between the listing that named it and the read.
    api.before(
      'readFile',
      (_call, repo) => void repo.tree('develop')?.delete('packages/ui/package.json'),
    )

    await expect(
      publishedPackagesChanged(api, 'o/r', 't', { head: 'develop', files }),
    ).rejects.toThrow('packages/ui/package.json is not on develop of o/r')
  })
})

describe('versionedTags', () => {
  /** The Version Packages merge `vm`: each file as it is on its first parent and on the merge. */
  function merge(files: Record<string, { before?: string; after?: string }>) {
    const api = new FakeGithub()
    const side = (pick: (f: { before?: string; after?: string }) => string | undefined) =>
      Object.fromEntries(
        Object.entries(files).flatMap(([path, f]) => {
          const content = pick(f)
          return content === undefined ? [] : [[path, content]]
        }),
      )
    api
      .repo('o/r')
      .files(
        'vm^',
        side((f) => f.before),
      )
      .files(
        'vm',
        side((f) => f.after),
      )
    return {
      api,
      reads: () => readsOf(api),
      compared: () => api.callsTo('changedFiles').map(([base, head]) => `${base}...${head}`),
    }
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
    expect(compared()).toEqual(['vm^...vm'])
  })

  it('reads each manifest on the merge and on its first parent', async () => {
    const { api, reads } = merge({
      'package.json': {
        before: '{"name":"one","version":"1.0.0"}',
        after: '{"name":"one","version":"1.1.0"}',
      },
    })

    expect(await versionedTags(api, 'o/r', 't', 'vm')).toEqual(['one@1.1.0'])
    expect(reads().sort()).toEqual(['vm:package.json', 'vm^:package.json'])
  })

  it('skips a manifest the merge removed', async () => {
    const { api, reads } = merge({
      'packages/old/package.json': { before: '{"name":"old","version":"1.0.0"}' },
    })

    expect(await versionedTags(api, 'o/r', 't', 'vm')).toEqual([])
    expect(reads()).toEqual([])
  })
})
