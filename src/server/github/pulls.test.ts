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
    // A 204 has no body, and the Response constructor refuses one.
    return new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? {}), {
      status: answer.status,
    })
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
    expect(calls.at(-1)?.body).toEqual({
      head: 'factory/1',
      base: 'trunk',
      title: 'T',
      body: 'B',
      draft: false,
    })
    expect(calls[0].url).toContain('head=o:factory%2F1')
  })

  it('opens against the branch it was given, without asking GitHub for the default', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /pulls': { status: 200, body: [] },
      'POST /pulls': {
        status: 201,
        body: { number: 7, html_url: 'https://github.com/o/r/pull/7' },
      },
    })

    await createGithubApi(fetch).openPullRequest('o/r', 'tok', { ...pull, base: 'develop' })

    expect((calls.at(-1)?.body as { base: string }).base).toBe('develop')
    expect(calls.map((c) => `${c.method} ${c.url}`).some((c) => c.endsWith('/repos/o/r'))).toBe(
      false,
    )
  })

  it('opens a draft when asked to', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /pulls': { status: 200, body: [] },
      'GET /': { status: 200, body: { default_branch: 'main' } },
      'POST /pulls': {
        status: 201,
        body: { number: 6, html_url: 'https://github.com/o/r/pull/6' },
      },
    })

    await createGithubApi(fetch).openPullRequest('o/r', 'tok', { ...pull, draft: true })

    expect((calls.at(-1)?.body as { draft: boolean }).draft).toBe(true)
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

describe('commentOnIssue', () => {
  it('posts the comment on the issue and throws when GitHub refuses', async () => {
    const ok = fakeFetch({ 'POST /issues/7/comments': { status: 201 } })
    await createGithubApi(ok.fetch).commentOnIssue('o/r', 'tok', 7, 'hello')
    expect(ok.calls[0]).toMatchObject({
      method: 'POST',
      url: '/issues/7/comments',
      body: { body: 'hello' },
    })

    const refused = fakeFetch({ 'POST /issues/7/comments': { status: 403 } })
    await expect(
      createGithubApi(refused.fetch).commentOnIssue('o/r', 'tok', 7, 'x'),
    ).rejects.toThrow(/403/)
  })
})

describe('closeIssue', () => {
  it('closes the issue as completed and throws when GitHub refuses', async () => {
    const ok = fakeFetch({ 'PATCH /issues/7': { status: 200 } })
    await createGithubApi(ok.fetch).closeIssue('o/r', 'tok', 7)
    expect(ok.calls[0]).toMatchObject({
      method: 'PATCH',
      url: '/issues/7',
      body: { state: 'closed', state_reason: 'completed' },
    })

    const refused = fakeFetch({ 'PATCH /issues/7': { status: 410 } })
    await expect(createGithubApi(refused.fetch).closeIssue('o/r', 'tok', 7)).rejects.toThrow(/410/)
  })
})

describe('releases', () => {
  const release = {
    tag: 'pre/7-abcdef1',
    sha: 'abcdef1234',
    name: 'N',
    body: 'B',
    prerelease: true,
  }

  it('creates a pre-release on the commit, marked as one and not as the latest', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /releases': {
        status: 201,
        body: {
          id: 4,
          tag_name: 'pre/7-abcdef1',
          html_url: 'https://github.com/o/r/releases/tag/pre%2F7-abcdef1',
        },
      },
    })

    const made = await createGithubApi(fetch).createRelease('o/r', 'tok', release)

    expect(made).toEqual({
      id: 4,
      tag: 'pre/7-abcdef1',
      url: 'https://github.com/o/r/releases/tag/pre%2F7-abcdef1',
    })
    expect(calls[0].body).toMatchObject({
      tag_name: 'pre/7-abcdef1',
      target_commitish: 'abcdef1234',
      prerelease: true,
      draft: false,
      make_latest: 'false',
    })
  })

  it('makes a full release the latest one', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /releases': { status: 201, body: { id: 5, tag_name: 'v0.1.0', html_url: 'u' } },
    })
    await createGithubApi(fetch).createRelease('o/r', 't', {
      ...release,
      tag: 'v0.1.0',
      prerelease: false,
    })
    expect(calls[0].body).toMatchObject({ prerelease: false, make_latest: 'true' })
  })

  it('returns the release a tag already has instead of failing, so delivering twice delivers once', async () => {
    const { fetch } = fakeFetch({
      'POST /releases': { status: 422, body: { message: 'already_exists' } },
      'GET /releases/tags/pre%2F7-abcdef1': {
        status: 200,
        body: {
          id: 4,
          tag_name: 'pre/7-abcdef1',
          html_url: 'https://github.com/o/r/releases/tag/pre%2F7-abcdef1',
        },
      },
    })
    expect(await createGithubApi(fetch).createRelease('o/r', 't', release)).toMatchObject({ id: 4 })
  })

  it('throws when GitHub refuses for another reason', async () => {
    const { fetch } = fakeFetch({ 'POST /releases': { status: 403, body: { message: 'nope' } } })
    await expect(createGithubApi(fetch).createRelease('o/r', 't', release)).rejects.toThrow(/403/)
  })

  it('reads the latest full release, or nothing when there is none', async () => {
    const some = fakeFetch({
      'GET /releases/latest': { status: 200, body: { tag_name: 'v1.2.3' } },
    })
    expect(await createGithubApi(some.fetch).latestReleaseTag('o/r', 't')).toBe('v1.2.3')
    const none = fakeFetch({ 'GET /releases/latest': { status: 404 } })
    expect(await createGithubApi(none.fetch).latestReleaseTag('o/r', 't')).toBeUndefined()
  })
})

describe('pull request state and merge', () => {
  it('finds the pull request opened from a branch, whatever its state', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /pulls': {
        status: 200,
        body: [
          {
            number: 9,
            html_url: 'u',
            head: { sha: 'abc' },
            draft: false,
            state: 'open',
            merged_at: null,
          },
        ],
      },
    })
    expect(await createGithubApi(fetch).findPullRequest('o/r', 't', 'factory/7')).toEqual({
      number: 9,
      url: 'u',
      headSha: 'abc',
      draft: false,
      state: 'open',
      merged: false,
    })
    expect(calls[0].url).toContain('state=all')
    const none = fakeFetch({ 'GET /pulls': { status: 200, body: [] } })
    expect(
      await createGithubApi(none.fetch).findPullRequest('o/r', 't', 'factory/7'),
    ).toBeUndefined()
  })

  it('pins the merge to the commit that was looked at', async () => {
    const { fetch, calls } = fakeFetch({
      'PUT /pulls/9/merge': { status: 200, body: { sha: 'merge1' } },
    })
    expect(await createGithubApi(fetch).mergePullRequest('o/r', 't', 9, 'abc', 'squash')).toEqual({
      sha: 'merge1',
    })
    expect(calls[0]).toMatchObject({ method: 'PUT', body: { sha: 'abc', merge_method: 'squash' } })
  })

  it('throws when GitHub refuses the merge, as it does when the head moved', async () => {
    const { fetch } = fakeFetch({
      'PUT /pulls/9/merge': { status: 409, body: { message: 'Head branch was modified' } },
    })
    await expect(
      createGithubApi(fetch).mergePullRequest('o/r', 't', 9, 'abc', 'squash'),
    ).rejects.toThrow(/409.*Head branch was modified/)
  })
})

describe('commitChecks', () => {
  it('reads the check runs and the combined state of the commit statuses', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /commits/abc/check-runs': {
        status: 200,
        body: { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'failure', id: 1 }] },
      },
      'GET /commits/abc/status': { status: 200, body: { state: 'pending', total_count: 2 } },
    })
    expect(await createGithubApi(fetch).commitChecks('o/r', 't', 'abc')).toEqual({
      checkRuns: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
      statuses: 'pending',
    })
    expect(calls[0].url).toContain('per_page=100')
  })

  it('says there are no statuses when there are none, because GitHub then answers pending', async () => {
    const { fetch } = fakeFetch({
      'GET /commits/abc/check-runs': { status: 200, body: { check_runs: [] } },
      'GET /commits/abc/status': { status: 200, body: { state: 'pending', total_count: 0 } },
    })
    expect(await createGithubApi(fetch).commitChecks('o/r', 't', 'abc')).toEqual({
      checkRuns: [],
      statuses: 'none',
    })
  })
})

describe('revertPullRequest', () => {
  const revert = { title: 'Revert: T (#7)', body: 'B' }

  it('asks GitHub to open a revert of the merged pull request, and only opens it', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /pulls/12': { status: 200, body: { node_id: 'PR_node_12' } },
      'POST https://api.github.com/graphql': {
        status: 200,
        body: {
          data: {
            revertPullRequest: {
              revertPullRequest: { number: 41, url: 'https://github.com/o/r/pull/41' },
            },
          },
        },
      },
    })

    const made = await createGithubApi(fetch).revertPullRequest('o/r', 'tok', 12, revert)

    expect(made).toEqual({ number: 41, url: 'https://github.com/o/r/pull/41' })
    const graphql = calls.find((c) => c.url.includes('graphql'))!
    expect(graphql.auth).toBe('Bearer tok')
    expect((graphql.body as { variables: object }).variables).toEqual({
      id: 'PR_node_12',
      title: 'Revert: T (#7)',
      body: 'B',
    })
    expect(JSON.stringify(graphql.body)).toContain('revertPullRequest')
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('throws with what GitHub said when it will not open the revert', async () => {
    const { fetch } = fakeFetch({
      'GET /pulls/12': { status: 200, body: { node_id: 'n' } },
      'POST https://api.github.com/graphql': {
        status: 200,
        body: { errors: [{ message: 'Pull request is not merged' }] },
      },
    })
    await expect(createGithubApi(fetch).revertPullRequest('o/r', 't', 12, revert)).rejects.toThrow(
      /would not open a revert of o\/r#12: Pull request is not merged/,
    )
  })
})

describe('the branches of a repository', () => {
  it('reads the default branch', async () => {
    const { fetch } = fakeFetch({ 'GET /': { status: 200, body: { default_branch: 'trunk' } } })
    expect(await createGithubApi(fetch).defaultBranch('o/r', 'tok')).toBe('trunk')
  })

  it('reads where a branch is, and says a missing one is missing instead of failing', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /git/ref/heads/release/1': { status: 200, body: { object: { sha: 'abc' } } },
      'GET /git/ref/heads/gone': { status: 404, body: { message: 'Not Found' } },
    })
    const api = createGithubApi(fetch)
    expect(await api.branchHead('o/r', 'tok', 'release/1')).toBe('abc')
    expect(await api.branchHead('o/r', 'tok', 'gone')).toBeUndefined()
    expect(calls[0].url).toContain('/git/ref/heads/release/1')
  })

  it('fails on any other answer when reading a branch', async () => {
    const { fetch } = fakeFetch({ 'GET /git/ref/heads/x': { status: 500, body: 'boom' } })
    await expect(createGithubApi(fetch).branchHead('o/r', 'tok', 'x')).rejects.toThrow(/500/)
  })

  it('creates a branch at a commit', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /git/refs': { status: 201, body: {} } })
    await createGithubApi(fetch).createBranch('o/r', 'tok', 'workspace', 'deadbeef')
    expect(calls[0].body).toEqual({ ref: 'refs/heads/workspace', sha: 'deadbeef' })
  })

  it('refuses to say a branch was created when GitHub says otherwise', async () => {
    const { fetch } = fakeFetch({
      'POST /git/refs': { status: 422, body: 'Reference already exists' },
    })
    await expect(createGithubApi(fetch).createBranch('o/r', 'tok', 'w', 'sha')).rejects.toThrow(
      /422/,
    )
  })

  it('merges one branch or commit into another and returns where the base is', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /merges': { status: 201, body: { sha: 'merged1' } },
    })
    const result = await createGithubApi(fetch).mergeBranch('o/r', 'tok', 'develop', 'a'.repeat(40))
    expect(result).toEqual({ sha: 'merged1', changed: true })
    expect(calls[0].body).toMatchObject({ base: 'develop', head: 'a'.repeat(40) })
  })

  it('reads where the base is when it already had everything', async () => {
    const { fetch } = fakeFetch({
      'POST /merges': { status: 204, body: '' },
      'GET /git/ref/heads/develop': { status: 200, body: { object: { sha: 'head1' } } },
    })
    expect(await createGithubApi(fetch).mergeBranch('o/r', 'tok', 'develop', 'x')).toEqual({
      sha: 'head1',
      changed: false,
    })
  })

  it('fails on a conflict and on a branch the App cannot write to', async () => {
    const conflict = fakeFetch({ 'POST /merges': { status: 409, body: 'Merge conflict' } })
    await expect(
      createGithubApi(conflict.fetch).mergeBranch('o/r', 'tok', 'd', 'x'),
    ).rejects.toThrow(/409/)
    const protectedBranch = fakeFetch({ 'POST /merges': { status: 403, body: 'protected' } })
    await expect(
      createGithubApi(protectedBranch.fetch).mergeBranch('o/r', 'tok', 'd', 'x'),
    ).rejects.toThrow(/403/)
  })
})
