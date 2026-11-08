import type { GithubApi } from '../github/pulls'

/**
 * The three branches every repository the factory works in has, and what each one is for:
 *
 * - the integration branch (`workspace`): every item that passed its checks and its review is merged
 *   here by the factory, with nobody's approval;
 * - the pre-release branch (`develop`): it advances to the integration branch after each integration,
 *   and each of those commits gets a pre-release;
 * - the release branch, which is the repository's default branch (`main`): only a release reaches it.
 */
export const INTEGRATION_BRANCH = 'workspace'
export const PRE_RELEASE_BRANCH = 'develop'

/** The branch work starts from and pull requests target: the owner's choice, or `workspace`. */
export const integrationBranch = (config: { baseBranch?: string | null }): string =>
  config.baseBranch ?? INTEGRATION_BRANCH

/** The branch a release lands on: the owner's choice, or the repository's default branch. */
export async function releaseBranchOf(
  api: Pick<GithubApi, 'defaultBranch'>,
  repo: string,
  token: string,
  config: { releaseBranch?: string | null },
): Promise<string> {
  return config.releaseBranch ?? (await api.defaultBranch(repo, token))
}

/**
 * Makes sure the integration and pre-release branches exist, creating each from the head of the release
 * branch when it does not. A branch that exists is never touched. The release branch is the repository's
 * default branch unless the owner named another (a repository whose default branch is `develop` names
 * `main`). It is refused as the integration branch and as the pre-release branch: the factory merges into
 * both without asking anyone, and a release is the one thing that needs a decision. Returns the branches
 * it created.
 */
export async function ensureBranches(
  api: Pick<GithubApi, 'defaultBranch' | 'branchHead' | 'createBranch'>,
  repo: string,
  token: string,
  branches: { integration: string; release?: string | null },
): Promise<string[]> {
  const { integration } = branches
  const release = await releaseBranchOf(api, repo, token, { releaseBranch: branches.release })
  if (integration === release) {
    throw new Error(
      `${repo}: the branch work is integrated into cannot be ${release}, the release branch, which only a release reaches`,
    )
  }
  if (PRE_RELEASE_BRANCH === release) {
    throw new Error(
      `${repo}: its default branch is ${release}, which is where the pre-release goes: name another release branch for it`,
    )
  }
  const head = await api.branchHead(repo, token, release)
  if (!head) throw new Error(`${repo}: the release branch ${release} has no commits to branch from`)
  const created: string[] = []
  for (const branch of [integration, PRE_RELEASE_BRANCH]) {
    if (await api.branchHead(repo, token, branch)) continue
    await api.createBranch(repo, token, branch, head)
    created.push(branch)
  }
  return created
}
