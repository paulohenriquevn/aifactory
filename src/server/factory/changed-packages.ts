import type { GithubApi } from '../github/pulls'

import {
  changesetIgnore,
  enclosingPackages,
  packageDirs,
  parseManifest,
  publishedTouched,
  type PackageManifest,
} from './changesets'

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
 * The packages changesets would publish that `head` changes since `base`, read from GitHub: the files the
 * comparison lists, the package.json of every package one of them is under, and the `ignore` list of
 * `.changeset/config.json`, all as they are on `head`. Empty means the change is only in packages that are
 * private or ignored, or in no package at all.
 */
export async function publishedPackagesChanged(
  api: GithubApi,
  repo: string,
  token: string,
  branches: { base: string; head: string },
): Promise<string[]> {
  const { base, head } = branches
  const files = await api.changedFiles(repo, token, base, head)
  const dirs = packageDirs(await api.filePaths(repo, token, head))
  const touched = [...new Set(files.flatMap((file) => enclosingPackages(file, dirs)))]
  const manifests = new Map<string, PackageManifest>()
  for (const dir of touched) {
    const path = dir ? `${dir}/package.json` : 'package.json'
    manifests.set(dir, parseManifest(await mustRead(api, repo, token, path, head), dir))
  }
  const ignore = changesetIgnore(await mustRead(api, repo, token, '.changeset/config.json', head))
  return publishedTouched(files, manifests, ignore)
}
