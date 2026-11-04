import { Link, useParams } from 'react-router'

import type { TaskDetail } from '../../../shared/panel'
import { Pass, StageBadge } from '../../components/Badges'
import { WatchPanel } from '../../components/WatchPanel'
import { TaskActions } from '../../components/TaskActions'
import { ago, describeEvent, money, shortSha } from '../../lib/format'
import { useResource } from '../../lib/live'

export default function TaskPage() {
  const id = Number(useParams().id)
  const resource = useResource<TaskDetail>(`/api/panel/tasks/${id}`, { only: id })
  const detail = resource.data

  if (resource.error) return <p className="text-sm text-red-700">{resource.error}</p>
  if (!detail) return <p className="text-sm text-slate-500">Loading…</p>
  const { task } = detail

  return (
    <div className="space-y-6">
      <div>
        <Link to="/" className="text-sm text-slate-500 hover:text-slate-800">
          ← Board
        </Link>
        <h1 className="mt-1 text-xl font-semibold">{task.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-600">
          <span>
            {task.repository} #{task.issueNumber}
          </span>
          <StageBadge stage={task.stage} />
          <span>{money(task.costUsd)}</span>
          {task.attempts > 0 ? <span>{task.attempts} of 3 attempts</span> : null}
          {task.headSha ? <code>{shortSha(task.headSha)}</code> : null}
          {task.preRelease ? (
            <a
              href={task.preRelease.url}
              className="text-violet-700 underline"
              target="_blank"
              rel="noreferrer"
            >
              Pre-release {task.preRelease.tag}
            </a>
          ) : null}
          {task.release ? (
            <a
              href={task.release.url}
              className="font-medium text-violet-800 underline"
              target="_blank"
              rel="noreferrer"
            >
              Release {task.release.tag}
            </a>
          ) : null}
          {task.pullRequestUrl ? (
            <a
              href={task.pullRequestUrl}
              className="text-blue-700 underline"
              target="_blank"
              rel="noreferrer"
            >
              Pull request
            </a>
          ) : null}
        </div>
      </div>

      <TaskActions detail={detail} onDone={resource.reload} />

      <WatchPanel watches={detail.watches} onDone={resource.reload} />

      {detail.questions.length > 0 ? (
        <section aria-label="Questions">
          <h2 className="mb-2 text-sm font-semibold">Questions</h2>
          <ul className="space-y-3">
            {detail.questions.map((q) => (
              <li key={q.id} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                <p className="whitespace-pre-wrap">{q.body}</p>
                <p className="mt-2 text-slate-700">
                  {q.answer
                    ? `${q.answeredBy} answered: ${q.answer}`
                    : 'Reply in a comment on the issue, as someone with write access.'}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {detail.deliveries.length > 0 ? (
        <section aria-label="Deliveries">
          <h2 className="mb-2 text-sm font-semibold">Deliveries</h2>
          <ul className="space-y-1 text-sm">
            {detail.deliveries.map((d) => (
              <li key={d.id}>
                <span className="font-medium">
                  {d.kind === 'release' ? 'Release' : 'Pre-release'}
                </span>{' '}
                <a
                  href={d.url}
                  className="text-blue-700 underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  {d.tag}
                </a>{' '}
                <span className="text-xs text-slate-500">
                  on {shortSha(d.sha)} by {d.actor} · {ago(d.at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Timeline">
        <h2 className="mb-2 text-sm font-semibold">Timeline</h2>
        <ol className="space-y-1 border-l border-slate-200 pl-4">
          {detail.timeline.map((event) => (
            <li key={event.id} className="text-sm">
              <span className="font-medium">{event.stage}</span>{' '}
              <span className="text-xs text-slate-400">{ago(event.at)}</span>
              {describeEvent(event) ? (
                <div className="whitespace-pre-wrap text-slate-600">{describeEvent(event)}</div>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      {detail.runs.length > 0 ? (
        <section aria-label="Executions">
          <h2 className="mb-2 text-sm font-semibold">Executions</h2>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1 pr-3">Role</th>
                <th className="py-1 pr-3">Agent</th>
                <th className="py-1 pr-3">Attempt</th>
                <th className="py-1 pr-3">Cost</th>
                <th className="py-1 pr-3">Time</th>
                <th className="py-1 pr-3">Result</th>
              </tr>
            </thead>
            <tbody>
              {detail.runs.map((r) => (
                <tr key={r.id} className="border-t border-slate-200">
                  <td className="py-1 pr-3">{r.role}</td>
                  <td className="py-1 pr-3">{r.harness}</td>
                  <td className="py-1 pr-3">{r.attempt}</td>
                  <td className="py-1 pr-3">
                    {r.costUsd === null ? (
                      <span className="text-slate-500">not reported</span>
                    ) : (
                      money(r.costUsd)
                    )}
                  </td>
                  <td className="py-1 pr-3">{(r.durationMs / 1000).toFixed(1)} s</td>
                  <td className="py-1 pr-3">
                    {r.quota ? 'out of quota' : r.ok ? 'finished' : 'failed'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section aria-label="Evidence">
        <h2 className="mb-2 text-sm font-semibold">Evidence</h2>
        {detail.evidence.length === 0 ? (
          <p className="text-sm text-slate-500">No checks have run yet.</p>
        ) : (
          <ul className="space-y-2">
            {detail.evidence.map((e) => (
              <li key={e.id} className="rounded border border-slate-200 bg-white p-3 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <code>{e.command}</code>
                  <Pass ok={e.passed} />
                  <span className="text-xs text-slate-500">
                    on {shortSha(e.sha)} · exit {e.exitCode} · {(e.durationMs / 1000).toFixed(1)} s
                  </span>
                </div>
                {e.output ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-slate-500">Output</summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100">
                      {e.output}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Reviews">
        <h2 className="mb-2 text-sm font-semibold">Reviews</h2>
        {detail.reviews.length === 0 ? (
          <p className="text-sm text-slate-500">Not reviewed yet.</p>
        ) : (
          <ul className="space-y-2">
            {detail.reviews.map((r) => (
              <li key={r.id} className="rounded border border-slate-200 bg-white p-3 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium">
                    Attempt {r.round}: {r.verdict}
                  </span>
                  <span className="text-xs text-slate-500">
                    {r.reviewer} on {shortSha(r.sha)}
                  </span>
                </div>
                <p className="mt-1 text-slate-700">{r.summary}</p>
                {r.findings.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700">
                    {r.findings.map((f, i) => (
                      <li key={i}>
                        <strong>{f.severity}</strong>
                        {f.file ? <code> {f.file}</code> : null}: {f.issue}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
