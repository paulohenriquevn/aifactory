import { Button, Dialog, Input, Textarea } from '@usetheo/ui'
import { useState } from 'react'

import type { RepositoriesView } from '../../shared/panel'
import { get, post } from '../lib/api'

/** One issue, written here, opened on GitHub, and started if asked. The task comes back through the webhook. */
export type CreatedJob = { number: number; url: string; started: boolean }

/** One issue, written here, opened on GitHub, and started if asked. The task comes back through the webhook. */
export function NewJob({ onCreated }: { onCreated: (job: CreatedJob) => void }) {
  const [open, setOpen] = useState(false)
  const [repos, setRepos] = useState<RepositoriesView>()
  const [repository, setRepository] = useState('')
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
        <Button size="sm">New job</Button>
      </Dialog.Trigger>
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>New job</Dialog.Title>
          <Dialog.Description>
            Opens an issue on GitHub. With &ldquo;Start now&rdquo; the factory begins as soon as it
            is created.
          </Dialog.Description>
        </Dialog.Header>
        <Dialog.Body className="space-y-3 text-sm">
          {enabled.length === 0 ? (
            <p className="text-muted-foreground">Enable a repository under Repositories first.</p>
          ) : (
            <>
              <label className="block">
                <span className="text-foreground">Repository</span>
                <select
                  aria-label="Repository"
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
                <span className="text-foreground">Title</span>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="mt-1 w-full"
                />
              </label>
              <label className="block">
                <span className="text-foreground">
                  What should it do, and how will you know it works?
                </span>
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={6}
                  className="mt-1 w-full"
                />
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={start}
                  onChange={(e) => setStart(e.target.checked)}
                />
                <span className="text-foreground">Start now</span>
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
            Create job
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  )
}
