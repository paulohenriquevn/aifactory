import type { BranchAhead, ChangedFile, OpenPullRequest } from '../github/pulls'

import type { CheckSpec } from './evidence'
import type { MainState } from './watch'

/**
 * Repositories that publish with changesets (https://github.com/changesets/changesets): the version comes
 * from `.changeset/*.md` files, changesets/action opens a "Version Packages" pull request that applies them,
 * and merging that pull request is what publishes the packages and tags them. In such a repository the
 * factory makes no tag of its own: a release is the promotion to the release branch, then that merge.
 */

/** Whether a listing of `.changeset` (undefined when the directory is missing) holds its config. */
export const usesChangesets = (names: string[] | undefined) =>
  names?.includes('config.json') === true

const CHANGESET_FILE = /^\.changeset\/[^/]+\.md$/

/**
 * The changesets that wait to ship: the `.changeset/*.md` files, the README aside, that a comparison of the
 * pre-release branch with the release branch lists as added since their merge base. Being on the branch is
 * not enough: a release whose Version Packages pull request consumed changesets deletes them on the release
 * branch only, and with no back-merge the pre-release branch keeps them (theokit-plugins after #250).
 */
export function addedChangesets(files: ChangedFile[]): string[] {
  return files
    .filter((file) => file.status === 'added' && CHANGESET_FILE.test(file.path))
    .map((file) => file.path)
    .filter((path) => path !== '.changeset/README.md')
}

/** Every path a comparison touches, a rename by both its names. */
export const touchedPaths = (files: ChangedFile[]) =>
  files.flatMap((file) => (file.previousPath ? [file.path, file.previousPath] : [file.path]))

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

/**
 * How long a publication waits after the promotion before the checks on the promoted commit say whether its
 * release run is over. Until the run is queued its check runs do not exist, and the other checks may all have
 * completed already.
 */
export const RELEASE_RUN_GRACE_MS = 10 * 60_000

export const releaseRunGraceOver = (startedAt: Date, now: Date) =>
  now.getTime() - startedAt.getTime() >= RELEASE_RUN_GRACE_MS

/** What the checks on the promoted commit say of its release run, once no Version Packages pull request came. */
export type ReleaseRun = { finished: true } | { failed: string } | { wait: string }

/**
 * Reads the run on a promoted commit when the release workflow opened no Version Packages pull request. Every
 * check completed, none failing, means it finished and will open none. A failed one needs a person. A check
 * still running, or none reported yet, may still open one.
 */
export function releaseRunOf(seen: MainState, sha: string): ReleaseRun {
  const short = sha.slice(0, 7)
  if (seen.state === 'green') return { finished: true }
  if (seen.state === 'red') return { failed: `${seen.failing.join(', ')} failed on ${short}` }
  const why =
    seen.state === 'pending'
      ? `the checks on ${short} still run`
      : `no check has reported on ${short}`
  return { wait: `${NOT_OPENED}; ${why}` }
}

/** Why a publication waits before the release workflow opened its Version Packages pull request. */
export const NOT_OPENED =
  'no Version Packages pull request yet: the release workflow opens it after the promotion'

/** The branch changesets/action opens its Version Packages pull request from. */
export const versionBranchFor = (releaseBranch: string) => `changeset-release/${releaseBranch}`

/**
 * Whether the version branch holds versions for this publication: ahead of the release branch and committed
 * after the promotion. A release workflow that may not open pull requests (usetheokit/theokit) pushes it and
 * stops there. One committed before the promotion belongs to an earlier release.
 */
export const versionBranchWaits = (branch: BranchAhead | undefined, startedAt: Date) =>
  branch !== undefined && branch.aheadBy > 0 && branch.committedAt.getTime() > startedAt.getTime()

/** The Version Packages pull request the factory opens from a version branch the release workflow pushed. */
export function versionPullRequestFrom(releaseBranch: string, promotedSha: string) {
  const head = versionBranchFor(releaseBranch)
  return {
    head,
    base: releaseBranch,
    title: 'Version Packages',
    body: `The release workflow pushed \`${head}\` after the promotion of ${promotedSha} without opening a pull request, so the factory opened this one. Merging it lets the workflow publish the versions.`,
  }
}

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
