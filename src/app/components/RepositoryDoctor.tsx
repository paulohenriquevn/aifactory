import { Badge, Button } from '@usetheo/ui'
import { useCallback, useEffect, useState } from 'react'

import type { ChecksProof, DoctorItem, DoctorReport, RepositoryView } from '../../shared/panel'
import { get, post } from '../lib/api'
import { useCopy } from '../lib/copy'
import { ago } from '../lib/format'
import { useResource } from '../lib/live'

const variant = { blocked: 'destructive', warn: 'warning', unknown: 'default' } as const

function Row({
  item,
  busy,
  onFix,
}: {
  item: DoctorItem
  busy: boolean
  onFix: (id: DoctorItem['id']) => void
}) {
  const { t } = useCopy()
  const status = item.status as 'blocked' | 'warn' | 'unknown'
  return (
    <li className="space-y-1 rounded-lg border border-border p-3" data-item={item.id}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={variant[status]}>{t.doctor[status]}</Badge>
        <span className="text-foreground">{item.cause}</span>
      </div>
      {item.repair ? (
        <p className="text-muted-foreground">
          {t.doctor.repair} {item.repair}
        </p>
      ) : null}
      <div className="flex gap-2">
        {item.link ? (
          <Button asChild size="sm" variant="secondary">
            <a href={item.link} target="_blank" rel="noreferrer">
              {t.doctor.open}
            </a>
          </Button>
        ) : null}
        {item.canRepair ? (
          <Button size="sm" disabled={busy} onClick={() => onFix(item.id)}>
            {busy ? t.doctor.fixing : t.doctor.fix}
          </Button>
        ) : null}
      </div>
    </li>
  )
}

/** What the doctor found in one repository, one row for each thing that is not fine. */
export function RepositoryDoctor({ repo }: { repo: RepositoryView }) {
  const { t, language } = useCopy()
  const base = `/api/panel/repositories/${repo.fullName}/doctor`
  const resource = useResource<DoctorReport>(base, { everyMs: 60_000, stream: false })
  const [fixed, setFixed] = useState<DoctorReport>()
  const [fixing, setFixing] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string>()

  // A newer read from the server replaces what a repair answered with.
  useEffect(() => setFixed(undefined), [resource.data])
  const report = fixed ?? resource.data

  async function fix(id: DoctorItem['id']) {
    setFixing(id)
    setMessage(undefined)
    try {
      setFixed(await post<DoctorReport>(`${base}/repair`, { item: id }))
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setFixing(undefined)
    }
  }

  function again() {
    setLoading(true)
    resource.reload()
  }
  useEffect(() => setLoading(false), [resource.data, resource.error])

  const rows = report?.items.filter((i) => i.status !== 'ok') ?? []
  const error = message ?? resource.error
  return (
    <section aria-label={t.doctor.title} className="mt-3 space-y-2 text-sm">
      <div className="flex items-center gap-3">
        <span className="font-medium text-foreground">{t.doctor.title}</span>
        <Button size="sm" variant="secondary" disabled={loading} onClick={again}>
          {loading ? t.doctor.checking : t.doctor.checkAgain}
        </Button>
      </div>
      {error ? <p className="text-destructive">{error}</p> : null}
      {!report && !error ? <p className="text-muted-foreground">{t.doctor.loading}</p> : null}
      {report && rows.length === 0 ? (
        <p className="text-foreground">
          {t.doctor.ready(
            language === 'pt-BR'
              ? new Date(report.at).toLocaleString('pt-BR')
              : ago(report.at, Date.now(), t.time),
          )}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="space-y-2">
          {rows.map((item) => (
            <Row key={item.id} item={item} busy={fixing === item.id} onFix={(id) => void fix(id)} />
          ))}
        </ul>
      ) : null}
    </section>
  )
}

/** Which saved checks no proof ran, and the button that proves them in a sandbox. */
export function ProveChecks({ repo }: { repo: RepositoryView }) {
  const { t } = useCopy()
  const base = `/api/panel/repositories/${repo.fullName}/checks/prove`
  const [proof, setProof] = useState<ChecksProof | null>()
  const [message, setMessage] = useState<string>()
  const [asked, setAsked] = useState(false)

  const read = useCallback(async () => {
    try {
      const answer = await get<{ proof: ChecksProof | null }>(base)
      setProof(answer.proof)
      return answer.proof
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [base])

  useEffect(() => {
    if (!asked) return
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      const current = await read()
      if (!stop && (!current || current.status === 'proving')) timer = setTimeout(tick, 3_000)
    }
    void tick()
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [asked, read])

  async function prove() {
    setMessage(undefined)
    const wanted = (repo.checks ?? []).filter((c) => repo.unprovenChecks.includes(c.name))
    try {
      await post(base, { checks: wanted })
      setAsked(true)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }

  const proving = asked && (!proof || proof.status === 'proving')
  const label = { passed: t.doctor.passed, failed: t.doctor.failed, too_slow: t.doctor.tooSlow }
  return (
    <div className="mt-3 space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-foreground">
          {repo.unprovenChecks.length > 0
            ? t.doctor.unprovenLine(repo.unprovenChecks.join(', '))
            : t.doctor.allProven}
        </span>
        {repo.unprovenChecks.length > 0 ? (
          <Button size="sm" variant="secondary" disabled={proving} onClick={() => void prove()}>
            {proving ? t.doctor.proving : t.doctor.prove}
          </Button>
        ) : null}
      </div>
      {message ? <p className="text-destructive">{message}</p> : null}
      {proof?.status === 'failed' ? (
        <p className="text-destructive">{t.doctor.proofFailed(proof.error ?? '')}</p>
      ) : null}
      {proof && proof.results.length > 0 ? (
        <ul className="space-y-2">
          {proof.results.map((r) => (
            <li key={r.name} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={r.status === 'passed' ? 'success' : 'destructive'}>
                  {label[r.status]}
                </Badge>
                <span className="text-foreground">{r.name}</span>
                <span className="text-muted-foreground">
                  {t.doctor.seconds((r.durationMs / 1000).toFixed(1))}
                </span>
              </div>
              {r.output ? (
                <pre className="mt-1 overflow-x-auto font-mono text-muted-foreground">
                  {r.output}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
