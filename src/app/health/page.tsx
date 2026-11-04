import { useState } from 'react'
import { Link } from 'react-router'

import type { FindingView, HealthReport } from '../../shared/panel'
import { post } from '../lib/api'
import { ago, money } from '../lib/format'
import { useResource } from '../lib/live'

type Action = 'retry' | 'resume' | 'delete_snapshot' | 'mark_revert_unknown'

const KIND: Record<FindingView['subject'], string> = {
  run: 'A run stopped moving',
  queued_run: 'A task is queued and nothing will run it',
  answer_resume: 'An answer was never resumed',
  snapshot: 'A snapshot nothing needs',
  revert: 'A revert was never confirmed',
}

/** What a person can do about each kind of finding, and how sure they should be first. */
const ACTION: Record<FindingView['subject'], { action: Action; label: string; confirm?: string }> =
  {
    run: {
      action: 'retry',
      label: 'Start again',
      confirm:
        'Start this task again? Its branch is deleted. If the run is somehow still alive, two would race.',
    },
    queued_run: { action: 'retry', label: 'Start again' },
    answer_resume: { action: 'resume', label: 'Resume again' },
    snapshot: {
      action: 'delete_snapshot',
      label: 'Delete the snapshot',
      confirm: 'Delete this snapshot? It cannot be recovered.',
    },
    revert: { action: 'mark_revert_unknown', label: 'Show it as red' },
  }

function FindingRow({ finding, onDone }: { finding: FindingView; onDone: () => void }) {
  const [message, setMessage] = useState<string>()
  const todo = ACTION[finding.subject]

  async function resolve() {
    if (todo.confirm && !window.confirm(todo.confirm)) return
    try {
      await post(`/api/panel/findings/${finding.id}/resolve`, { action: todo.action })
      onDone()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <li className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          <span className="mr-2 rounded bg-amber-200 px-1.5 py-0.5 text-xs uppercase">
            {finding.kind}
          </span>
          {KIND[finding.subject]}
        </span>
        <span className="text-xs text-slate-500">since {ago(finding.firstSeenAt)}</span>
      </div>
      {finding.taskId !== null ? (
        <div className="mt-1 text-xs">
          <Link to={`/tasks/${finding.taskId}`} className="text-blue-700 underline">
            {finding.taskTitle ?? `Task ${finding.taskId}`}
          </Link>
        </div>
      ) : null}
      <p className="mt-1 text-slate-700">{finding.detail}</p>
      <button
        type="button"
        onClick={() => void resolve()}
        className="mt-2 rounded border border-slate-300 bg-white px-3 py-1 text-xs hover:bg-slate-100"
      >
        {todo.label}
      </button>
      {message ? (
        <p role="status" className="mt-2 text-red-700">
          {message}
        </p>
      ) : null}
    </li>
  )
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

export default function HealthPage() {
  const report = useResource<HealthReport>('/api/panel/health')
  const data = report.data
  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold">Health</h1>
      {report.error ? <p className="text-sm text-red-700">{report.error}</p> : null}
      {!data ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <>
          <section aria-label="Findings">
            <h2 className="mb-2 text-sm font-semibold">Findings</h2>
            {data.findings.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing is wrong with the factory right now.</p>
            ) : (
              <ul className="space-y-2">
                {data.findings.map((f) => (
                  <FindingRow key={f.id} finding={f} onDone={report.reload} />
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Cost">
            <h2 className="mb-2 text-sm font-semibold">Cost</h2>
            <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              {[
                ['Last 24 hours', money(data.cost.last24HoursUsd)],
                ['Last 7 days', money(data.cost.last7DaysUsd)],
                ['All time', money(data.cost.totalUsd)],
                [`Per task (${data.cost.tasks})`, money(data.cost.avgPerTaskUsd)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-slate-200 bg-white p-3">
                  <dt className="text-xs text-slate-500">{label}</dt>
                  <dd className="mt-1 text-lg font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
            {data.cost.groups.length > 0 ? (
              <table className="mt-4 w-full text-left text-sm">
                <thead className="text-xs text-slate-500">
                  <tr>
                    <th className="py-1 pr-3">Agent</th>
                    <th className="py-1 pr-3">Role</th>
                    <th className="py-1 pr-3">Runs</th>
                    <th className="py-1 pr-3">Cost</th>
                    <th className="py-1 pr-3">Average time</th>
                    <th className="py-1 pr-3">Failed</th>
                    <th className="py-1 pr-3">Out of quota</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cost.groups.map((g) => (
                    <tr key={`${g.harness}-${g.role}`} className="border-t border-slate-200">
                      <td className="py-1 pr-3 font-medium">{g.harness}</td>
                      <td className="py-1 pr-3">{g.role}</td>
                      <td className="py-1 pr-3">{g.runs}</td>
                      <td className="py-1 pr-3">
                        {g.reportedRuns === 0 ? (
                          <span className="text-slate-500">not reported</span>
                        ) : (
                          money(g.costUsd)
                        )}
                        {g.reportedRuns > 0 && g.reportedRuns < g.runs ? (
                          <span className="text-xs text-slate-500">
                            {' '}
                            ({g.reportedRuns} of {g.runs} reported)
                          </span>
                        ) : null}
                      </td>
                      <td className="py-1 pr-3">{seconds(g.avgDurationMs)}</td>
                      <td className="py-1 pr-3">{g.failed}</td>
                      <td className="py-1 pr-3">{g.quota}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No agent has run yet.</p>
            )}
          </section>
        </>
      )}
    </div>
  )
}
