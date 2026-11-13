import type { ChangedFile, GithubApi } from '../github/pulls'

import {
  changesetIgnore,
  enclosingPackages,
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
