import { useState } from 'react'

import { Button, Textarea } from '@usetheo/ui'

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
    <section aria-label="Actions" className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold">What do you want to do?</h2>
      <div className="flex flex-wrap items-center gap-2">
        {hasPullRequest ? (
          <Button
            size="sm"
            disabled={busy || task.approved}
            onClick={() => void run('approve', undefined, 'Approved at this commit.')}
          >
            {task.approved ? 'Approved' : 'Approve this commit'}
          </Button>
        ) : null}
        {canRelease ? (
          <span className="flex items-center gap-1">
            <select
              aria-label="Version bump"
              value={bump}
              onChange={(e) => setBump(e.target.value as typeof bump)}
              className="h-8 rounded-lg border border-border bg-card px-2 text-sm text-foreground"
            >
              <option value="patch">patch</option>
              <option value="minor">minor</option>
              <option value="major">major</option>
            </select>
            <Button
              size="sm"
              variant="accent"
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
            >
              Release
            </Button>
          </span>
        ) : null}
        {canRetry ? (
          <Button
            size="sm"
            variant="secondary"
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
          >
            Try again
          </Button>
        ) : null}
      </div>
      {hasPullRequest ? (
        <div className="mt-4">
          <label className="block text-sm">
            <span className="text-foreground">Ask for changes</span>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="What should change? The agent continues from the branch it pushed."
              className="mt-1 w-full"
            />
          </label>
          <Button
            size="sm"
            className="mt-2"
            disabled={busy || note.trim() === ''}
            onClick={() => void run('changes', { note }, 'Sent back to the agent.')}
          >
            Send back
          </Button>
        </div>
      ) : null}
      {message ? (
        <p role="status" className="mt-3 text-sm text-foreground">
          {message}
        </p>
      ) : null}
    </section>
  )
}
