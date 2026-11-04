import { useCallback, useEffect, useRef, useState } from 'react'

import type { StreamEvent } from '../../shared/panel'

import { ApiError, get } from './api'

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
  { only, everyMs = 10_000 }: { only?: number; everyMs?: number } = {},
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
    let source: EventSource | undefined
    if (typeof EventSource !== 'undefined') {
      source = new EventSource('/api/panel/stream')
      let pending: ReturnType<typeof setTimeout> | undefined
      source.onmessage = (message) => {
        const event = JSON.parse(message.data) as StreamEvent
        if (only !== undefined && event.taskId !== only) return
        clearTimeout(pending)
        pending = setTimeout(reload, 150)
      }
    }
    return () => {
      alive.current = false
      clearInterval(timer)
      source?.close()
    }
  }, [reload, only, everyMs])

  return { data, error, signedOut, reload }
}
