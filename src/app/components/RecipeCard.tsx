import { Alert, Badge, Button } from '@usetheo/ui'
import { useState } from 'react'

import type { RecipeView } from '../../shared/panel'
import { post } from '../lib/api'
import { useResource } from '../lib/live'

/**
 * What the project's `.factory/setup.json` asks for, read from its default branch. The panel's own
 * settings above win over it. Its domains reach the sandbox only once approved here, and the card shows
 * which ones would open before the owner says yes.
 */
export function RecipeCard({ fullName }: { fullName: string }) {
  const resource = useResource<RecipeView>(`/api/panel/repositories/${fullName}/recipe`, {
    stream: false,
    everyMs: 120_000,
  })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const view = resource.data

  async function approve(domains: string[]) {
    setBusy(true)
    setMessage(undefined)
    try {
      await post(`/api/panel/repositories/${fullName}/recipe`, { approve: domains })
      resource.reload()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (resource.error) return <p className="text-sm text-destructive">{resource.error}</p>
  if (!view) return <p className="text-sm text-muted-foreground">Reading .factory/setup.json…</p>
  if (view.problem) {
    return (
      <Alert intent="destructive" title="The recipe cannot be used" description={view.problem} />
    )
  }
  if (!view.recipe) {
    return (
      <p className="text-sm text-muted-foreground">
        No <code>.factory/setup.json</code> on the default branch, so the settings above are all a
        run uses.
      </p>
    )
  }
  const { recipe } = view
  return (
    <section aria-label="Recipe" className="space-y-2 text-sm">
      <h3 className="font-medium">
        From <code>.factory/setup.json</code> on the default branch
      </h3>
      {recipe.install ? (
        <p>
          Install: <code>{recipe.install}</code>
        </p>
      ) : null}
      {recipe.checks ? (
        <p>
          Checks, when none is set above:{' '}
          {recipe.checks.map((c) => (
            <code key={c.name} className="mr-2">
              {c.name}: {c.command}
            </code>
          ))}
        </p>
      ) : null}
      {recipe.egress.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {recipe.egress.map((domain) => (
            <li key={domain}>
              <Badge variant={view.pending.includes(domain) ? 'warning' : 'success'}>
                {domain} {view.pending.includes(domain) ? 'waits for you' : 'open'}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {view.pending.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <span>The next run would also reach {view.pending.join(', ')}.</span>
          <Button size="sm" disabled={busy} onClick={() => void approve(view.pending)}>
            Approve{' '}
            {view.pending.length === 1 ? 'this domain' : `these ${view.pending.length} domains`}
          </Button>
        </div>
      ) : null}
      {message ? (
        <p role="alert" className="text-destructive">
          {message}
        </p>
      ) : null}
    </section>
  )
}
