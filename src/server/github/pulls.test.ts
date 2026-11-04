import { describe, expect, it } from 'vitest'

import { createGithubApi } from './pulls'

type Call = { method: string; url: string; body?: unknown; auth?: string }

function fakeFetch(answers: Record<string, { status: number; body?: unknown }>) {
  const calls: Call[] = []
  const fetch = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const path = url.replace('https://api.github.com/repos/o/r', '') || '/'
    calls.push({
      method,
      url: path,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init.headers as Record<string, string>).authorization,
    })
    const answer = answers[`${method} ${path.split('?')[0]}`] ?? { status: 404 }
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status })
  }
  return { fetch, calls }
}

describe('createCheckRun', () => {
  it('reports a completed check on the SHA with the conclusion', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /check-runs': { status: 201 } })

    await createGithubApi(fetch).createCheckRun('o/r', 'tok', {
      name: 'aifactory/verify',
      headSha: 'abc',
      conclusion: 'failure',
      title: 't',
      summary: 's',
    })

    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: '/check-runs',
      auth: 'Bearer tok',
      body: {
        name: 'aifactory/verify',
        head_sha: 'abc',
        status: 'completed',
        conclusion: 'failure',
      },
    })
  })

  it('throws with the status when GitHub refuses', async () => {
    const { fetch } = fakeFetch({ 'POST /check-runs': { status: 403, body: { message: 'nope' } } })
    await expect(
      createGithubApi(fetch).createCheckRun('o/r', 't', {
        name: 'n',
        headSha: 'a',
        conclusion: 'success',
        title: 't',
        summary: 's',
      }),
    ).rejects.toThrow(/403.*nope/)
  })
})

describe('openPullRequest', () => {
  const pull = { head: 'factory/1', title: 'T', body: 'B' }

  it('opens against the default branch', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /pulls': { status: 200, body: [] },
      'GET /': { status: 200, body: { default_branch: 'trunk' } },
      'POST /pulls': {
        status: 201,
        body: { number: 5, html_url: 'https://github.com/o/r/pull/5' },
      },
    })

    const result = await createGithubApi(fetch).openPullRequest('o/r', 'tok', pull)

    expect(result).toEqual({ number: 5, url: 'https://github.com/o/r/pull/5' })
    expect(calls.at(-1)?.body).toEqual({ head: 'factory/1', base: 'trunk', title: 'T', body: 'B' })
    expect(calls[0].url).toContain('head=o:factory%2F1')
  })

  it('returns the pull request that is already open instead of opening another', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /pulls': {
        status: 200,
        body: [{ number: 3, html_url: 'https://github.com/o/r/pull/3' }],
      },
    })

    const result = await createGithubApi(fetch).openPullRequest('o/r', 'tok', pull)

    expect(result.number).toBe(3)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })
})
