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

/**
 * Makes sure the integration and pre-release branches exist, creating each from the head of the default
 * branch when it does not. A branch that exists is never touched. The default branch is the release
 * branch, so it is refused as an integration branch: the factory merges there without asking anyone,
 * and a release is the one thing that needs a decision. Returns the branches it created.
 */
export async function ensureBranches(
  api: Pick<GithubApi, 'defaultBranch' | 'branchHead' | 'createBranch'>,
  repo: string,
  token: string,
  integration: string,
): Promise<string[]> {
  const release = await api.defaultBranch(repo, token)
  if (integration === release) {
    throw new Error(
      `${repo}: the branch work is integrated into cannot be ${release}, the default branch, which only a release reaches`,
    )
  }
  const head = await api.branchHead(repo, token, release)
  if (!head) throw new Error(`${repo}: the default branch ${release} has no commits to branch from`)
  const created: string[] = []
  for (const branch of [integration, PRE_RELEASE_BRANCH]) {
    if (branch === release || (await api.branchHead(repo, token, branch))) continue
    await api.createBranch(repo, token, branch, head)
    created.push(branch)
  }
  return created
}
