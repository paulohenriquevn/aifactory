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

/**
 * Puts the integration and pre-release branches of the playground back where the default branch is. A
 * run now merges its pull request into `workspace` and advances `develop`, so a second run would find
 * the first one's change already there and have nothing to commit.
 */
export async function resetIntegrationBranches(token: string, repo: string) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }
  const base = `https://api.github.com/repos/${repo}`
  const { default_branch: main } = (await (await fetch(base, { headers })).json()) as {
    default_branch: string
  }
  const head = (
    (await (await fetch(`${base}/git/ref/heads/${main}`, { headers })).json()) as {
      object: { sha: string }
    }
  ).object.sha
  for (const branch of ['workspace', 'develop']) {
    const moved = await fetch(`${base}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ sha: head, force: true }),
    })
    if (moved.status === 404) {
      await fetch(`${base}/git/refs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: head }),
      })
    }
  }
}
