import { describe, expect, it } from 'vitest'

import { AutoMergeRefused, createGithubApi } from './pulls'

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
    expect(
      await createGithubApi(fetch).mergePullRequest('o/r', 't', 9, 'abc', {
        method: 'squash',
        title: 'T',
      }),
    ).toEqual({
      sha: 'merge1',
    })
    expect(calls[0]).toMatchObject({ method: 'PUT', body: { sha: 'abc', merge_method: 'squash' } })
  })

  it('names the squash commit itself, so GitHub adds no Co-authored-by trailer to it', async () => {
    const { fetch, calls } = fakeFetch({
      'PUT /pulls/9/merge': { status: 200, body: { sha: 'merge1' } },
    })

    await createGithubApi(fetch).mergePullRequest('o/r', 't', 9, 'abc', {
      method: 'squash',
      title: 'Fix the parser (#4)',
    })

    expect(calls[0].body).toEqual({
      sha: 'abc',
      merge_method: 'squash',
      commit_title: 'Fix the parser (#4) (#9)',
      commit_message: '',
    })
  })

  it('leaves a merge commit message to GitHub, which adds no trailer to one', async () => {
    const { fetch, calls } = fakeFetch({
      'PUT /pulls/9/merge': { status: 200, body: { sha: 'merge1' } },
    })

    await createGithubApi(fetch).mergePullRequest('o/r', 't', 9, 'abc', { method: 'merge' })

    expect(calls[0].body).toEqual({ sha: 'abc', merge_method: 'merge' })
  })

  it('throws when GitHub refuses the merge, as it does when the head moved', async () => {
    const { fetch } = fakeFetch({
      'PUT /pulls/9/merge': { status: 409, body: { message: 'Head branch was modified' } },
    })
    await expect(
      createGithubApi(fetch).mergePullRequest('o/r', 't', 9, 'abc', {
        method: 'squash',
        title: 'T',
      }),
    ).rejects.toThrow(/409.*Head branch was modified/)
  })

  // Each answer in turn, the last one repeated: a merge that GitHub refuses for a moment, then takes.
  function answering(...answers: { status: number; body: unknown }[]) {
    let merges = 0
    const fetch = async () => {
      const answer = answers[Math.min(merges, answers.length - 1)]
      merges += 1
      return new Response(JSON.stringify(answer.body), { status: answer.status })
    }
    return { fetch, merges: () => merges }
  }
  const noWait = async () => {}

  it('merges on a second try when another merge moved the base branch a moment before', async () => {
    const github = answering(
      {
        status: 405,
        body: { message: 'Base branch was modified. Review and try the merge again.' },
      },
      { status: 200, body: { sha: 'merge1' } },
    )

    const merged = await createGithubApi(github.fetch, noWait).mergePullRequest(
      'o/r',
      't',
      9,
      'abc',
      { method: 'squash', title: 'T' },
    )

    expect(merged).toEqual({ sha: 'merge1' })
    expect(github.merges()).toBe(2)
  })

  it('merges on a later try when GitHub answers a server error', async () => {
    const github = answering(
      { status: 502, body: { message: 'Bad Gateway' } },
      { status: 500, body: { message: 'Server Error' } },
      { status: 200, body: { sha: 'merge1' } },
    )

    expect(
      await createGithubApi(github.fetch, noWait).mergePullRequest('o/r', 't', 9, 'abc', {
        method: 'squash',
        title: 'T',
      }),
    ).toEqual({ sha: 'merge1' })
    expect(github.merges()).toBe(3)
  })

  it('gives up after a few tries and says what GitHub answered last', async () => {
    const github = answering({ status: 405, body: { message: 'Base branch was modified.' } })

    await expect(
      createGithubApi(github.fetch, noWait).mergePullRequest('o/r', 't', 9, 'abc', {
        method: 'squash',
        title: 'T',
      }),
    ).rejects.toThrow(/405.*Base branch was modified/)
    expect(github.merges()).toBe(4)
  })

  it('does not try again when the pull request has conflicts, which only new work can fix', async () => {
    const github = answering({ status: 405, body: { message: 'Pull Request has merge conflicts' } })

    await expect(
      createGithubApi(github.fetch, noWait).mergePullRequest('o/r', 't', 9, 'abc', {
        method: 'squash',
        title: 'T',
      }),
    ).rejects.toThrow(/405.*merge conflicts/)
    expect(github.merges()).toBe(1)
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

describe('what a release with changesets needs to read', () => {
  it('lists the names in a directory at a ref, and nothing when the directory is not there', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /contents/.changeset': {
        status: 200,
        body: [{ name: 'config.json' }, { name: 'README.md' }, { name: 'brave-fox.md' }],
      },
    })
    expect(await createGithubApi(fetch).listDirectory('o/r', 't', '.changeset', 'develop')).toEqual(
      ['config.json', 'README.md', 'brave-fox.md'],
    )
    expect(calls[0].url).toBe('/contents/.changeset?ref=develop')
    const none = fakeFetch({ 'GET /contents/.changeset': { status: 404 } })
    expect(
      await createGithubApi(none.fetch).listDirectory('o/r', 't', '.changeset', 'develop'),
    ).toBeUndefined()
  })

  it('throws when the path is a file, not a directory', async () => {
    const { fetch } = fakeFetch({
      'GET /contents/.changeset': { status: 200, body: { name: '.changeset', type: 'file' } },
    })
    await expect(
      createGithubApi(fetch).listDirectory('o/r', 't', '.changeset', 'develop'),
    ).rejects.toThrow(/not a directory/)
  })

  it('reads the full releases published since a time, leaving pre-releases and drafts out', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /releases': {
        status: 200,
        body: [
          {
            tag_name: '@theokit/ui@1.13.0',
            html_url: 'https://github.com/o/r/releases/tag/u',
            prerelease: false,
            draft: false,
            published_at: '2026-11-11T12:00:00Z',
          },
          {
            tag_name: 'pre/7-abc',
            html_url: 'p',
            prerelease: true,
            draft: false,
            published_at: '2026-11-11T12:00:00Z',
          },
          { tag_name: 'draft', html_url: 'd', prerelease: false, draft: true, published_at: null },
          {
            tag_name: '@theokit/ui@1.12.2',
            html_url: 'old',
            prerelease: false,
            draft: false,
            published_at: '2026-09-25T21:13:42Z',
          },
        ],
      },
    })
    expect(
      await createGithubApi(fetch).releasesSince('o/r', 't', new Date('2026-11-11T11:00:00Z')),
    ).toEqual([
      {
        tag: '@theokit/ui@1.13.0',
        url: 'https://github.com/o/r/releases/tag/u',
        publishedAt: new Date('2026-11-11T12:00:00Z'),
      },
    ])
    expect(calls[0].url).toContain('per_page=100')
  })

  it('says whether a commit is in the history of another', async () => {
    const answer = (status: string) =>
      fakeFetch({ 'GET /compare/old...new': { status: 200, body: { status } } }).fetch
    const api = (status: string) => createGithubApi(answer(status))
    expect(await api('ahead').contains('o/r', 't', 'new', 'old')).toBe(true)
    expect(await api('identical').contains('o/r', 't', 'new', 'old')).toBe(true)
    expect(await api('behind').contains('o/r', 't', 'new', 'old')).toBe(false)
    expect(await api('diverged').contains('o/r', 't', 'new', 'old')).toBe(false)
  })

  it('reads when a pull request was merged', async () => {
    const { fetch } = fakeFetch({
      'GET /pulls': {
        status: 200,
        body: [
          {
            number: 171,
            html_url: 'u',
            head: { sha: 'abc' },
            draft: false,
            state: 'closed',
            merged_at: '2026-09-25T21:12:10Z',
          },
        ],
      },
    })
    expect(
      (await createGithubApi(fetch).findPullRequest('o/r', 't', 'changeset-release/main'))
        ?.mergedAt,
    ).toEqual(new Date('2026-09-25T21:12:10Z'))
  })
  it('lists the open pull requests from a branch of the repository into a base, with where each comes from', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /pulls': {
        status: 200,
        body: [
          {
            number: 1738,
            html_url: 'u',
            draft: false,
            head: { sha: 'abc', ref: 'main', repo: { full_name: 'o/r' } },
            base: { ref: 'workspace' },
          },
          {
            number: 5,
            html_url: 'v',
            draft: true,
            head: { sha: 'def', ref: 'main', repo: null },
            base: { ref: 'workspace' },
          },
        ],
      },
    })

    const found = await createGithubApi(fetch).openPullRequestsBetween(
      'o/r',
      't',
      'main',
      'workspace',
    )

    expect(found).toEqual([
      {
        number: 1738,
        url: 'u',
        headSha: 'abc',
        headRef: 'main',
        headRepo: 'o/r',
        baseRef: 'workspace',
        draft: false,
      },
      {
        number: 5,
        url: 'v',
        headSha: 'def',
        headRef: 'main',
        headRepo: undefined,
        baseRef: 'workspace',
        draft: true,
      },
    ])
    expect(calls[0].url).toBe('/pulls?state=open&head=o:main&base=workspace&per_page=100')
  })
})

describe('what integrating through the repository CI needs', () => {
  it('names the checks the integration branch requires, from its protection and its rulesets', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /branches/workspace': {
        status: 200,
        body: {
          protected: true,
          protection: {
            enabled: true,
            required_status_checks: {
              contexts: ['CI', 'Lint'],
              checks: [{ context: 'CI', app_id: 15368 }],
            },
          },
        },
      },
      'GET /rules/branches/workspace': {
        status: 200,
        body: [
          { type: 'deletion' },
          {
            type: 'required_status_checks',
            parameters: { required_status_checks: [{ context: 'Types' }, { context: 'Lint' }] },
          },
        ],
      },
    })

    expect(await createGithubApi(fetch).requiredChecks('o/r', 't', 'workspace')).toEqual([
      'CI',
      'Lint',
      'Types',
    ])
    expect(calls.map((c) => c.url)).toEqual(['/branches/workspace', '/rules/branches/workspace'])
  })

  it('requires nothing of a branch with no protection and no rulesets', async () => {
    const { fetch } = fakeFetch({
      'GET /branches/workspace': {
        status: 200,
        body: {
          protected: false,
          protection: {
            enabled: false,
            required_status_checks: { contexts: [], checks: [], enforcement_level: 'off' },
          },
        },
      },
      'GET /rules/branches/workspace': { status: 200, body: [] },
    })

    expect(await createGithubApi(fetch).requiredChecks('o/r', 't', 'workspace')).toEqual([])
  })

  it('throws when the integration branch cannot be read, rather than merging past its rules', async () => {
    const { fetch } = fakeFetch({ 'GET /branches/workspace': { status: 404 } })
    await expect(createGithubApi(fetch).requiredChecks('o/r', 't', 'workspace')).rejects.toThrow(
      /404 reading the branch workspace of o\/r/,
    )
  })

  it('reads a pull request by number, with its merge commit and whether auto-merge is on', async () => {
    const { fetch } = fakeFetch({
      'GET /pulls/12': {
        status: 200,
        body: {
          number: 12,
          html_url: 'https://github.com/o/r/pull/12',
          state: 'closed',
          merged: true,
          merge_commit_sha: 'm1',
          head: { sha: 'h1' },
          auto_merge: { merge_method: 'merge' },
          mergeable_state: 'clean',
        },
      },
    })

    expect(await createGithubApi(fetch).readPullRequest('o/r', 't', 12)).toEqual({
      number: 12,
      url: 'https://github.com/o/r/pull/12',
      state: 'closed',
      merged: true,
      mergeCommitSha: 'm1',
      headSha: 'h1',
      autoMerge: true,
      mergeableState: 'clean',
    })
  })

  it('has no merge commit for a pull request that is not merged', async () => {
    const { fetch } = fakeFetch({
      'GET /pulls/12': {
        status: 200,
        body: {
          number: 12,
          html_url: 'u',
          state: 'open',
          merged: false,
          merge_commit_sha: 'test-merge',
          head: { sha: 'h1' },
          auto_merge: null,
          mergeable_state: 'dirty',
        },
      },
    })

    expect(await createGithubApi(fetch).readPullRequest('o/r', 't', 12)).toMatchObject({
      merged: false,
      mergeCommitSha: undefined,
      autoMerge: false,
      mergeableState: 'dirty',
    })
  })

  it('turns auto-merge on as a merge commit, pinned to the verified head', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /pulls/12': { status: 200, body: { node_id: 'PR_12' } },
      'POST https://api.github.com/graphql': {
        status: 200,
        body: { data: { enablePullRequestAutoMerge: { pullRequest: { number: 12 } } } },
      },
    })

    await createGithubApi(fetch).enableAutoMerge('o/r', 'tok', 12, 'abc')

    const graphql = calls.find((c) => c.url.includes('graphql'))!
    expect(graphql.auth).toBe('Bearer tok')
    expect((graphql.body as { variables: object }).variables).toEqual({
      id: 'PR_12',
      sha: 'abc',
    })
    expect(JSON.stringify(graphql.body)).toContain('enablePullRequestAutoMerge')
    expect(JSON.stringify(graphql.body)).toContain('mergeMethod: MERGE')
    expect(JSON.stringify(graphql.body)).toContain('expectedHeadOid: $sha')
  })

  it('says what to configure when GitHub will not turn auto-merge on', async () => {
    const { fetch } = fakeFetch({
      'GET /pulls/12': { status: 200, body: { node_id: 'PR_12' } },
      'POST https://api.github.com/graphql': {
        status: 200,
        body: { errors: [{ message: 'Auto merge is not allowed for this repository' }] },
      },
    })

    const refused = createGithubApi(fetch).enableAutoMerge('o/r', 't', 12, 'abc')

    await expect(refused).rejects.toBeInstanceOf(AutoMergeRefused)
    await expect(refused).rejects.toThrow(
      /o\/r#12.*Auto merge is not allowed for this repository.*Allow auto-merge.*merge commits/,
    )
  })

  it('turns auto-merge off', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /pulls/12': { status: 200, body: { node_id: 'PR_12' } },
      'POST https://api.github.com/graphql': {
        status: 200,
        body: { data: { disablePullRequestAutoMerge: { pullRequest: { number: 12 } } } },
      },
    })

    await createGithubApi(fetch).disableAutoMerge('o/r', 't', 12)

    const graphql = calls.find((c) => c.url.includes('graphql'))!
    expect(JSON.stringify(graphql.body)).toContain('disablePullRequestAutoMerge')
    expect((graphql.body as { variables: object }).variables).toEqual({ id: 'PR_12' })
  })

  it('throws when auto-merge cannot be turned off', async () => {
    const { fetch } = fakeFetch({
      'GET /pulls/12': { status: 200, body: { node_id: 'PR_12' } },
      'POST https://api.github.com/graphql': { status: 502, body: {} },
    })
    await expect(createGithubApi(fetch).disableAutoMerge('o/r', 't', 12)).rejects.toThrow(
      /could not turn auto-merge off on o\/r#12: HTTP 502/,
    )
  })

  it('reports each check on a commit with what it said and where to read it', async () => {
    const { fetch } = fakeFetch({
      'GET /commits/abc/check-runs': {
        status: 200,
        body: {
          check_runs: [
            {
              name: 'CI',
              status: 'completed',
              conclusion: 'failure',
              html_url: 'https://github.com/o/r/runs/1',
              output: { title: 't', summary: 'two tests failed', text: 'at foo.test.ts:3' },
            },
            { name: 'Lint', status: 'in_progress', conclusion: null, html_url: 'l', output: {} },
            { name: 'Skip', status: 'completed', conclusion: 'skipped', html_url: 's', output: {} },
          ],
        },
      },
      'GET /commits/abc/status': {
        status: 200,
        body: {
          state: 'failure',
          total_count: 1,
          statuses: [
            { context: 'socket', state: 'error', description: 'down', target_url: 'https://x' },
          ],
        },
      },
    })

    expect(await createGithubApi(fetch).checkReports('o/r', 't', 'abc')).toEqual([
      {
        name: 'CI',
        state: 'failure',
        detail: 'two tests failed\nat foo.test.ts:3',
        url: 'https://github.com/o/r/runs/1',
      },
      { name: 'Lint', state: 'pending', detail: '', url: 'l' },
      { name: 'Skip', state: 'success', detail: '', url: 's' },
      { name: 'socket', state: 'failure', detail: 'down', url: 'https://x' },
    ])
  })
})
