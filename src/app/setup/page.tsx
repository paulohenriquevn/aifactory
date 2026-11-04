import { Alert, Badge, Button } from '@usetheo/ui'
import { Link } from 'react-router'

import type { SetupItem, SetupReport } from '../../shared/panel'
import { useResource } from '../lib/live'

const TONE = { ok: 'success', warn: 'warning', missing: 'destructive' } as const
const WORD = { ok: 'ready', warn: 'check', missing: 'needed' } as const

function Row({ item }: { item: SetupItem }) {
  const external = item.link?.href.startsWith('http')
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm">
      <Badge variant={TONE[item.status]} className="whitespace-nowrap">
        {WORD[item.status]}
      </Badge>
      <span className="font-medium">{item.label}</span>
      <span className="text-muted-foreground">{item.detail}</span>
      {item.link ? (
        external ? (
          <a
            href={item.link.href}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-foreground underline underline-offset-2"
          >
            {item.link.label}
          </a>
        ) : (
          <Link
            to={item.link.href}
            className="ml-auto text-foreground underline underline-offset-2"
          >
            {item.link.label}
          </Link>
        )
      ) : null}
    </li>
  )
}

/** What stands between a fresh install and a first pull request, with the page that fixes each part. */
export default function SetupPage() {
  const report = useResource<SetupReport>('/api/panel/setup', { everyMs: 30_000, stream: false })
  const data = report.data
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Setup</h1>
        <Button size="sm" variant="secondary" onClick={report.reload}>
          Check again
        </Button>
      </div>
      {report.error ? <p className="text-sm text-destructive">{report.error}</p> : null}
      {data ? (
        <>
          {data.ready ? (
            <Alert
              intent="success"
              title="Ready to build"
              description="Plan the work, or open a job, and the factory takes it from there."
              action={
                <Link to="/plans" className="text-sm underline underline-offset-2">
                  Plan the work
                </Link>
              }
            />
          ) : (
            <Alert
              intent="warning"
              title="Not ready yet"
              description="Fix the lines marked needed, then check again."
            />
          )}
          <ul className="space-y-2">
            {data.items.map((item) => (
              <Row key={item.id} item={item} />
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
    </div>
  )
}
