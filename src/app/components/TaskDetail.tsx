import type { ReactNode } from 'react'

import { columnOf, type ReviewView, type RunView, type TaskDetail } from '../../shared/panel'
import { Pass, StageBadge } from './Badges'
import { PlanSection } from './PlanSection'
import { WatchPanel } from './WatchPanel'
import { TaskActions } from './TaskActions'
import { Transcript } from './Transcript'
import { ago, describeEvent, money, shortSha } from '../lib/format'
import { useCopy } from '../lib/copy'
import { useResource } from '../lib/live'

/**
 * Everything about one task: where it is, what it cost, what it did, and what a person can do. It is
 * shown in the side panel of the board and as a page of its own, so it takes the heading above it
 * (the way back) from whoever shows it.
 */
export function TaskDetailView({ id, above }: { id: number; above?: ReactNode }) {
  const { t } = useCopy()
  const resource = useResource<TaskDetail>(`/api/panel/tasks/${id}`, { only: id })
  const detail = resource.data

  if (resource.error) return <p className="text-sm text-destructive">{resource.error}</p>
  if (!detail) return <p className="text-sm text-muted-foreground">{t.task.loading}</p>
  const { task } = detail

  return (
    <div className="space-y-6">
      <div>
        {above}
        <h1 className="mt-1 text-xl font-semibold">{task.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span>
            {task.repository} #{task.issueNumber}
          </span>
          <StageBadge
            stage={task.stage}
            integrated={task.integrated}
            waitingForChecks={task.waitingForChecks}
            resolved={task.resolved}
            retryable={task.retryable}
          />
          <span>{money(task.costUsd)}</span>
          {task.attempts > 0 ? <span>{t.task.attempts(task.attempts)}</span> : null}
          {task.headSha ? <code>{shortSha(task.headSha)}</code> : null}
          {task.preRelease ? (
            <a
              href={task.preRelease.url}
              className="text-foreground underline underline-offset-2"
              target="_blank"
              rel="noreferrer"
            >
              {t.task.preRelease(task.preRelease.tag)}
            </a>
          ) : null}
          {task.release ? (
            <a
              href={task.release.url}
              className="font-medium text-foreground underline underline-offset-2"
              target="_blank"
              rel="noreferrer"
            >
              {t.task.release(task.release.tag)}
            </a>
          ) : null}
          {task.pullRequestUrl ? (
            <a
              href={task.pullRequestUrl}
              className="text-foreground underline underline-offset-2"
              target="_blank"
              rel="noreferrer"
            >
              {t.task.pullRequest}
            </a>
          ) : null}
        </div>
      </div>

      <TaskActions detail={detail} onDone={resource.reload} />

      <WatchPanel watches={detail.watches} onDone={resource.reload} />

      {detail.questions.length > 0 ? (
        <section aria-label={t.task.questions}>
          <h2 className="mb-2 text-sm font-semibold">{t.task.questions}</h2>
          <ul className="space-y-3">
            {detail.questions.map((q) => (
              <li
                key={q.id}
                className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
              >
                <p className="whitespace-pre-wrap">{q.body}</p>
                <p className="mt-2 text-foreground">
                  {q.answer ? t.task.answered(q.answeredBy ?? '', q.answer) : t.task.replyHint}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {detail.deliveries.length > 0 ? (
        <section aria-label={t.task.deliveries}>
          <h2 className="mb-2 text-sm font-semibold">{t.task.deliveries}</h2>
          <ul className="space-y-1 text-sm">
            {detail.deliveries.map((d) => (
              <li key={d.id}>
                <span className="font-medium">
                  {d.kind === 'release' ? t.task.deliveryRelease : t.task.deliveryPreRelease}
                </span>{' '}
                <a
                  href={d.url}
                  className="text-foreground underline underline-offset-2"
                  target="_blank"
                  rel="noreferrer"
                >
                  {d.tag}
                </a>{' '}
                <span className="text-xs text-muted-foreground">
                  {t.task.deliveryMeta(shortSha(d.sha), d.actor, ago(d.at))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label={t.task.timeline}>
        <h2 className="mb-2 text-sm font-semibold">{t.task.timeline}</h2>
        <ol className="space-y-1 border-l border-border pl-4">
          {detail.timeline.map((event) => (
            <li key={event.id} className="text-sm">
              <span className="font-medium">{event.stage}</span>{' '}
              <span className="text-xs text-muted-foreground">{ago(event.at)}</span>
              {describeEvent(event) ? (
                <div className="whitespace-pre-wrap text-muted-foreground">
                  {describeEvent(event)}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      <section aria-label={t.task.transcript}>
        <h2 className="mb-2 text-sm font-semibold">{t.task.transcript}</h2>
        <Transcript taskId={task.id} live={columnOf(task.stage) === 'working'} />
      </section>

      {detail.runs.length > 0 ? (
        <section aria-label={t.task.executions}>
          <h2 className="mb-2 text-sm font-semibold">{t.task.executions}</h2>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-3">{t.task.role}</th>
                <th className="py-1 pr-3">{t.task.agent}</th>
                <th className="py-1 pr-3">{t.task.model}</th>
                <th className="py-1 pr-3">{t.task.attempt}</th>
                <th className="py-1 pr-3">{t.task.tokens}</th>
                <th className="py-1 pr-3">{t.task.cost}</th>
                <th className="py-1 pr-3">{t.task.time}</th>
                <th className="py-1 pr-3">{t.task.result}</th>
              </tr>
            </thead>
            <tbody>
              {detail.runs.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="py-1 pr-3">{r.role}</td>
                  <td className="py-1 pr-3">{r.harness}</td>
                  <td className="py-1 pr-3">{modelOf(r, t.task.defaultModel)}</td>
                  <td className="py-1 pr-3">{r.attempt}</td>
                  <td className="py-1 pr-3">
                    {r.tokensIn === null && r.tokensOut === null ? (
                      <span className="text-muted-foreground">{t.task.notReported}</span>
                    ) : (
                      `${r.tokensIn ?? '?'} / ${r.tokensOut ?? '?'}`
                    )}
                  </td>
                  <td className="py-1 pr-3">
                    {r.costUsd === null ? (
                      <span className="text-muted-foreground">{t.task.notReported}</span>
                    ) : (
                      money(r.costUsd)
                    )}
                  </td>
                  <td className="py-1 pr-3">{t.task.seconds((r.durationMs / 1000).toFixed(1))}</td>
                  <td className="py-1 pr-3">
                    {r.quota ? t.task.outOfQuota : r.ok ? t.task.finished : t.task.failed}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section aria-label={t.task.evidence}>
        <h2 className="mb-2 text-sm font-semibold">{t.task.evidence}</h2>
        {detail.evidence.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.task.noChecks}</p>
        ) : (
          <ul className="space-y-2">
            {detail.evidence.map((e) => (
              <li key={e.id} className="rounded border border-border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <code>{e.command}</code>
                  <Pass ok={e.passed} />
                  <span className="text-xs text-muted-foreground">
                    {t.task.evidenceMeta(
                      shortSha(e.sha),
                      e.exitCode,
                      (e.durationMs / 1000).toFixed(1),
                    )}
                  </span>
                </div>
                {e.output ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      {t.task.output}
                    </summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-xs text-foreground">
                      {e.output}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <PlanSection plans={detail.plans} />

      <section aria-label={t.task.reviews}>
        <h2 className="mb-2 text-sm font-semibold">{t.task.reviews}</h2>
        {detail.reviews.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.task.notReviewed}</p>
        ) : (
          <ul className="space-y-2">
            {detail.reviews.map((r) => (
              <li key={r.id} className="rounded border border-border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium">{t.task.reviewLine(r.round, r.verdict)}</span>
                  <span className="text-xs text-muted-foreground">
                    {t.task.reviewedOn(r.reviewer, shortSha(r.sha))}
                    {modelLine(detail.runs, r, t.task.defaultModel)}
                  </span>
                </div>
                <p className="mt-1 text-foreground">{r.summary}</p>
                {r.findings.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-foreground">
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

/** The model and effort a pass ran with, said as one line; the agent's own default when none was chosen. */
function modelOf(run: RunView, fallback: string): string {
  if (!run.model && !run.effort) return fallback
  return [run.model ?? fallback, run.effort].filter(Boolean).join(' · ')
}

/**
 * The agent pass that made a review: the latest reviewer run of that agent at or before the review was
 * written. Attempts restart at one when a task is retried, so the time is what tells the runs apart.
 */
function reviewRun(runs: RunView[], r: ReviewView): RunView | undefined {
  const reviewedAt = Date.parse(r.at)
  return runs
    .filter(
      (x) => x.role === 'reviewer' && x.harness === r.reviewer && Date.parse(x.at) <= reviewedAt,
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
}

function modelLine(runs: RunView[], r: ReviewView, fallback: string): string {
  const run = reviewRun(runs, r)
  return run ? ` · ${modelOf(run, fallback)}` : ''
}
