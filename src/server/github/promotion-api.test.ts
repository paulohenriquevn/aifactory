import { describe, expect, it } from 'vitest'

import { createPromotionApi } from './promotion-api'

type Call = { method: string; url: string; auth?: string }

function fakeFetch(answers: Record<string, { status: number; body?: unknown; text?: string }>) {
  const calls: Call[] = []
  const fetch = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const path = url.replace('https://api.github.com/repos/o/r', '')
    calls.push({
      method,
      url: path,
      auth: (init.headers as Record<string, string>).authorization,
    })
    const answer = answers[`${method} ${path.split('?')[0]}`] ?? { status: 404 }
    const body = answer.text ?? JSON.stringify(answer.body ?? {})
    return new Response(answer.status === 204 ? null : body, { status: answer.status })
  }
  return { fetch, calls }
}

describe('openPullRequest', () => {
  it('finds the open pull request from one branch into another', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /pulls': {
        status: 200,
        body: [{ number: 979, html_url: 'https://github.com/o/r/pull/979', head: { sha: 'abc' } }],
      },
    })
    const found = await createPromotionApi(fetch).openPullRequest(
      'o/r',
      'tok',
      'workspace',
      'develop',
    )
    expect(found).toEqual({ number: 979, url: 'https://github.com/o/r/pull/979', headSha: 'abc' })
    expect(calls[0]).toMatchObject({
      url: '/pulls?state=open&head=o:workspace&base=develop',
      auth: 'Bearer tok',
    })
  })

  it('is nothing when no such pull request is open', async () => {
    const { fetch } = fakeFetch({ 'GET /pulls': { status: 200, body: [] } })
    expect(await createPromotionApi(fetch).openPullRequest('o/r', 't', 'a', 'b')).toBeUndefined()
  })
})

describe('failedChecks', () => {
  it('lists the latest check runs that failed, and says which are Actions jobs', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /commits/abc/check-runs': {
        status: 200,
        body: {
          check_runs: [
            {
              id: 1,
              name: 'validate',
              status: 'completed',
              conclusion: 'failure',
              html_url: 'https://github.com/o/r/actions/runs/9/job/1',
              app: { slug: 'github-actions' },
              output: { summary: null },
            },
            {
              id: 2,
              name: 'CodeQL',
              status: 'completed',
              conclusion: 'failure',
              html_url: 'https://github.com/o/r/runs/2',
              app: { slug: 'github-advanced-security' },
              output: { summary: '3 new alerts' },
            },
            { id: 3, name: 'lint', status: 'completed', conclusion: 'success', app: { slug: 'x' } },
            { id: 4, name: 'slow', status: 'in_progress', conclusion: null, app: { slug: 'x' } },
            {
              id: 5,
              name: 'gone',
              status: 'completed',
              conclusion: 'cancelled',
              app: { slug: 'x' },
            },
            {
              id: 6,
              name: 'late',
              status: 'completed',
              conclusion: 'timed_out',
              app: { slug: 'x' },
            },
          ],
        },
      },
    })
    const failed = await createPromotionApi(fetch).failedChecks('o/r', 't', 'abc')
    expect(failed).toEqual([
      {
        id: 1,
        name: 'validate',
        url: 'https://github.com/o/r/actions/runs/9/job/1',
        summary: '',
        actions: true,
      },
      {
        id: 2,
        name: 'CodeQL',
        url: 'https://github.com/o/r/runs/2',
        summary: '3 new alerts',
        actions: false,
      },
      { id: 6, name: 'late', url: '', summary: '', actions: false },
    ])
    expect(calls[0].url).toBe('/commits/abc/check-runs?filter=latest&per_page=100')
  })
})

describe('the jobs of a run', () => {
  it('reads which run a job is in and which attempt it was', async () => {
    const { fetch } = fakeFetch({
      'GET /actions/jobs/7': { status: 200, body: { run_id: 9, run_attempt: 2 } },
    })
    expect(await createPromotionApi(fetch).jobAttempt('o/r', 't', 7)).toEqual({
      runId: 9,
      attempt: 2,
    })
  })

  it("reads a job's log as text", async () => {
    const { fetch } = fakeFetch({ 'GET /actions/jobs/7/logs': { status: 200, text: 'line one' } })
    expect(await createPromotionApi(fetch).jobLog('o/r', 't', 7)).toBe('line one')
  })

  it('reruns the failed jobs of a run', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /actions/runs/9/rerun-failed-jobs': { status: 201 },
    })
    const answer = await createPromotionApi(fetch).rerunFailedJobs('o/r', 't', 9)
    expect(answer).toEqual({ started: true })
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/actions/runs/9/rerun-failed-jobs' })
  })

  it.each([403, 404])(
    'answers with the refusal when GitHub refuses the rerun with %i',
    async (status) => {
      const { fetch } = fakeFetch({
        'POST /actions/runs/9/rerun-failed-jobs': {
          status,
          text: '{"message":"Resource not accessible by integration"}',
        },
      })
      const answer = await createPromotionApi(fetch).rerunFailedJobs('o/r', 't', 9)
      expect(answer).toEqual({
        started: false,
        refusal: `GitHub answered ${status} rerunning the failed jobs of run 9 on o/r: {"message":"Resource not accessible by integration"}`,
      })
    },
  )

  it('fails loudly when the rerun fails for another reason', async () => {
    const { fetch } = fakeFetch({ 'POST /actions/runs/9/rerun-failed-jobs': { status: 500 } })
    await expect(createPromotionApi(fetch).rerunFailedJobs('o/r', 't', 9)).rejects.toThrow(
      /GitHub answered 500 rerunning the failed jobs of run 9 on o\/r/,
    )
  })
})

describe('annotations', () => {
  it('says each annotation as file, line, title and message', async () => {
    const { fetch } = fakeFetch({
      'GET /check-runs/2/annotations': {
        status: 200,
        body: [
          {
            path: 'apps/a.ts',
            start_line: 118,
            title: 'Server-side request forgery',
            message: 'The URL depends on a user-provided value.',
          },
          { path: 'b.ts', start_line: 2, title: null, message: 'Unused import join.' },
        ],
      },
    })
    expect(await createPromotionApi(fetch).annotations('o/r', 't', 2)).toEqual([
      'apps/a.ts:118 Server-side request forgery: The URL depends on a user-provided value.',
      'b.ts:2 Unused import join.',
    ])
  })
})

describe('issueOpen', () => {
  it('says whether an issue is still open', async () => {
    const open = fakeFetch({ 'GET /issues/5': { status: 200, body: { state: 'open' } } })
    const closed = fakeFetch({ 'GET /issues/5': { status: 200, body: { state: 'closed' } } })
    expect(await createPromotionApi(open.fetch).issueOpen('o/r', 't', 5)).toBe(true)
    expect(await createPromotionApi(closed.fetch).issueOpen('o/r', 't', 5)).toBe(false)
  })
})
