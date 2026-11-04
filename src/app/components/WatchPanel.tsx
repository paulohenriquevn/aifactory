import { useState } from 'react'

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
                ? 'border-red-200 bg-red-50'
                : 'border-slate-200 bg-white'
            }`}
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{WORDS[w.status]}</span>
              <span className="text-xs text-slate-500">
                {w.tag ?? 'release'} · merge {shortSha(w.sha)} · {ago(w.endedAt ?? w.startedAt)}
              </span>
            </div>
            {w.detail ? <p className="mt-1 text-slate-700">{w.detail}</p> : null}
            {w.status === 'red' ? (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {w.revertUrl ? (
                  <a
                    href={w.revertUrl}
                    className="text-blue-700 underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Revert pull request
                  </a>
                ) : (
                  <span className="text-red-700">No revert pull request could be opened.</span>
                )}
                {w.acknowledged ? (
                  <span className="text-slate-500">dealt with</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handled(w.id)}
                    className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                  >
                    I dealt with it
                  </button>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {message ? (
        <p role="status" className="mt-2 text-sm text-slate-700">
          {message}
        </p>
      ) : null}
    </section>
  )
}
