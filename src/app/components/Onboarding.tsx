import { Alert, Badge, Button, Input, Stepper, type StepperStepData } from '@usetheo/ui'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import type {
  DoctorReport,
  RepositoriesView,
  RepositoryView,
  SetupItem,
  SetupReport,
} from '../../shared/panel'
import type { KnowledgeStatus } from '../../shared/knowledge'
import { get, put } from '../lib/api'
import { useCopy } from '../lib/copy'
import { useResource } from '../lib/live'

import { NewJob } from './NewJob'
import { RepositoryDoctor } from './RepositoryDoctor'

const STEP_IDS = ['connect', 'choose', 'enable'] as const

/** Each step is done only when it and every step before it are. */
export const inOrder = (done: boolean[]): boolean[] =>
  done.map((_, i) => done.slice(0, i + 1).every(Boolean))

/** The text and the link of one thing GitHub still needs. */
function Pending({ item }: { item: SetupItem }) {
  const external = item.link?.href.startsWith('http')
  const style = 'text-foreground underline underline-offset-2'
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm">
      <span className="font-medium">{item.label}</span>
      <span className="text-muted-foreground">{item.detail}</span>
      {item.link && external ? (
        <a href={item.link.href} target="_blank" rel="noreferrer" className={style}>
          {item.link.label}
        </a>
      ) : item.link ? (
        <Link to={item.link.href} className={style}>
          {item.link.label}
        </Link>
      ) : null}
    </li>
  )
}

function Connect({ report }: { report: SetupReport | undefined }) {
  const { t } = useCopy()
  if (!report) return <p className="text-muted-foreground">{t.onboarding.connect.loading}</p>
  const pending = report.items.filter((i) => i.status !== 'ok')
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground">{t.onboarding.connect.about}</p>
      {report.ready ? (
        <Alert intent="success" title={t.onboarding.connect.ready} />
      ) : (
        <ul className="space-y-2">
          {pending.map((item) => (
            <Pending key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  )
}

function Choose({
  view,
  hidden,
  enabled,
  readOnly,
  onChanged,
}: {
  view: RepositoriesView | undefined
  hidden: string | null
  enabled: RepositoryView | undefined
  readOnly: boolean
  onChanged: () => void
}) {
  const { t } = useCopy()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string>()
  const [message, setMessage] = useState<string>()
  if (!view) return <p className="text-muted-foreground">{t.onboarding.choose.loading}</p>
  if (enabled)
    return <p className="text-foreground">{t.onboarding.choose.chosen(enabled.fullName)}</p>

  const offered = view.repositories.filter(
    (r) => r.reachable && r.fullName.toLowerCase() !== hidden?.toLowerCase(),
  )
  const shown = offered.filter((r) => r.fullName.toLowerCase().includes(query.trim().toLowerCase()))

  async function pick(repo: RepositoryView) {
    setBusy(repo.fullName)
    setMessage(undefined)
    try {
      await put(`/api/panel/repositories/${repo.fullName}`, { enabled: true })
      onChanged()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground">{t.onboarding.choose.about}</p>
      {offered.length === 0 ? (
        <p className="text-muted-foreground">{t.onboarding.choose.empty}</p>
      ) : (
        <>
          <Input
            aria-label={t.onboarding.choose.search}
            placeholder={t.onboarding.choose.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full"
          />
          {shown.length === 0 ? (
            <p className="text-muted-foreground">{t.onboarding.choose.none}</p>
          ) : (
            <ul aria-label={t.onboarding.steps.choose} className="space-y-2">
              {shown.map((repo) => (
                <li
                  key={repo.fullName}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card p-3"
                >
                  <span className="font-medium">{repo.fullName}</span>
                  <Badge variant="default">
                    {repo.private ? t.onboarding.choose.private : t.onboarding.choose.public}
                  </Badge>
                  <Button
                    size="sm"
                    className="ml-auto"
                    disabled={readOnly || busy !== undefined}
                    onClick={() => void pick(repo)}
                  >
                    {busy === repo.fullName
                      ? t.onboarding.choose.picking
                      : t.onboarding.choose.pick}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {message ? (
        <p role="alert" className="text-destructive">
          {message}
        </p>
      ) : null}
    </div>
  )
}

/** Three steps from a fresh install to a repository that can take its first job, without a form. */
export function Onboarding() {
  const { t } = useCopy()
  const navigate = useNavigate()
  const setup = useResource<SetupReport>('/api/panel/setup', { everyMs: 30_000, stream: false })
  const repos = useResource<RepositoriesView>('/api/panel/repositories', {
    everyMs: 30_000,
    stream: false,
  })
  // The knowledge repository is never a project. null: no one chosen; undefined: not read yet.
  const [knowledge, setKnowledge] = useState<string | null>()
  const [report, setReport] = useState<DoctorReport>()
  const [viewing, setViewing] = useState<number>()

  useEffect(() => {
    let alive = true
    get<KnowledgeStatus>('/api/panel/knowledge')
      .then((s) => alive && setKnowledge(s.repository))
      .catch(() => alive && setKnowledge(null))
    return () => {
      alive = false
    }
  }, [])

  const chosen = repos.data?.repositories.find(
    (r) => r.enabled && r.fullName.toLowerCase() !== knowledge?.toLowerCase(),
  )
  const blocked = report?.items.some((i) => i.status === 'blocked') ?? true
  const notRead = report?.items.some((i) => i.status === 'unknown') ?? false
  // A step counts only when every step before it does: a step ahead of one still being read is not known.
  const complete = inOrder([
    setup.data?.ready === true,
    chosen !== undefined,
    chosen !== undefined && report?.fullName === chosen.fullName && !blocked,
  ])
  const current = complete.findIndex((c) => !c)
  const active = current === -1 ? STEP_IDS.length - 1 : current
  const shown = viewing !== undefined && complete[viewing] ? viewing : active
  const readOnly = shown !== active

  const steps: StepperStepData[] = STEP_IDS.map((id, i) => ({
    id,
    label: t.onboarding.steps[id],
    status: complete[i] ? 'done' : i === current ? 'active' : 'pending',
  }))

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t.onboarding.title}</h1>
      <Stepper
        label={t.onboarding.stepsLabel}
        steps={steps}
        orientation="horizontal"
        stateLabels={t.onboarding.stepState}
      />
      <div className="flex gap-2">
        {STEP_IDS.map((id, i) =>
          complete[i] && i !== shown ? (
            <Button key={id} size="sm" variant="secondary" onClick={() => setViewing(i)}>
              {t.onboarding.reopen}: {t.onboarding.steps[id]}
            </Button>
          ) : null,
        )}
      </div>
      {(setup.error ?? repos.error) ? (
        <p className="text-sm text-destructive">{setup.error ?? repos.error}</p>
      ) : null}
      <section aria-label={t.onboarding.steps[STEP_IDS[shown]!]} className="space-y-3 text-sm">
        <h2 className="text-base font-medium">{t.onboarding.steps[STEP_IDS[shown]!]}</h2>
        {shown === 0 ? <Connect report={setup.data} /> : null}
        {shown === 1 ? (
          <Choose
            view={knowledge === undefined ? undefined : repos.data}
            hidden={knowledge ?? null}
            enabled={chosen}
            readOnly={readOnly}
            onChanged={repos.reload}
          />
        ) : null}
        {shown === 2 && chosen ? (
          <>
            <p className="text-muted-foreground">{t.onboarding.enable.about(chosen.fullName)}</p>
            <RepositoryDoctor repo={chosen} onReport={setReport} />
            {notRead ? (
              <p className="text-muted-foreground">{t.onboarding.enable.notRead}</p>
            ) : null}
            {complete[2] ? (
              <div className="space-y-2">
                <p className="text-foreground">{t.onboarding.enable.ready}</p>
                <NewJob
                  repository={chosen.fullName}
                  label={t.onboarding.enable.firstJob}
                  onCreated={() => void navigate('/work')}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  )
}
