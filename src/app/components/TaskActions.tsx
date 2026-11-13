import { useState } from 'react'

import { Button, Textarea } from '@usetheo/ui'

import type { TaskDetail } from '../../shared/panel'
import { post } from '../lib/api'

import { Assist } from './Assist'

/** What the panel says once a release was asked for: made, or waiting for the release branch's checks. */
function released(answer: unknown): string {
  const checks = (answer as { awaitingChecks?: string[] } | undefined)?.awaitingChecks
  return checks
    ? `The release waits for the checks of the release branch (${checks.join(', ')}): GitHub merges it once they pass.`
    : 'Released.'
}

/**
 * What a person can do about a task right now. Each button asks the server, which checks the task's
 * stage again, so a stale page cannot do something the task no longer allows.
 */
export function TaskActions({ detail, onDone }: { detail: TaskDetail; onDone: () => void }) {
  const { task } = detail
  const [note, setNote] = useState('')
  const [resolution, setResolution] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const [bump, setBump] = useState<'patch' | 'minor' | 'major'>('patch')

  const hasPullRequest = (task.stage === 'done' || task.stage === 'handoff') && !!task.headSha
  const canResolve = task.stage === 'failed' || task.stage === 'handoff'
  // Done but never merged (GitHub refused the pull request): the work is not delivered.
  const canRetry = canResolve || (task.stage === 'done' && !task.integrated && !task.resolved)
  const releaseWaiting = task.releaseWait?.status === 'waiting'
  const releaseRefused = task.releaseWait?.status === 'refused' ? task.releaseWait.reason : null
  const canRelease = task.stage === 'done' && task.preRelease !== null && !releaseWaiting

  async function run(path: string, body?: unknown, done?: string | ((answer: unknown) => string)) {
    setBusy(true)
    setMessage(undefined)
    try {
      const answer = await post(`/api/panel/tasks/${task.id}/${path}`, body)
      setMessage(typeof done === 'function' ? done(answer) : done)
      setNote('')
      setResolution('')
      onDone()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!hasPullRequest && !canRetry && !canRelease && !releaseWaiting) return null

  return (
    <section aria-label="Actions" className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold">What do you want to do?</h2>
      {task.waitingForChecks ? (
        <p className="mb-3 text-sm text-muted-foreground">
          GitHub merges this pull request once the repository's required checks pass, and the
          factory finishes the integration then. A check that fails sends the work back to the
          agent.
        </p>
      ) : null}
      {releaseWaiting && task.releaseWait ? (
        <p className="mb-3 text-sm text-muted-foreground">
          The release pull request{' '}
          <a href={task.releaseWait.pullRequestUrl} className="underline">
            {task.releaseWait.pullRequestUrl}
          </a>{' '}
          waits for the required checks of the release branch: {task.releaseWait.checks.join(', ')}.
          GitHub merges it once they pass, and the factory finishes the release then. A check that
          fails stops the release, and the reason shows here.
        </p>
      ) : null}
      {releaseRefused ? (
        <p className="mb-3 text-sm text-foreground">
          The last release did not happen: {releaseRefused}.
        </p>
      ) : null}
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
                    'Promote the pre-release branch to the default branch and publish a release? Everything on the pre-release branch goes with it. This cannot be undone from here.',
                  )
                ) {
                  void run('release', { bump }, released)
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
      {hasPullRequest && !task.integrated ? (
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
          <Assist
            kind="changes"
            text={note}
            repository={task.repository}
            context={`Pull request for the issue "${task.title}" (#${task.issueNumber}) in ${task.repository}`}
            onUse={(p) => setNote(p.text)}
          />
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
      {canResolve ? (
        <div className="mt-4">
          <label className="block text-sm">
            <span className="text-foreground">Resolved another way</span>
            <Textarea
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              rows={2}
              placeholder="Where was it resolved? A pull request you made by hand, or the issues it was split into."
              className="mt-1 w-full"
            />
          </label>
          <Assist
            kind="resolution"
            text={resolution}
            repository={task.repository}
            context={`The factory could not deliver the issue "${task.title}" (#${task.issueNumber}) in ${task.repository}`}
            onUse={(p) => setResolution(p.text)}
          />
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            disabled={busy || resolution.trim() === ''}
            onClick={() =>
              void run('resolve', { note: resolution }, 'Marked as delivered another way.')
            }
          >
            Mark as resolved
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
