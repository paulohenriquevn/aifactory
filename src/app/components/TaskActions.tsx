import { useState } from 'react'

import type { TaskDetail } from '../../shared/panel'
import { post } from '../lib/api'

/**
 * What a person can do about a task right now. Each button asks the server, which checks the task's
 * stage again, so a stale page cannot do something the task no longer allows.
 */
export function TaskActions({ detail, onDone }: { detail: TaskDetail; onDone: () => void }) {
  const { task } = detail
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const [bump, setBump] = useState<'patch' | 'minor' | 'major'>('patch')

  const hasPullRequest = (task.stage === 'done' || task.stage === 'handoff') && !!task.headSha
  const canRetry = task.stage === 'failed' || task.stage === 'handoff'
  const canRelease = task.stage === 'done' && task.preRelease !== null

  async function run(path: string, body?: unknown, done?: string) {
    setBusy(true)
    setMessage(undefined)
    try {
      await post(`/api/panel/tasks/${task.id}/${path}`, body)
      setMessage(done)
      setNote('')
      onDone()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!hasPullRequest && !canRetry && !canRelease) return null

  return (
    <section aria-label="Actions" className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold">What do you want to do?</h2>
      <div className="flex flex-wrap items-center gap-2">
        {hasPullRequest ? (
          <button
            type="button"
            disabled={busy || task.approved}
            onClick={() => void run('approve', undefined, 'Approved at this commit.')}
            className="rounded bg-emerald-700 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {task.approved ? 'Approved' : 'Approve this commit'}
          </button>
        ) : null}
        {canRelease ? (
          <span className="flex items-center gap-1">
            <select
              aria-label="Version bump"
              value={bump}
              onChange={(e) => setBump(e.target.value as typeof bump)}
              className="rounded border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="patch">patch</option>
              <option value="minor">minor</option>
              <option value="major">major</option>
            </select>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    'Merge the pull request into the default branch and publish a release? This cannot be undone from here.',
                  )
                ) {
                  void run('release', { bump }, 'Released.')
                }
              }}
              className="rounded bg-violet-700 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              Release
            </button>
          </span>
        ) : null}
        {canRetry ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  'Start again from the beginning? The branch and its pull request are deleted.',
                )
              ) {
                void run('retry', undefined, 'Started again.')
              }
            }}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
          >
            Try again
          </button>
        ) : null}
      </div>
      {hasPullRequest ? (
        <div className="mt-4">
          <label className="block text-sm">
            <span className="text-slate-700">Ask for changes</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="What should change? The agent continues from the branch it pushed."
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            disabled={busy || note.trim() === ''}
            onClick={() => void run('changes', { note }, 'Sent back to the agent.')}
            className="mt-2 rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            Send back
          </button>
        </div>
      ) : null}
      {message ? (
        <p role="status" className="mt-3 text-sm text-slate-700">
          {message}
        </p>
      ) : null}
    </section>
  )
}
