import { sql } from 'drizzle-orm'

import type { Database } from '../db'
import { repository } from '../db/schema'
import type { FetchLike, GithubApp } from '../github/app'

/**
 * What the assistant may read of a repository: the files that say how a project is built and tested,
 * and nothing of its source. They go to a model provider, so the allowlist is the limit, and a file
 * that is not on it is refused whatever the model asks for.
 */
const NAMES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  '.nvmrc',
  '.node-version',
  '.tool-versions',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'tox.ini',
  'pytest.ini',
  'pipfile',
  'makefile',
  'justfile',
  'cargo.toml',
  'go.mod',
  'gemfile',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
])
const README = /^readme(\.[a-z]+)?$/
const REQUIREMENTS = /^requirements[\w.-]*\.txt$/
const WORKFLOW = /^\.github\/workflows\/[\w.-]+\.ya?ml$/

/** A path the assistant may read: no climbing out, and only a build or test file. */
export function readable(path: string): boolean {
  if (path.includes('..') || path.startsWith('/') || path.includes('\0')) return false
  if (WORKFLOW.test(path)) return true
  const name = (path.split('/').pop() ?? '').toLowerCase()
  return NAMES.has(name) || README.test(name) || REQUIREMENTS.test(name)
}

const MAX_FILE = 20_000
const MAX_TREE = 300
const SKIPPED =
  /(^|\/)(node_modules|\.git|dist|build|\.next|\.venv|venv|__pycache__|target|vendor)\//

export type ReaderDeps = {
  db: Database
  github: Pick<GithubApp, 'installationToken'>
  fetch?: FetchLike
}

/** The repository's name as stored, and the branch the owner works on, which the assistant reads too. */
async function enabled(db: Database, fullName: string): Promise<{ name: string; ref: string }> {
  const [row] = await db
    .select()
    .from(repository)
    .where(sql`lower(${repository.fullName}) = lower(${fullName})`)
  if (!row?.enabled) throw new Error(`${fullName} is not a repository the factory works in`)
  return { name: row.fullName, ref: row.baseBranch ?? 'HEAD' }
}

const headers = (token: string) => ({
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  authorization: `Bearer ${token}`,
})

/** The names of the files in a repository, without what a build leaves behind. Names only. */
export async function repoTree(deps: ReaderDeps, fullName: string): Promise<string[]> {
  const { name, ref } = await enabled(deps.db, fullName)
  const { token } = await deps.github.installationToken(name)
  const response = await (deps.fetch ?? ((url, init) => fetch(url, init)))(
    `https://api.github.com/repos/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { headers: headers(token) },
  )
  if (!response.ok) throw new Error(`GitHub answered ${response.status} listing ${name}`)
  const body = (await response.json()) as { tree: { path: string; type: string }[] }
  return body.tree
    .filter((entry) => entry.type === 'blob' && !SKIPPED.test(`${entry.path}`))
    .map((entry) => entry.path)
    .slice(0, MAX_TREE)
}

/** One build or test file of a repository, cut to a size a model can read. */
export async function repoFile(deps: ReaderDeps, fullName: string, path: string): Promise<string> {
  if (!readable(path)) {
    throw new Error(`${path} is not a file the assistant may read: only build and test files are`)
  }
  const { name, ref } = await enabled(deps.db, fullName)
  const { token } = await deps.github.installationToken(name)
  const branch = ref === 'HEAD' ? '' : `?ref=${encodeURIComponent(ref)}`
  const response = await (deps.fetch ?? ((url, init) => fetch(url, init)))(
    `https://api.github.com/repos/${name}/contents/${path.split('/').map(encodeURIComponent).join('/')}${branch}`,
    { headers: { ...headers(token), accept: 'application/vnd.github.raw+json' } },
  )
  if (response.status === 404) throw new Error(`${path} does not exist in ${name}`)
  if (!response.ok) throw new Error(`GitHub answered ${response.status} reading ${name}/${path}`)
  return (await response.text()).slice(0, MAX_FILE)
}
