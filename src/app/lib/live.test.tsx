// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { subscribe, useResource } from './live'

class FakeEventSource {
  static all: FakeEventSource[] = []
  onmessage: ((m: { data: string }) => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.all.push(this)
  }
  close() {
    this.closed = true
  }
  emit(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
}

beforeEach(() => {
  FakeEventSource.all = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ n: 1 }), { status: 200 })),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the live stream', () => {
  it('opens one connection for any number of listeners, and closes it with the last one', () => {
    const a = subscribe(() => {})
    const b = subscribe(() => {})
    const c = subscribe(() => {})
    expect(FakeEventSource.all).toHaveLength(1)
    a()
    b()
    expect(FakeEventSource.all[0].closed).toBe(false)
    c()
    expect(FakeEventSource.all[0].closed).toBe(true)
  })

  it('opens a new connection when someone listens again after it was closed', () => {
    subscribe(() => {})()
    subscribe(() => {})()
    expect(FakeEventSource.all).toHaveLength(2)
  })

  it('hands every event to every listener', () => {
    const seen: number[][] = [[], []]
    const stops = [0, 1].map((i) => subscribe((e) => seen[i].push(e.taskId)))
    FakeEventSource.all[0].emit({ taskId: 7 })
    expect(seen).toEqual([[7], [7]])
    stops.forEach((stop) => stop())
  })

  it('shares the connection between resources on one page', async () => {
    function Two() {
      useResource('/api/panel/a')
      useResource('/api/panel/b')
      return null
    }
    render(<Two />)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(FakeEventSource.all).toHaveLength(1)
  })

  it('reloads only the resource whose task the event is about', async () => {
    function Tracked() {
      useResource('/api/panel/tasks/5', { only: 5, everyMs: 600_000 })
      useResource('/api/panel/tasks/6', { only: 6, everyMs: 600_000 })
      return null
    }
    render(<Tracked />)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    FakeEventSource.all[0].emit({ taskId: 5 })
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    expect((fetch as unknown as { mock: { calls: string[][] } }).mock.calls[2][0]).toBe(
      '/api/panel/tasks/5',
    )
  })
})
