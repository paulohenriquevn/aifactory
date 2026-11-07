import { afterEach, describe, expect, it, vi } from 'vitest'

import { FakeBackend } from '../factory/fake-sandbox'

import { KnowledgeFeed, REFRESH_MS } from './feed'
import type { KnowledgeSource, Slice } from './source'
import type { Pin } from './store'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const pin = (k: string, m?: string): Pin => ({
  repository: 'me/kb',
  knowledgeSha: k.repeat(40),
  ...(m ? { memorySha: m.repeat(40) } : {}),
})

function source(pins: (Pin | undefined)[], slice: Slice = { files: [], left: [] }) {
  const delivered: unknown[] = []
  let at = 0
  const fake: KnowledgeSource = {
    pin: async () => pins[Math.min(at++, pins.length - 1)],
    slice: vi.fn(async () => slice),
    delivered: async (input) => {
      delivered.push(input)
    },
    keep: async () => {},
  }
  return { fake, delivered }
}

describe('the knowledge base in an agent sandbox', () => {
  it('is copied before the agent starts, with the guide, and recorded with its commits', async () => {
    const backend = new FakeBackend(() => ({}))
    const { fake, delivered } = source([pin('a', 'b')], {
      files: [
        { path: 'README.md', content: Buffer.from('readme') },
        {
          path: 'knowledge/global/tests.md',
          content: Buffer.from('---\ntype: Rule\ntitle: Tests first\n---\nwrite tests first'),
        },
      ],
      left: ['big.md'],
    })

    const feed = await KnowledgeFeed.open(fake, backend, 'acme/app', { taskId: 9 })
    feed.stop()

    expect(feed.dir).toBe('/tmp/knowledge')
    expect(feed.delivered).toEqual(pin('a', 'b'))
    expect(backend.files.get('/tmp/knowledge.next/README.md')).toBe('readme')
    expect(backend.files.get('/tmp/knowledge.next/knowledge/global/tests.md')).toContain(
      'write tests first',
    )
    const index = backend.files.get('/tmp/knowledge.next/index.md')
    expect(index).toContain('okf_version: "0.2"')
    expect(index).toContain('* [Tests first](knowledge/global/tests.md)')
    expect(index).toContain('# Left out because the slice is full\n\n* [big.md](big.md)')
    expect(backend.commands).toEqual([
      'rm -rf /tmp/knowledge.next',
      'rm -rf /tmp/knowledge && mv /tmp/knowledge.next /tmp/knowledge',
    ])
    expect(delivered).toEqual([
      { recipient: { taskId: 9 }, project: 'acme/app', pin: pin('a', 'b'), files: 2 },
    ])
  })

  it('is not copied again while the base has not moved', async () => {
    const backend = new FakeBackend(() => ({}))
    const { fake, delivered } = source([pin('a'), pin('a')])
    const feed = await KnowledgeFeed.open(fake, backend, 'acme/app', { planId: 1 })
    feed.stop()

    expect(await feed.refresh()).toBe(false)
    expect(delivered).toHaveLength(1)
  })

  it('is replaced when the rules or the notes move, and each copy is recorded', async () => {
    const backend = new FakeBackend(() => ({}))
    const { fake, delivered } = source([pin('a'), pin('a', 'n'), pin('c', 'n')])
    const feed = await KnowledgeFeed.open(fake, backend, 'acme/app', { taskId: 9 })
    feed.stop()

    expect(await feed.refresh()).toBe(true)
    expect(await feed.refresh()).toBe(true)
    expect(feed.delivered).toEqual(pin('c', 'n'))
    expect(delivered.map((d) => (d as { pin: Pin }).pin)).toEqual([
      pin('a'),
      pin('a', 'n'),
      pin('c', 'n'),
    ])
  })

  it('is compared with the mirror every minute while the agent works', async () => {
    vi.useFakeTimers()
    const backend = new FakeBackend(() => ({}))
    const { fake, delivered } = source([pin('a'), pin('b')])
    const feed = await KnowledgeFeed.open(fake, backend, 'acme/app', { taskId: 9 })

    await vi.advanceTimersByTimeAsync(REFRESH_MS - 1)
    expect(delivered).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(delivered).toHaveLength(2)
    feed.stop()
  })

  it('never copies two at once', async () => {
    const backend = new FakeBackend(() => ({}))
    const { fake } = source([undefined, pin('a')])
    const feed = await KnowledgeFeed.open(fake, backend, 'acme/app', { taskId: 9 })
    feed.stop()

    const [first, second] = await Promise.all([feed.refresh(), feed.refresh()])
    expect([first, second]).toEqual([true, true])
    expect(fake.slice).toHaveBeenCalledTimes(1)
  })

  it('stops when the sandbox stops, before the sandbox does', async () => {
    vi.useFakeTimers()
    const backend = new FakeBackend(() => ({}))
    const { fake, delivered } = source([pin('a'), pin('b')])
    const feed = await KnowledgeFeed.open(fake, backend, 'acme/app', { taskId: 9 })
    const order: string[] = []
    const sandbox = feed.attachTo({
      backend,
      stop: async () => {
        order.push('sandbox')
      },
    })

    await sandbox.stop()
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
    expect(order).toEqual(['sandbox'])
    expect(delivered).toHaveLength(1)
  })

  it('never copies a base into a sandbox whose agent started without one, since its prompt never named it', async () => {
    vi.useFakeTimers()
    const backend = new FakeBackend(() => ({}))
    const { fake, delivered } = source([undefined, pin('a')])
    const feed = await KnowledgeFeed.open(fake, backend, 'acme/app', { taskId: 9 })

    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)

    expect(feed.dir).toBeUndefined()
    expect(delivered).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves the agent without a base when none is ready, and says nothing is there', async () => {
    const backend = new FakeBackend(() => ({}))
    const { fake } = source([undefined])
    const feed = await KnowledgeFeed.open(fake, backend, 'acme/app', { taskId: 9 })
    feed.stop()

    expect(feed.dir).toBeUndefined()
    expect(backend.commands).toEqual([])
  })

  it('works without a source, as in a test, and never starts a timer', async () => {
    vi.useFakeTimers()
    const feed = await KnowledgeFeed.open(undefined, new FakeBackend(() => ({})), 'acme/app', {})
    expect(feed.dir).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('logs a copy that failed with what the sandbox said, and keeps the last good copy', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    let fail = false
    const backend = new FakeBackend((command) =>
      fail && command.startsWith('rm -rf /tmp/knowledge &&')
        ? { exitCode: 1, stderr: 'disk full' }
        : {},
    )
    const { fake } = source([pin('a'), pin('b')])
    const feed = await KnowledgeFeed.open(fake, backend, 'acme/app', { taskId: 9 })
    feed.stop()
    fail = true

    expect(await feed.refresh()).toBe(false)
    expect(feed.delivered).toEqual(pin('a'))
    const event = JSON.parse(String(logged.mock.calls[0][0])) as Record<string, unknown>
    expect(event).toMatchObject({
      event: 'knowledge_delivery_failed',
      project: 'acme/app',
      taskId: 9,
    })
    expect(event.error).toMatch(/exited 1: disk full/)
  })
})
