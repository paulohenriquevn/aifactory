import { Button, Dialog, Input, Textarea } from '@usetheo/ui'
import { useState } from 'react'

import type { RepositoriesView } from '../../shared/panel'
import { get, post } from '../lib/api'
import { useCopy } from '../lib/copy'

import { Assist } from './Assist'

/** One issue, written here, opened on GitHub, and started if asked. The task comes back through the webhook. */
export type CreatedJob = { number: number; url: string; started: boolean }

/** One issue, written here, opened on GitHub, and started if asked. The task comes back through the webhook. */
export function NewJob({
  onCreated,
  repository: preferred = '',
  label,
}: {
  onCreated: (job: CreatedJob) => void
  /** The repository the form starts on, when it is not the first enabled one. */
  repository?: string
  /** The text of the button that opens the form. */
  label?: string
}) {
  const { t } = useCopy()
  const [open, setOpen] = useState(false)
  const [repos, setRepos] = useState<RepositoriesView>()
  const [repository, setRepository] = useState(preferred)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [start, setStart] = useState(true)
  const [message, setMessage] = useState<string>()
  const [busy, setBusy] = useState(false)

  // The list comes from GitHub, so it is asked for when the dialog opens and not on a timer.
  function toggle(next: boolean) {
    setOpen(next)
    if (next) {
      setMessage(undefined)
      get<RepositoriesView>('/api/panel/repositories')
        .then(setRepos)
        .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)))
    }
  }

  const enabled = repos?.repositories.filter((r) => r.enabled) ?? []
  const chosen = repository || enabled[0]?.fullName || ''

  async function submit() {
    setBusy(true)
    setMessage(undefined)
    try {
      const created = await post<CreatedJob>('/api/panel/jobs', {
        repository: chosen,
        title,
        body,
        start,
      })
      setTitle('')
      setBody('')
      setOpen(false)
      onCreated(created)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={toggle}>
      <Dialog.Trigger asChild>
        <Button size="sm">{label ?? t.newJob.open}</Button>
      </Dialog.Trigger>
      <Dialog.Content closeLabel={t.newJob.close}>
        <Dialog.Header>
          <Dialog.Title>{t.newJob.title}</Dialog.Title>
          <Dialog.Description>{t.newJob.description}</Dialog.Description>
        </Dialog.Header>
        <Dialog.Body className="space-y-3 text-sm">
          {repos === undefined ? (
            message ? null : (
              <p className="text-muted-foreground">{t.newJob.loading}</p>
            )
          ) : enabled.length === 0 ? (
            <p className="text-muted-foreground">{t.newJob.enableFirst}</p>
          ) : (
            <>
              <label className="block">
                <span className="text-foreground">{t.newJob.repository}</span>
                <select
                  aria-label={t.newJob.repository}
                  value={chosen}
                  onChange={(e) => setRepository(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-border bg-card px-2 text-sm text-foreground"
                >
                  {enabled.map((r) => (
                    <option key={r.fullName}>{r.fullName}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-foreground">{t.newJob.titleField}</span>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="mt-1 w-full"
                />
              </label>
              <label className="block">
                <span className="text-foreground">{t.newJob.bodyField}</span>
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={6}
                  className="mt-1 w-full"
                />
              </label>
              <Assist
                kind="job"
                text={body.trim() === '' ? title : body}
                repository={chosen}
                onUse={(p) => {
                  if (p.title) setTitle(p.title)
                  setBody(p.text)
                }}
              />
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={start}
                  onChange={(e) => setStart(e.target.checked)}
                />
                <span className="text-foreground">{t.newJob.startNow}</span>
              </label>
            </>
          )}
          {message ? (
            <p role="alert" className="text-destructive">
              {message}
            </p>
          ) : null}
        </Dialog.Body>
        <Dialog.Footer>
          <Button
            size="sm"
            disabled={busy || chosen === '' || title.trim() === ''}
            onClick={() => void submit()}
          >
            {t.newJob.create}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  )
}
