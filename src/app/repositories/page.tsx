import { Alert, Badge, Button, Card, Input, Textarea } from '@usetheo/ui'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'

import type { RepositoriesView, RepositoryView } from '../../shared/panel'
import { Assist } from '../components/Assist'
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
  const [baseBranch, setBaseBranch] = useState(repo.baseBranch ?? '')
  const [releaseBranch, setReleaseBranch] = useState(repo.releaseBranch ?? '')
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
        baseBranch: baseBranch.trim() || null,
        releaseBranch: releaseBranch.trim() || null,
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
      <Assist
        kind="setup"
        text={checks}
        repository={repo.fullName}
        onUse={(p) => {
          setChecks(p.text)
          if (p.domains) setDomains(formatDomains(p.domains))
        }}
      />
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
      <label className="block">
        <span className="text-foreground">Branch the work starts from</span>
        <Input
          aria-label="Branch the work starts from"
          value={baseBranch}
          placeholder="workspace (the default)"
          onChange={(e) => setBaseBranch(e.target.value)}
          className="mt-1 w-full"
        />
        <span className="text-muted-foreground">
          Finished work is merged here by the factory. Leave it empty to use workspace. The branch
          develop then carries the pre-release, and {repo.defaultBranch || 'the default branch'} the
          release. Missing branches are created for you.
        </span>
      </label>
      <label className="block">
        <span className="text-foreground">Branch a release lands on</span>
        <Input
          aria-label="Branch a release lands on"
          value={releaseBranch}
          placeholder={`${repo.defaultBranch || 'the default branch'} (the default)`}
          onChange={(e) => setReleaseBranch(e.target.value)}
          className="mt-1 w-full"
        />
        <span className="text-muted-foreground">
          Only needed when the default branch is develop, which is where the pre-release goes: name
          main, or the branch your releases use.
        </span>
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
type Watch = { since: number; accounts: string[]; repositories: number }

/** How long the page keeps asking GitHub after the owner went to install the App. */
const WATCH_MS = 5 * 60_000

/** The button that sends the owner to GitHub to install the App, and the page notices when they are back. */
function InstallButton({ url, onClick }: { url: string; onClick: () => void }) {
  return (
    <Button asChild size="sm" onClick={onClick}>
      <a href={url} target="_blank" rel="noreferrer">
        Install on GitHub
      </a>
    </Button>
  )
}

export default function RepositoriesPage() {
  const [watch, setWatch] = useState<Watch>()
  const [installed, setInstalled] = useState<string>()
  const [params, setParams] = useSearchParams()
  const resource = useResource<RepositoriesView>('/api/panel/repositories', {
    // While the owner is on GitHub installing, the page asks every few seconds instead of every half minute.
    everyMs: watch ? 3_000 : 30_000,
    stream: false,
  })
  const data = resource.data

  // GitHub can send the owner back here with the installation in the address.
  useEffect(() => {
    if (params.get('installation_id')) {
      setInstalled('GitHub confirmed the installation.')
      setParams({}, { replace: true })
      resource.reload()
    }
  }, [params, setParams, resource])

  // Once an account or a repository shows up that was not there when the owner left, say so and stop asking.
  useEffect(() => {
    if (!watch || !data) return
    const added = data.installations
      .map((i) => i.account)
      .filter((a) => !watch.accounts.includes(a))
    if (added.length > 0 || data.repositories.length > watch.repositories) {
      setInstalled(
        added.length > 0
          ? `Installed on ${added.join(', ')}. ${data.repositories.length} repositories are in reach.`
          : `${data.repositories.length} repositories are in reach.`,
      )
      setWatch(undefined)
    } else if (Date.now() - watch.since > WATCH_MS) {
      setWatch(undefined)
    }
  }, [data, watch])

  const startWatching = () => {
    setInstalled(undefined)
    setWatch({
      since: Date.now(),
      accounts: data?.installations.map((i) => i.account) ?? [],
      repositories: data?.repositories.length ?? 0,
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Repositories</h1>
        <div className="flex items-center gap-2">
          {data?.installUrl ? (
            <InstallButton url={data.installUrl} onClick={startWatching} />
          ) : null}
          <Button size="sm" variant="secondary" onClick={resource.reload}>
            Refresh
          </Button>
        </div>
      </div>
      {watch ? (
        <p role="status" className="text-sm text-muted-foreground">
          Waiting for GitHub. Pick the account and the repositories there, then come back: this page
          notices on its own.
        </p>
      ) : null}
      {installed ? (
        <Alert
          intent="success"
          title={installed}
          description="Enable the repositories you want below."
        />
      ) : null}
      {resource.error ? <p className="text-sm text-destructive">{resource.error}</p> : null}
      {data?.error ? (
        <Alert intent="warning" title="GitHub could not be asked" description={data.error} />
      ) : null}
      {data && data.installations.length > 0 ? (
        <ul aria-label="Installations" className="space-y-1 text-sm text-muted-foreground">
          {data.installations.map((i) => (
            <li key={i.account}>
              Installed on {i.account},{' '}
              {i.selection === 'all' ? 'every repository' : 'the repositories chosen there'}.{' '}
              <a
                href={i.url}
                target="_blank"
                rel="noreferrer"
                className="text-foreground underline underline-offset-2"
              >
                Manage on GitHub
              </a>{' '}
              (GitHub shows that page only when you are signed in as {i.account}.)
            </li>
          ))}
        </ul>
      ) : null}
      {data ? (
        data.repositories.length === 0 ? (
          <Alert
            intent="info"
            title="The App reaches no repository yet"
            description="Install it on GitHub and choose the repositories it may work in, then refresh."
            action={
              data.installUrl ? (
                <InstallButton url={data.installUrl} onClick={startWatching} />
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
