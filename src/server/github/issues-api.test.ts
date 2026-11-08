import { describe, expect, it } from 'vitest'

import type { FetchLike } from './app'
import { createIssuesApi } from './issues-api'

type Call = { url: string; method: string; auth: string; body: unknown }

function serve(status: number, body: unknown = {}) {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    const headers = init?.headers as Record<string, string>
    calls.push({
      url,
      method: init?.method ?? 'GET',
      auth: headers.authorization,
      body: JSON.parse(String(init?.body ?? 'null')),
    })
    return new Response(JSON.stringify(body), { status })
  }
  return { api: createIssuesApi(fetch), calls }
}

describe('creating an issue', () => {
  it('posts the issue with its labels and milestone, with the repository token', async () => {
    const { api, calls } = serve(201, { number: 12, html_url: 'https://github.com/o/r/issues/12' })

    const created = await api.createIssue('o/r', 'tok', {
      title: 'Add truncate',
      body: 'Do it',
      labels: ['factory'],
      milestone: 3,
    })

    expect(created).toEqual({ number: 12, url: 'https://github.com/o/r/issues/12' })
    expect(calls[0]).toEqual({
      url: 'https://api.github.com/repos/o/r/issues',
      method: 'POST',
      auth: 'Bearer tok',
      body: { title: 'Add truncate', body: 'Do it', labels: ['factory'], milestone: 3 },
    })
  })

  it('says what GitHub answered when it refuses', async () => {
    const { api } = serve(403, { message: 'no' })
    await expect(api.createIssue('o/r', 't', { title: 'x', body: '' })).rejects.toThrow(
      /GitHub answered 403 creating an issue on o\/r: .*no/,
    )
  })
})

describe('labels and milestones', () => {
  const label = { name: 'factory', color: '5319e7', description: 'Let the factory build it' }

  it('creates a label, and leaves one that exists alone', async () => {
    const created = serve(201)
    await created.api.ensureLabel('o/r', 't', label)
    expect(created.calls[0].url).toBe('https://api.github.com/repos/o/r/labels')
    expect(created.calls[0].body).toEqual(label)

    await expect(serve(422).api.ensureLabel('o/r', 't', label)).resolves.toBeUndefined()
    await expect(serve(500).api.ensureLabel('o/r', 't', label)).rejects.toThrow(
      'GitHub answered 500 creating the factory label on o/r',
    )
  })

  it('creates a milestone and returns its number', async () => {
    const { api, calls } = serve(201, { number: 4 })
    expect(await api.createMilestone('o/r', 't', { title: 'Plan', description: 'd' })).toBe(4)
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/milestones')
    await expect(
      serve(404).api.createMilestone('o/r', 't', { title: 'p', description: '' }),
    ).rejects.toThrow('GitHub answered 404 creating a milestone on o/r')
  })

  it('adds labels to an issue, which is what starts the factory on it', async () => {
    const { api, calls } = serve(200, [])
    await api.addLabels('o/r', 't', 9, ['factory'])
    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/repos/o/r/issues/9/labels',
      method: 'POST',
      body: { labels: ['factory'] },
    })
    await expect(serve(404).api.addLabels('o/r', 't', 9, ['factory'])).rejects.toThrow(
      'GitHub answered 404 labelling o/r#9',
    )
  })
})
