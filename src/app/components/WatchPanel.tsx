import { useState } from 'react'

import { Button } from '@usetheo/ui'

import type { WatchView } from '../../shared/panel'
import { post } from '../lib/api'
import { ago, shortSha } from '../lib/format'

const WORDS: Record<WatchView['status'], string> = {
  watching: 'watching the checks on the default branch',
  reverting: 'the default branch went red, opening a revert',
  green: 'the default branch stayed green',
  red: 'the default branch went red',
  silent: 'no verdict: the checks never reported',
}

/**
 * What happened to the default branch after a release. A red one comes with the revert pull request
 * the factory opened, which only a person merges, and a way to say it was dealt with.
 */
export function WatchPanel({ watches, onDone }: { watches: WatchView[]; onDone: () => void }) {
  const [message, setMessage] = useState<string>()
  if (watches.length === 0) return null

  async function handled(id: number) {
    try {
      await post(`/api/panel/watches/${id}/handled`)
      onDone()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section aria-label="Default branch">
      <h2 className="mb-2 text-sm font-semibold">Default branch after the release</h2>
      <ul className="space-y-2">
        {watches.map((w) => (
          <li
            key={w.id}
            className={`rounded-lg border p-3 text-sm ${
              w.status === 'red' && !w.acknowledged
                ? 'border-destructive/40 bg-destructive/10'
                : 'border-border bg-card'
            }`}
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{WORDS[w.status]}</span>
              <span className="text-xs text-muted-foreground">
                {w.tag ?? 'release'} · merge {shortSha(w.sha)} · {ago(w.endedAt ?? w.startedAt)}
              </span>
            </div>
            {w.detail ? <p className="mt-1 text-foreground">{w.detail}</p> : null}
            {w.status === 'red' ? (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {w.revertUrl ? (
                  <a
                    href={w.revertUrl}
                    className="text-foreground underline underline-offset-2"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Revert pull request
                  </a>
                ) : (
                  <span className="text-destructive">No revert pull request could be opened.</span>
                )}
                {w.acknowledged ? (
                  <span className="text-muted-foreground">dealt with</span>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => void handled(w.id)}>
                    I dealt with it
                  </Button>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {message ? (
        <p role="status" className="mt-2 text-sm text-foreground">
          {message}
        </p>
      ) : null}
    </section>
  )
}
