import { Alert, Badge, Button, Card, Textarea } from '@usetheo/ui'
import { useState } from 'react'

import type { RepositoriesView, RepositoryView } from '../../shared/panel'
import { put } from '../lib/api'
import { useResource } from '../lib/live'
import { formatChecks, formatDomains, parseChecks, parseDomains } from '../lib/repo-form'

const selectClass =
  'h-9 w-full rounded-lg border border-border bg-card px-2 text-sm text-foreground'

function Settings({
  repo,
  agents,
  onSaved,
}: {
  repo: RepositoryView
  agents: string[]
  onSaved: () => void
}) {
  const [checks, setChecks] = useState(formatChecks(repo.checks))
  const [domains, setDomains] = useState(formatDomains(repo.egress))
  const [harness, setHarness] = useState(repo.harness ?? '')
  const [reviewer, setReviewer] = useState(repo.reviewer ?? '')
  const [release, setRelease] = useState(repo.releaseMode ?? '')
  const [message, setMessage] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    setMessage(undefined)
    try {
      const parsed = parseChecks(checks)
      await put(`/api/panel/repositories/${repo.fullName}`, {
        checks: parsed.length > 0 ? parsed : null,
        egress: parseDomains(domains),
        harness: harness || null,
        reviewer: reviewer || null,
        releaseMode: release || null,
      })
      setMessage('Saved.')
      onSaved()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3 text-sm">
      <label className="block">
        <span className="text-foreground">Checks, one per line as name: command</span>
        <Textarea
          value={checks}
          onChange={(e) => setChecks(e.target.value)}
          rows={3}
          placeholder="Empty runs npm test. For example: unit: pnpm test"
          className="mt-1 w-full font-mono"
        />
      </label>
      <label className="block">
        <span className="text-foreground">Extra domains the sandbox may reach</span>
        <Textarea
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
          rows={2}
          placeholder="GitHub, the agent and the npm registry are always open. For Python: pypi.org, files.pythonhosted.org"
          className="mt-1 w-full font-mono"
        />
      </label>
      <div className="grid grid-cols-3 gap-3">
        <label className="block">
          <span className="text-foreground">Builder</span>
          <select
            aria-label="Builder"
            value={harness}
            onChange={(e) => setHarness(e.target.value)}
            className={selectClass}
          >
            <option value="">Factory default</option>
            {agents.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-foreground">Reviewer</span>
          <select
            aria-label="Reviewer"
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
            className={selectClass}
          >
            <option value="">Same as the builder</option>
            {agents.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-foreground">Release</span>
          <select
            aria-label="Release"
            value={release}
            onChange={(e) => setRelease(e.target.value)}
            className={selectClass}
          >
            <option value="">Factory default</option>
            <option value="manual">Only me, from the panel</option>
            <option value="trial">Record what an agent would do</option>
            <option value="auto">An agent may release</option>
          </select>
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          Save settings
        </Button>
        {message ? (
          <span role="status" className="text-foreground">
            {message}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function Repo({
  repo,
  agents,
  onChanged,
}: {
  repo: RepositoryView
  agents: string[]
  onChanged: () => void
}) {
  const [message, setMessage] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function toggle() {
    setBusy(true)
    setMessage(undefined)
    try {
      await put(`/api/panel/repositories/${repo.fullName}`, { enabled: !repo.enabled })
      onChanged()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li>
      <Card size="sm" className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium">{repo.fullName}</span>
          <Badge variant="default">{repo.private ? 'private' : 'public'}</Badge>
          {!repo.reachable ? <Badge variant="warning">App has no access</Badge> : null}
          {repo.enabled ? <Badge variant="success">enabled</Badge> : null}
          <Button
            size="sm"
            variant={repo.enabled ? 'secondary' : 'primary'}
            className="ml-auto"
            disabled={busy}
            onClick={() => void toggle()}
          >
            {repo.enabled ? 'Disable' : 'Enable'}
          </Button>
        </div>
        {message ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {message}
          </p>
        ) : null}
        {repo.enabled ? <Settings repo={repo} agents={agents} onSaved={onChanged} /> : null}
      </Card>
    </li>
  )
}

/** The repositories the GitHub App reaches, and the ones the owner lets the factory work in. */
export default function RepositoriesPage() {
  const resource = useResource<RepositoriesView>('/api/panel/repositories', {
    everyMs: 30_000,
    stream: false,
  })
  const data = resource.data
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Repositories</h1>
        <div className="flex gap-2">
          {data?.installations.map((i) => (
            <a
              key={i.account}
              href={i.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-foreground underline underline-offset-2"
            >
              {i.selection === 'all'
                ? `Restrict which repositories the App reaches (${i.account})`
                : `Choose which repositories the App reaches (${i.account})`}
            </a>
          ))}
          {data?.installUrl ? (
            <a
              href={data.installUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-foreground underline underline-offset-2"
            >
              {data.installations.length === 0 ? 'Install the App' : 'Install on another account'}
            </a>
          ) : null}
          <Button size="sm" variant="secondary" onClick={resource.reload}>
            Refresh
          </Button>
        </div>
      </div>
      {resource.error ? <p className="text-sm text-destructive">{resource.error}</p> : null}
      {data?.error ? (
        <Alert intent="warning" title="GitHub could not be asked" description={data.error} />
      ) : null}
      {data?.installations.map((i) =>
        i.selection === 'all' ? (
          <p key={i.account} className="text-sm text-muted-foreground">
            The App already reaches every repository of {i.account}, so there is nothing to grant:
            enable the ones you want below. The link above is only for narrowing that list, and
            GitHub shows it only when you are signed in as {i.account}.
          </p>
        ) : null,
      )}
      {data?.owner ? (
        <p className="text-sm text-muted-foreground">
          The App is private: signed in as any other account, GitHub answers 404 or &ldquo;private
          GitHub App&rdquo;.
        </p>
      ) : null}
      {data ? (
        data.repositories.length === 0 ? (
          <Alert
            intent="info"
            title="The App reaches no repository yet"
            description="Install it on GitHub and choose the repositories it may work in, then refresh."
            action={
              data.installUrl ? (
                <a
                  href={data.installUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm underline underline-offset-2"
                >
                  Install the App
                </a>
              ) : undefined
            }
          />
        ) : (
          <ul className="space-y-2">
            {data.repositories.map((repo) => (
              <Repo
                key={repo.fullName}
                repo={repo}
                agents={data.agents}
                onChanged={resource.reload}
              />
            ))}
          </ul>
        )
      ) : (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
    </div>
  )
}
