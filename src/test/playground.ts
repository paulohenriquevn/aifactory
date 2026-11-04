/**
 * The live suites run the factory against the playground repository, and a run now leaves a
 * pre-release and its tag behind. This removes the ones an issue's runs made, so the playground
 * stays as it was.
 */
export async function deletePreReleases(token: string, repo: string, issue: number) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }
  const releases = (await (
    await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers })
  ).json()) as { id: number; tag_name: string }[]
  for (const release of releases.filter((r) => r.tag_name.startsWith(`pre/${issue}-`))) {
    await fetch(`https://api.github.com/repos/${repo}/releases/${release.id}`, {
      method: 'DELETE',
      headers,
    })
    await fetch(
      `https://api.github.com/repos/${repo}/git/refs/tags/${encodeURIComponent(release.tag_name).replace(/%2F/g, '/')}`,
      { method: 'DELETE', headers },
    )
  }
}
