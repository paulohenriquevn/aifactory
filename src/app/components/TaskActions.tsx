import { useState } from 'react'

import { Button, Textarea } from '@usetheo/ui'

import type { TaskDetail } from '../../shared/panel'
import { post } from '../lib/api'
import { useCopy } from '../lib/copy'
import type { Copy } from '../lib/copy/en'

import { Assist } from './Assist'

/** What the panel says once a release was asked for: made, or waiting for the release branch's checks. */
function released(t: Copy, answer: unknown): string {
  const checks = (answer as { awaitingChecks?: string[] } | undefined)?.awaitingChecks
  return checks ? t.taskActions.releaseWaits(checks.join(', ')) : t.taskActions.released
}

/**
 * What a person can do about a task right now. Each button asks the server, which checks the task's
 * stage again, so a stale page cannot do something the task no longer allows.
 */
export function TaskActions({ detail, onDone }: { detail: TaskDetail; onDone: () => void }) {
  const { task } = detail
  const { t } = useCopy()
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
    <section
      aria-label={t.taskActions.title}
      className="rounded-lg border border-border bg-card p-4"
    >
      <h2 className="mb-3 text-sm font-semibold">{t.taskActions.heading}</h2>
      {task.waitingForChecks ? (
        <p className="mb-3 text-sm text-muted-foreground">{t.taskActions.waitingForChecks}</p>
      ) : null}
      {releaseWaiting && task.releaseWait ? (
        <p className="mb-3 text-sm text-muted-foreground">
          {t.taskActions.releaseWaitBefore}{' '}
          <a href={task.releaseWait.pullRequestUrl} className="underline">
            {task.releaseWait.pullRequestUrl}
          </a>{' '}
          {t.taskActions.releaseWaitAfter(task.releaseWait.checks.join(', '))}
        </p>
      ) : null}
      {releaseRefused ? (
        <p className="mb-3 text-sm text-foreground">
          {t.taskActions.releaseRefused(releaseRefused)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {hasPullRequest ? (
          <Button
            size="sm"
            disabled={busy || task.approved}
            onClick={() => void run('approve', undefined, t.taskActions.approvedMessage)}
          >
            {task.approved ? t.taskActions.approved : t.taskActions.approve}
          </Button>
        ) : null}
        {canRelease ? (
          <span className="flex items-center gap-1">
            <select
              aria-label={t.taskActions.versionBump}
              value={bump}
              onChange={(e) => setBump(e.target.value as typeof bump)}
              className="h-8 rounded-lg border border-border bg-card px-2 text-sm text-foreground"
            >
              <option value="patch">{t.taskActions.patch}</option>
              <option value="minor">{t.taskActions.minor}</option>
              <option value="major">{t.taskActions.major}</option>
            </select>
            <Button
              size="sm"
              variant="accent"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t.taskActions.confirmRelease)) {
                  void run('release', { bump }, (answer) => released(t, answer))
                }
              }}
            >
              {t.taskActions.release}
            </Button>
          </span>
        ) : null}
        {canRetry ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t.taskActions.confirmRetry)) {
                void run('retry', undefined, t.taskActions.retried)
              }
            }}
          >
            {t.taskActions.retry}
          </Button>
        ) : null}
      </div>
      {hasPullRequest && !task.integrated ? (
        <div className="mt-4">
          <label className="block text-sm">
            <span className="text-foreground">{t.taskActions.askChanges}</span>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder={t.taskActions.changesPlaceholder}
              className="mt-1 w-full"
            />
          </label>
          <Assist
            kind="changes"
            text={note}
            repository={task.repository}
            context={t.taskActions.changesContext(task.title, task.issueNumber, task.repository)}
            onUse={(p) => setNote(p.text)}
          />
          <Button
            size="sm"
            className="mt-2"
            disabled={busy || note.trim() === ''}
            onClick={() => void run('changes', { note }, t.taskActions.sentBack)}
          >
            {t.taskActions.sendBack}
          </Button>
        </div>
      ) : null}
      {canResolve ? (
        <div className="mt-4">
          <label className="block text-sm">
            <span className="text-foreground">{t.taskActions.resolvedAnotherWay}</span>
            <Textarea
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              rows={2}
              placeholder={t.taskActions.resolvePlaceholder}
              className="mt-1 w-full"
            />
          </label>
          <Assist
            kind="resolution"
            text={resolution}
            repository={task.repository}
            context={t.taskActions.resolveContext(task.title, task.issueNumber, task.repository)}
            onUse={(p) => setResolution(p.text)}
          />
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            disabled={busy || resolution.trim() === ''}
            onClick={() => void run('resolve', { note: resolution }, t.taskActions.resolvedMessage)}
          >
            {t.taskActions.markResolved}
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
