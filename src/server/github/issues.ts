import type { FetchLike } from './app'

export type Issue = { number: number; title: string; body: string; labels: string[] }

/** Reads an issue with an installation token. Runs on the factory host, never in the sandbox. */
export async function fetchIssue(
  repo: string,
  number: number,
  token: string,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<Issue> {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${number}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${token}`,
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} reading ${repo}#${number}`)
  }
  const data = (await response.json()) as {
    number: number
    title: string
    body: string | null
    labels?: { name: string }[]
  }
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? '',
    labels: (data.labels ?? []).map((l) => l.name),
  }
}
