import type { GithubApi } from '../server/github/pulls'

type BranchesApi = Pick<GithubApi, 'defaultBranch' | 'branchHead' | 'createBranch'>

/**
 * The branches of a repository in memory: the default branch exists and nothing else does until it is
 * created, as in a repository the factory has not worked in yet.
 */
export class FakeBranches {
  readonly heads = new Map<string, string>([['main', 'a'.repeat(40)]])
  defaultName = 'main'
  /** The branches `createBranch` made, in order. */
  readonly created: string[] = []

  readonly api: BranchesApi = {
    defaultBranch: async () => this.defaultName,
    branchHead: async (_repo, _token, branch) => this.heads.get(branch),
    createBranch: async (_repo, _token, branch, sha) => {
      this.heads.set(branch, sha)
      this.created.push(branch)
    },
  }

  /** A repository that already has the integration and pre-release branches. */
  static prepared(): FakeBranches {
    const fake = new FakeBranches()
    fake.heads.set('workspace', 'b'.repeat(40))
    fake.heads.set('develop', 'c'.repeat(40))
    return fake
  }
}
