import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validBranch } from '../factory/repo-config'

import { assertRepository } from './format'
import { KnowledgeGitError, runGit, type Git } from './git'

const SHA = /^[0-9a-f]{40}$/

/** The other side moved, so a push that is not a fast-forward was refused. The next pass fetches and retries. */
export class PushRejected extends Error {}

export type TreeFile = { path: string; size: number }

/** Where the mirror of one knowledge repository lives on the factory host. */
export function mirrorDir(root: string, repository: string): string {
  assertRepository(repository)
  const [owner, name] = repository.split('/')
  return join(root, owner, `${name}.git`)
}

function assertBranch(branch: string) {
  if (!validBranch(branch))
    throw new Error(`not a branch name git can take: ${JSON.stringify(branch)}`)
}

function assertSha(sha: string) {
  if (!SHA.test(sha)) throw new Error(`not a commit id: ${JSON.stringify(sha)}`)
}

const missingRemoteRef = (error: unknown) =>
  error instanceof KnowledgeGitError && /couldn't find remote ref/i.test(error.stderr)

/**
 * A bare clone of the knowledge repository on the factory host, the one place the factory fetches from.
 * Every agent reads what is here, at a commit, and nothing in it is a checkout anyone edits: notes are
 * written as commits with git's plumbing, so no working tree is ever involved.
 */
export class Mirror {
  constructor(
    readonly dir: string,
    private readonly git: Git = runGit,
  ) {}

  private run(args: string[], options?: Parameters<Git>[1]) {
    return this.git(['-C', this.dir, ...args], options)
  }

  async ensure(): Promise<void> {
    if (existsSync(join(this.dir, 'HEAD'))) return
    mkdirSync(this.dir, { recursive: true })
    await this.git(['init', '--bare', '--quiet', this.dir])
  }

  /** The commit a local branch is at, or undefined when the mirror does not have it. */
  async head(branch: string): Promise<string | undefined> {
    assertBranch(branch)
    try {
      return (await this.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]))
        .toString()
        .trim()
    } catch (error) {
      if (error instanceof KnowledgeGitError && error.exitCode === 1) return undefined
      throw error
    }
  }

  /**
   * Brings one branch of the remote into the mirror, even when it was rewritten, and returns its commit.
   * A branch the remote does not have is removed here too and gives undefined.
   */
  async fetch(url: string, branch: string, token?: string): Promise<string | undefined> {
    assertBranch(branch)
    try {
      await this.run(
        ['fetch', '--quiet', '--no-tags', url, `+refs/heads/${branch}:refs/heads/${branch}`],
        { token },
      )
    } catch (error) {
      if (!missingRemoteRef(error)) throw error
      if (await this.head(branch)) await this.run(['update-ref', '-d', `refs/heads/${branch}`])
      return undefined
    }
    return this.head(branch)
  }

  /** The files at a commit under some paths (a path ending in `/` is a folder), with their sizes. */
  async list(sha: string, paths: string[]): Promise<TreeFile[]> {
    assertSha(sha)
    const out = await this.run(['ls-tree', '-r', '-l', '-z', '--full-tree', sha, '--', ...paths])
    return out
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .flatMap((entry) => {
        const [meta, path] = entry.split('\t')
        const [, type, , size] = meta.split(/\s+/)
        return type === 'blob' ? [{ path, size: Number(size) }] : []
      })
  }

  /** One file at a commit, or undefined when there is none at that path. */
  async read(sha: string, path: string): Promise<Buffer | undefined> {
    assertSha(sha)
    const [found] = await this.list(sha, [path])
    if (found?.path !== path) return undefined
    return this.run(['cat-file', 'blob', `${sha}:${path}`])
  }

  /**
   * Writes a commit with these files laid over the parent's tree (or on an empty one), without touching any
   * branch. A path is written as given; the callers build every path the factory writes.
   */
  async commit(input: {
    parent?: string
    files: { path: string; content: string }[]
    message: string
    author: { name: string; email: string }
    date: Date
  }): Promise<string> {
    if (input.parent) assertSha(input.parent)
    const scratch = mkdtempSync(join(tmpdir(), 'knowledge-index-'))
    const env = {
      GIT_INDEX_FILE: join(scratch, 'index'),
      GIT_AUTHOR_NAME: input.author.name,
      GIT_AUTHOR_EMAIL: input.author.email,
      GIT_COMMITTER_NAME: input.author.name,
      GIT_COMMITTER_EMAIL: input.author.email,
      GIT_AUTHOR_DATE: input.date.toISOString(),
      GIT_COMMITTER_DATE: input.date.toISOString(),
    }
    try {
      await this.run(input.parent ? ['read-tree', input.parent] : ['read-tree', '--empty'], { env })
      const lines: string[] = []
      for (const file of input.files) {
        const blob = (await this.run(['hash-object', '-w', '--stdin'], { input: file.content }))
          .toString()
          .trim()
        lines.push(`100644 blob ${blob}\t${file.path}`)
      }
      await this.run(['update-index', '--index-info'], { env, input: `${lines.join('\n')}\n` })
      const tree = (await this.run(['write-tree'], { env })).toString().trim()
      const parents = input.parent ? ['-p', input.parent] : []
      return (
        await this.run(['commit-tree', tree, ...parents, '-F', '-'], { env, input: input.message })
      )
        .toString()
        .trim()
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  /**
   * Sends a commit to a branch of the remote. Without `force` the remote refuses anything but a
   * fast-forward, and that refusal is a `PushRejected`.
   */
  async push(
    url: string,
    commit: string,
    branch: string,
    options: { token?: string; force?: boolean } = {},
  ): Promise<void> {
    assertSha(commit)
    assertBranch(branch)
    const spec = `${options.force ? '+' : ''}${commit}:refs/heads/${branch}`
    try {
      await this.run(['push', '--quiet', '--no-verify', url, spec], { token: options.token })
    } catch (error) {
      if (
        error instanceof KnowledgeGitError &&
        /\[rejected\]|non-fast-forward|fetch first/.test(error.stderr)
      ) {
        throw new PushRejected(
          `the remote ${branch} moved; the next pass fetches it and tries again`,
        )
      }
      throw error
    }
  }

  /** Points a local branch at a commit the remote now has. */
  async setHead(branch: string, commit: string): Promise<void> {
    assertBranch(branch)
    assertSha(commit)
    await this.run(['update-ref', `refs/heads/${branch}`, commit])
  }
}
