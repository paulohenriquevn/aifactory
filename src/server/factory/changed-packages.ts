import type { ChangedFile, GithubApi } from '../github/pulls'

import {
  addedChangesets,
  changesetIgnore,
  changesetPackages,
  enclosingPackages,
  isIgnored,
  packageDirs,
  parseManifest,
  publishedTouched,
  touchedPaths,
  versionedTag,
  type PackageManifest,
} from './changesets'

/** The package.json of the package in `dir`, `''` being the root. */
const manifestPath = (dir: string) => (dir ? `${dir}/package.json` : 'package.json')

/** Reads a file the listing of `ref` named; one gone between the two reads is an error, not a guess. */
async function mustRead(
  api: GithubApi,
  repo: string,
  token: string,
  path: string,
  ref: string,
): Promise<string> {
  const text = await api.readFile(repo, token, path, ref)
  if (text === undefined) throw new Error(`${path} is not on ${ref} of ${repo}`)
  return text
}

/**
 * The changesets that wait to ship: those a comparison lists as added (`addedChangesets`) that name a
 * package, each read from GitHub on the comparison's `head`. An empty one releases nothing, so a promotion
 * that carries only empty ones is not left to the repository's release workflow, which would fail on them.
 */
export async function changesetsWaiting(
  api: GithubApi,
  repo: string,
  token: string,
  compared: { head: string; files: ChangedFile[] },
): Promise<string[]> {
  const waiting: string[] = []
  for (const path of addedChangesets(compared.files)) {
    const text = await mustRead(api, repo, token, path, compared.head)
    if (changesetPackages(text).length > 0) waiting.push(path)
  }
  return waiting
}

/**
 * The packages changesets would publish that the files a comparison lists change, read from GitHub on its
 * `head`: the package.json of every package one of them is under, and the `ignore` list of
 * `.changeset/config.json`. Empty means the change is only in packages that are private or ignored, or in no
 * package at all.
 */
export async function publishedPackagesChanged(
  api: GithubApi,
  repo: string,
  token: string,
  compared: { head: string; files: ChangedFile[] },
): Promise<string[]> {
  const { head } = compared
  const files = touchedPaths(compared.files)
  const dirs = packageDirs(await api.filePaths(repo, token, head))
  const touched = [...new Set(files.flatMap((file) => enclosingPackages(file, dirs)))]
  const manifests = new Map<string, PackageManifest>()
  for (const dir of touched) {
    const path = manifestPath(dir)
    manifests.set(dir, parseManifest(await mustRead(api, repo, token, path, head), dir))
  }
  const ignore = changesetIgnore(await mustRead(api, repo, token, '.changeset/config.json', head))
  return publishedTouched(files, manifests, ignore)
}

/**
 * The releases a Version Packages merge commit calls for, as changesets tags them (`name@version`): one for
 * each published package whose version the merge moved, read from its package.json on the merge and on the
 * merge's first parent. A manifest the merge removed calls for none.
 */
export async function versionedTags(
  api: GithubApi,
  repo: string,
  token: string,
  mergeSha: string,
): Promise<string[]> {
  const parent = `${mergeSha}^`
  const files = await api.changedFiles(repo, token, parent, mergeSha)
  const kept = files.filter((file) => file.status !== 'removed').map((file) => file.path)
  const tags: string[] = []
  for (const dir of packageDirs(kept)) {
    const path = manifestPath(dir)
    const after = await mustRead(api, repo, token, path, mergeSha)
    const tag = versionedTag(await api.readFile(repo, token, path, parent), after, path)
    if (tag) tags.push(tag)
  }
  return tags
}

/**
 * The packages the commit of a task changes, by name: the named package that carries each file its merge
 * changed against its first parent (the innermost one that holds it). Whether the package is private or ignored is not asked, since
 * a later commit of the same promotion may have made it publishable, and what a release lacks is named by
 * the package alone.
 */
export async function packagesOfCommit(
  api: GithubApi,
  repo: string,
  token: string,
  sha: string,
  layout: string = sha,
): Promise<string[]> {
  const found = await manifestsOfCommit(api, repo, token, sha, layout)
  return found.flatMap(({ text, dir }) => {
    const { name } = parseManifest(text, dir)
    return name === undefined ? [] : [name]
  })
}

/**
 * The releases (`name@version`) of the published packages a task's commit changed, at the version `ref` (the
 * release branch) holds: what changesets must have released for the change to be available. A private or
 * ignored package, or one with no name or version, is never released and is left out.
 */
export async function releasesOfCommit(
  api: GithubApi,
  repo: string,
  token: string,
  sha: string,
  ref: string,
): Promise<string[]> {
  const found = await manifestsOfCommit(api, repo, token, sha, ref)
  if (found.length === 0) return []
  const ignore = changesetIgnore(await mustRead(api, repo, token, '.changeset/config.json', ref))
  return found.flatMap(({ text, dir }) => {
    const { name, private: kept } = parseManifest(text, dir)
    const { version } = JSON.parse(text) as { version?: unknown }
    if (name === undefined || kept || typeof version !== 'string' || isIgnored(name, ignore)) {
      return []
    }
    return [`${name}@${version}`]
  })
}

async function manifestsOfCommit(
  api: GithubApi,
  repo: string,
  token: string,
  sha: string,
  layout: string,
): Promise<{ dir: string; text: string }[]> {
  const files = touchedPaths(await api.changedFiles(repo, token, `${sha}^`, sha))
  // The packages of the commit and of the promoted tree (`layout`): a later task may have created or moved one.
  const atCommit = packageDirs(await api.filePaths(repo, token, sha))
  const promoted = layout === sha ? atCommit : packageDirs(await api.filePaths(repo, token, layout))
  const dirs = [...new Set([...atCommit, ...promoted])]
  // A file belongs to the innermost package that holds it, so a nested package's change is not the root's.
  const touched = [
    ...new Set(
      files.flatMap((file) => {
        const own = enclosingPackages(file, dirs).sort((a, b) => b.length - a.length)[0]
        return own === undefined ? [] : [own]
      }),
    ),
  ]
  // A package the promoted tree no longer has at that path was moved or removed since: what it is called
  // there now cannot be told, so the task's package is not established.
  const gone = touched.filter((dir) => !promoted.includes(dir))
  if (gone.length > 0) {
    throw new Error(
      `${gone.join(', ')} is no package in the promoted tree: it was moved or removed`,
    )
  }
  const found: { dir: string; text: string }[] = []
  for (const dir of touched) {
    const path = manifestPath(dir)
    const text =
      (await api.readFile(repo, token, path, layout)) ??
      (await mustRead(api, repo, token, path, sha))
    found.push({ dir, text })
  }
  return found
}
