import { ToolCallCard } from '@theokit/ui'
import { useEffect, useState } from 'react'

import type { TranscriptEvent, TranscriptPage } from '../../shared/panel'
import { get } from '../lib/api'
import { ago } from '../lib/format'
import { subscribe } from '../lib/live'
import { mergeSteps, transcriptRows } from '../lib/transcript'

/**
 * Every step of a task's agents: the stored ones a page at a time, and the new ones from the page's one
 * event stream as they happen. The stream is listened to before the first page is asked for, and what it
 * brings meanwhile is kept, so a step written between the two is not lost.
 */
function useTranscript(taskId: number) {
  const [events, setEvents] = useState<TranscriptEvent[]>([])
  const [error, setError] = useState<string>()

  useEffect(() => {
    let alive = true
    let loaded = false
    let early: TranscriptEvent[] = []
    setEvents([])
    const unsubscribe = subscribe((e) => {
      if (e.type !== 'agent' || e.taskId !== taskId) return
      if (!loaded) early.push(e.event)
      else setEvents((known) => mergeSteps(known, [e.event]))
    })
    const load = async () => {
      let all: TranscriptEvent[] = []
      for (let after = 0; ;) {
        const page = await get<TranscriptPage>(
          `/api/panel/tasks/${taskId}/transcript?after=${after}`,
        )
        all = mergeSteps(all, page.events)
        const last = page.events.at(-1)
        if (!page.more || !last) break
        after = last.seq
      }
      return all
    }
    load()
      .then((all) => {
        if (!alive) return
        loaded = true
        setEvents(mergeSteps(all, early))
        early = []
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [taskId])

  return { events, error }
}

const ROLE = { builder: 'Builder', reviewer: 'Reviewer' } as const

export function Transcript({ taskId, live }: { taskId: number; live: boolean }) {
  const { events, error } = useTranscript(taskId)
  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {live
          ? 'Waiting for the first step of the agent…'
          : 'No steps were recorded for this task.'}
      </p>
    )
  }
  return (
    <ol className="space-y-2">
      {transcriptRows(events, live).map((row) => (
        <li key={row.seq} className="text-sm">
          {row.type === 'tool' ? (
            <ToolCallCard
              tool={row.tool}
              target={row.target}
              status={row.status}
              timestamp={ago(row.at)}
              output={
                row.output ? (
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{row.output}</pre>
                ) : undefined
              }
            />
          ) : row.type === 'say' ? (
            <p className="whitespace-pre-wrap">
              <span className="mr-2 text-xs font-medium text-muted-foreground">
                {ROLE[row.role]}
              </span>
              {row.text}
            </p>
          ) : (
            <p className={row.failed ? 'text-destructive' : 'text-xs text-muted-foreground'}>
              {row.text}
            </p>
          )}
        </li>
      ))}
    </ol>
  )
}
