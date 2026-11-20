import type { StoppedLine } from '../../shared/panel'
import { useCopy } from '../lib/copy'
import { duration } from '../lib/format'

/**
 * The repositories whose line is stopped, above everything on the board: while one is, the factory works only
 * on its fix there, so the owner sees why nothing else moves.
 */
export function LineAlerts({ lines, now = new Date() }: { lines: StoppedLine[]; now?: Date }) {
  const { t } = useCopy()
  if (lines.length === 0) return null
  return (
    <div
      role="alert"
      aria-label={t.lineAlert.region}
      className="mb-4 rounded-md border border-destructive bg-background p-3 ring-1 ring-destructive/40"
    >
      <ul className="space-y-1 text-sm font-medium text-destructive">
        {lines.map((l) => (
          <li key={l.repository} data-line-alert={l.repository}>
            {(l.scope === 'fix_first' ? t.lineAlert.lineFixFirst : t.lineAlert.line)(
              l.repository,
              l.surface,
              duration((now.getTime() - Date.parse(l.since)) / 60_000),
            )}{' '}
            <a href={l.issueUrl} target="_blank" rel="noreferrer" className="underline">
              {l.status === 'escalated'
                ? t.lineAlert.person(l.issueNumber)
                : t.lineAlert.fix(l.issueNumber, l.attempts)}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
