import type { MetricBand, MetricRow, MetricsReport } from '../../shared/panel'
import { metricValue } from '../lib/format'
import { useResource } from '../lib/live'

const BAND: Record<MetricBand, { label: string; className: string }> = {
  no_baseline: { label: 'no baseline yet', className: 'text-muted-foreground' },
  in_band: { label: 'in band', className: 'text-foreground' },
  log: { label: 'drifting', className: 'text-foreground' },
  show: { label: 'out of band', className: 'font-medium text-foreground' },
  act: { label: 'issue opened', className: 'text-destructive' },
}

const where = (repository: string) => (repository === '*' ? 'All repositories' : repository)

function baseline(row: MetricRow): string {
  if (row.mean === null || row.sd === null) return '—'
  return `${metricValue(row.mean, row.unit)} ± ${metricValue(row.sd, row.unit)}`
}

/** The factory's own indicators, each latest day against its control band, and the signals worth a look. */
export function MetricsSection() {
  const metrics = useResource<MetricsReport>('/api/panel/metrics', {
    stream: false,
    everyMs: 60_000,
  })
  const data = metrics.data
  return (
    <section aria-label="Metrics">
      <h2 className="mb-2 text-sm font-semibold">Metrics</h2>
      {metrics.error ? <p className="text-sm text-destructive">{metrics.error}</p> : null}
      {!data ? null : data.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Not enough finished work to measure yet.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-1 pr-3">Indicator</th>
              <th className="py-1 pr-3">Repository</th>
              <th className="py-1 pr-3">Day</th>
              <th className="py-1 pr-3">Value</th>
              <th className="py-1 pr-3">Baseline</th>
              <th className="py-1 pr-3">Band</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={`${r.metric}-${r.repository}`} className="border-t border-border">
                <td className="py-1 pr-3 font-medium">{r.label}</td>
                <td className="py-1 pr-3">{where(r.repository)}</td>
                <td className="py-1 pr-3">{r.day}</td>
                <td className="py-1 pr-3">
                  {metricValue(r.value, r.unit)}
                  <span className="text-xs text-muted-foreground"> ({r.samples})</span>
                </td>
                <td className="py-1 pr-3">{baseline(r)}</td>
                <td className={`py-1 pr-3 ${BAND[r.band].className}`}>{BAND[r.band].label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.signals.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm">
          {data.signals.map((s) => (
            <li key={`${s.metric}-${s.repository}-${s.day}-${s.rule}`}>
              <span className="font-medium">{s.label}</span> in {where(s.repository)} broke{' '}
              <code>{s.rule}</code> on {s.day}
              {s.issueUrl ? (
                <>
                  {' '}
                  —{' '}
                  <a href={s.issueUrl} className="underline underline-offset-2">
                    issue
                  </a>
                </>
              ) : null}
              {s.error ? (
                <span className="text-destructive"> (issue not opened: {s.error})</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
