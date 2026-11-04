import { useCallback, useEffect, useRef, useState } from 'react'

import type { StreamEvent } from '../../shared/panel'

import { ApiError, get } from './api'

type Listener = (event: StreamEvent) => void

const listeners = new Set<Listener>()
let source: EventSource | undefined

/**
 * One stream for the whole page. Every resource on the page listens to it, instead of each opening
 * its own: a browser allows only six connections to one host, and a stream that never ends holds one.
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  if (!source && typeof EventSource !== 'undefined') {
    source = new EventSource('/api/panel/stream')
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as StreamEvent
      for (const each of listeners) each(event)
    }
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      source?.close()
      source = undefined
    }
  }
}

export type Resource<T> = {
  data: T | undefined
  error: string | undefined
  /** True when the API said nobody is signed in. */
  signedOut: boolean
  reload: () => void
}

/**
 * Loads `path` and keeps it fresh: every stage change the server announces reloads it, and a slow
 * timer covers what the stream does not carry (cost grows while an agent works) and a stream that
 * dropped. `only` limits the reload to the events of one task.
 */
export function useResource<T>(
  path: string,
  {
    only,
    everyMs = 10_000,
    stream = true,
  }: { only?: number; everyMs?: number; stream?: boolean } = {},
): Resource<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const [signedOut, setSignedOut] = useState(false)
  const alive = useRef(true)

  const reload = useCallback(() => {
    get<T>(path)
      .then((value) => {
        if (!alive.current) return
        setData(value)
        setError(undefined)
        setSignedOut(false)
      })
      .catch((e: unknown) => {
        if (!alive.current) return
        if (e instanceof ApiError && (e.status === 403 || e.status === 401)) setSignedOut(true)
        else setError(e instanceof Error ? e.message : String(e))
      })
  }, [path])

  useEffect(() => {
    alive.current = true
    reload()
    const timer = setInterval(reload, everyMs)
    let pending: ReturnType<typeof setTimeout> | undefined
    // A page that asks GitHub for its data does not reload on every stage change of every task.
    const unsubscribe = stream
      ? subscribe((event) => {
          if (only !== undefined && event.taskId !== only) return
          clearTimeout(pending)
          pending = setTimeout(reload, 150)
        })
      : () => {}
    return () => {
      alive.current = false
      clearInterval(timer)
      clearTimeout(pending)
      unsubscribe()
    }
  }, [reload, only, everyMs, stream])

  return { data, error, signedOut, reload }
}
