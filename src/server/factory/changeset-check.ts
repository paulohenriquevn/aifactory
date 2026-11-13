import type { SandboxBackend } from '@theokit/agents/sandbox'

import { CHANGESET_CHECK_PATH } from './changesets'
import type { CheckSpec } from './evidence'

/**
 * The factory's changeset check, as the script a sandbox runs: `node <script> origin/<integration branch>`
 * in the clone, on the commit under verification. It needs node and git and nothing the repository
 * installs. It reads the files the work changed since its merge base with the integration branch and
 * answers with its exit code:
 *
 * - 1 when a file under a published package changed and no changeset the work added names that package,
 *   naming the package and the files;
 * - 1 when the work added a changeset that names no package, naming the file and saying to delete it;
 * - 2 when it could not read the range or `.changeset/config.json`, which is never a pass;
 * - 0 otherwise, so a change only to private packages, ignored ones or no package needs no changeset.
 *
 * It follows the rules the release reads on GitHub (`publishedTouched`, `isIgnored` and `changesetPackages`
 * in `changesets.ts`): a package is published when its manifest has a name, is not `"private": true` and is
 * not in `ignore` of `.changeset/config.json`, and a file belongs to every package it is under. A file under
 * several published packages (a fixture with a manifest of its own) is covered when a changeset names any
 * of them. A manifest that is not JSON is no package: nothing publishes it. This is a second writing of
 * those rules, in the JavaScript a sandbox can run, so a change to one side goes into the other;
 * `changeset-check.test.ts` runs the script on real repositories.
 */
export const CHANGESET_CHECK_SCRIPT = String.raw`import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const since = process.argv[2]
const CHANGESET = /^\.changeset\/[^/]+\.md$/
const MANIFEST = 'package.json'

/** The check could not run. That is never a pass. */
function stop(message) {
  console.error('error ' + message)
  console.error('Nothing was verified: this is not a pass.')
  process.exit(2)
}

function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return stop('git ' + args.join(' ') + ' failed: ' + error.message)
  }
}

const list = (text) => text.split('\0').filter(Boolean)

function json(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** The packages a changeset names: the "name: bump" lines of its front matter. */
function named(text) {
  const [first, ...rest] = text.trimStart().split(/\r?\n/)
  const end = rest.findIndex((line) => line.trim() === '---')
  if (first.trim() !== '---' || end === -1) return []
  return rest.slice(0, end).flatMap((line) => {
    const colon = line.lastIndexOf(':')
    const name = line.slice(0, Math.max(colon, 0)).trim().replace(/^["']|["']$/g, '')
    return name !== '' && line.slice(colon + 1).trim() !== '' ? [name] : []
  })
}

const escaped = (text) => text.replace(/[.+?^$()|[\]{}\\]/g, '\\$&')

/** A star in an ignore pattern stands for any part of a name that has no slash. */
const ignored = (name, patterns) =>
  patterns.some((pattern) => new RegExp('^' + pattern.split('*').map(escaped).join('[^/]*') + '$').test(name))

const base = git('merge-base', since, 'HEAD').trim()
const diff = list(git('diff', '--name-status', '--no-renames', '-z', base, 'HEAD'))
const changes = []
for (let i = 0; i < diff.length; i += 2) changes.push({ status: diff[i], path: diff[i + 1] })

const config = json('.changeset/config.json')
if (config === undefined) stop('.changeset/config.json could not be read as JSON')
const ignore = Array.isArray(config.ignore) ? config.ignore.map(String) : []

const dirs = list(git('ls-files', '-z'))
  .filter((path) => path === MANIFEST || path.endsWith('/' + MANIFEST))
  .filter((path) => !path.split('/').includes('node_modules'))
  .map((path) => path.slice(0, -MANIFEST.length).replace(/\/$/, ''))

/** The name of the package in a directory when changesets publishes it. */
function published(dir) {
  const manifest = json(dir === '' ? MANIFEST : dir + '/' + MANIFEST)
  const name = manifest && typeof manifest.name === 'string' ? manifest.name : undefined
  return name !== undefined && manifest.private !== true && !ignored(name, ignore) ? name : undefined
}

const errors = []
const names = new Set()
for (const { status, path } of changes) {
  if (status !== 'A' || !CHANGESET.test(path) || path === '.changeset/README.md') continue
  const found = named(readFileSync(path, 'utf8'))
  for (const name of found) names.add(name)
  if (found.length === 0) {
    errors.push(
      path +
        ' names no package, so it releases nothing and the release workflow fails on it. Delete it: a change to a private or ignored package needs no changeset, and is recorded in that package\'s CHANGELOG.md.',
    )
  }
}

/** The files no changeset covers, under the published packages each is in. */
const uncovered = new Map()
const changed = new Set()
for (const { path } of changes) {
  const owners = dirs
    .filter((dir) => dir === '' || path.startsWith(dir + '/'))
    .map(published)
    .filter((name) => name !== undefined)
    .sort()
  for (const name of owners) changed.add(name)
  if (owners.length === 0 || owners.some((name) => names.has(name))) continue
  const key = owners.join(' or ')
  uncovered.set(key, { first: owners[0], files: [...(uncovered.get(key)?.files ?? []), path] })
}
for (const [packages, { first, files }] of uncovered) {
  const more = files.length > 3 ? ' and ' + (files.length - 3) + ' more' : ''
  errors.push(
    'No changeset added since ' + since + ' names ' + packages + ', which is published and changed (' +
      files.slice(0, 3).join(', ') + more + '). Add a .changeset/*.md file whose front matter has the line "' +
      first + '": patch (or minor, or major).',
  )
}

if (errors.length > 0) {
  for (const message of errors) console.error('error ' + message)
  process.exit(1)
}
console.log(
  changed.size === 0
    ? 'changeset check passed: no published package changed, so no changeset is needed.'
    : 'changeset check passed: a changeset names each published package that changed (' + [...changed].sort().join(', ') + ').',
)
`

/**
 * Writes the script into the sandbox when one of the checks runs it. Done before every round of checks:
 * a sandbox restored from a snapshot may not have it, and an agent may have changed the copy that was there.
 */
export async function uploadChangesetCheck(
  backend: SandboxBackend,
  checks: CheckSpec[],
): Promise<void> {
  if (!checks.some((check) => check.command.startsWith(`node ${CHANGESET_CHECK_PATH} `))) return
  await backend.uploadFile(CHANGESET_CHECK_PATH, CHANGESET_CHECK_SCRIPT)
}
