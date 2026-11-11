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
