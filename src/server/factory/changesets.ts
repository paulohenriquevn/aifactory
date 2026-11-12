import type { OpenPullRequest } from '../github/pulls'

import type { CheckSpec } from './evidence'

/**
 * Repositories that publish with changesets (https://github.com/changesets/changesets): the version comes
 * from `.changeset/*.md` files, changesets/action opens a "Version Packages" pull request that applies them,
 * and merging that pull request is what publishes the packages and tags them. In such a repository the
 * factory makes no tag of its own: a release is the promotion to the release branch, then that merge.
 */

/** What `.changeset` holds on a branch: whether the repository uses changesets, and what waits to ship. */
export type ChangesetState = { uses: boolean; pending: string[] }

/** Reads a listing of `.changeset` (undefined when the directory is missing). */
export function changesetsOn(names: string[] | undefined): ChangesetState {
  if (!names?.includes('config.json')) return { uses: false, pending: [] }
  return {
    uses: true,
    pending: names.filter((name) => name.endsWith('.md') && name !== 'README.md'),
  }
}

/** What changesets reads of a package: its name, and whether it is kept off the registry. */
export type PackageManifest = { name: string | undefined; private: boolean }

const MANIFEST = 'package.json'

/** The directory of every package.json in a listing of a branch, `''` for the root. */
export function packageDirs(paths: string[]): string[] {
  return paths
    .filter((path) => path === MANIFEST || path.endsWith(`/${MANIFEST}`))
    .filter((path) => !path.split('/').includes('node_modules'))
    .map((path) => path.slice(0, -MANIFEST.length).replace(/\/$/, ''))
}

/** Every package directory a file is under, in the order given; the root, `''`, holds every file. */
export function enclosingPackages(file: string, dirs: string[]): string[] {
  return dirs.filter((dir) => dir === '' || file.startsWith(`${dir}/`))
}

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether a package name is in the `ignore` list of `.changeset/config.json`. A star stands for any part
 * of a name that has no slash, so `@theokit/example-*` holds the scope's examples and nothing else.
 */
export function isIgnored(name: string, ignore: string[]): boolean {
  return ignore.some((pattern) =>
    new RegExp(`^${pattern.split('*').map(escape).join('[^/]*')}$`).test(name),
  )
}

function parseJson(text: string, file: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Reads the package.json of the package in `dir`. */
export function parseManifest(text: string, dir: string): PackageManifest {
  const json = parseJson(text, dir ? `${dir}/${MANIFEST}` : MANIFEST)
  return {
    name: typeof json.name === 'string' ? json.name : undefined,
    private: json.private === true,
  }
}

/** The packages `.changeset/config.json` tells changesets to leave alone. */
export function changesetIgnore(text: string): string[] {
  const ignore = parseJson(text, '.changeset/config.json').ignore
  return Array.isArray(ignore) ? ignore.map(String) : []
}

/**
 * The packages changesets publishes that the changed files touch, by name, sorted. A file belongs to every
 * package it is under, so a change inside a private fixture of a published package counts for the published
 * one, and in a repository that is one published package every file counts. A package with no name, a
 * private one and an ignored one are never published, and a file in no package touches nothing.
 */
export function publishedTouched(
  files: string[],
  manifests: Map<string, PackageManifest>,
  ignore: string[],
): string[] {
  const dirs = [...manifests.keys()]
  const names = new Set<string>()
  for (const dir of new Set(files.flatMap((file) => enclosingPackages(file, dirs)))) {
    const { name, private: kept } = manifests.get(dir)!
    if (name !== undefined && !kept && !isIgnored(name, ignore)) names.add(name)
  }
  return [...names].sort()
}

/** The branch changesets/action opens its Version Packages pull request from. */
export const versionBranchFor = (releaseBranch: string) => `changeset-release/${releaseBranch}`

/**
 * The back-merge a repository's own workflow opens after a release: from the release branch into the
 * integration branch, in the repository itself. Until it lands, the integration branch holds the versions
 * before the release, and a check that compares them with what was published fails on every pull request
 * into it (theokit on 2026-11-11, #37). It is the one pull request into the integration branch the factory
 * merges that is not its own, so anything else, a fork's branch of the same name included, is never it.
 */
export function pickBackMerge(
  open: OpenPullRequest[],
  branches: { repo: string; release: string; integration: string },
): OpenPullRequest | undefined {
  return open.find(
    (pr) =>
      pr.headRef === branches.release &&
      pr.baseRef === branches.integration &&
      pr.headRepo === branches.repo,
  )
}

/** A tag changesets makes for a published package: `name@version`, with an optional `@scope/`. */
const PACKAGE_TAG = /^(@[^/@\s]+\/)?[^/@\s]+@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

export const isPackageTag = (tag: string) => PACKAGE_TAG.test(tag)

/** The check that fails a commit changing a package without saying how its version moves. */
export const CHANGESET_CHECK = 'changeset'

/**
 * The checks with `changeset status` added when the repository uses changesets. The work starts from the
 * integration branch, so that is what it is compared with; a package changed with no changeset makes it
 * exit 1, and the agent is sent back to add one. Without it, work reached the release branch and nothing
 * was published (theokit-ui's i18n layer on 2026-11-11).
 */
export function withChangesetCheck(
  checks: CheckSpec[],
  usesChangesets: boolean,
  integrationBranch: string,
): CheckSpec[] {
  if (!usesChangesets || checks.some((c) => c.name === CHANGESET_CHECK)) return checks
  return [
    ...checks,
    {
      name: CHANGESET_CHECK,
      command: `pnpm exec changeset status --since=origin/${integrationBranch}`,
    },
  ]
}
