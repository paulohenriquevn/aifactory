import { Button } from '@usetheo/ui'
import { useState } from 'react'
import { Link } from 'react-router'

import type { AgentRole, AgentSettings } from '../../../shared/panel'
import { put } from '../../lib/api'

const SAME = ''

const ROLE_LABEL: Record<AgentRole, string> = {
  builder: 'Agente de código do Construtor',
  planner: 'Agente de código do Planejador',
  reviewer: 'Agente de código do Revisor',
}

const ROLE_NAME: Record<AgentRole, string> = {
  builder: 'Construtor',
  planner: 'Planejador',
  reviewer: 'Revisor',
}

const select = 'h-9 min-w-52 rounded-lg border border-border bg-card px-2 text-sm text-foreground'
const caption = 'mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground'

/**
 * The choice of which coding agent does a role, with which model and how much effort. It is saved in the
 * panel and applied to the next run with no restart. An agent that cannot start (its credential is missing)
 * is listed but cannot be picked, with what is missing, because a choice that breaks every run is worse than
 * none. The models and the effort levels are the ones of the agent chosen, and change with it, because a
 * model of one agent means nothing to the other. Planner and reviewer can follow the builder.
 */
export function EngineChooser({
  role,
  settings,
  onSaved,
}: {
  role: AgentRole
  settings: AgentSettings
  onSaved: () => void
}) {
  const stored = settings.chosen[role]
  const current = role === 'builder' ? settings.effective.builder : (stored ?? SAME)
  const currentModel = settings.chosenModel[role] ?? SAME
  const currentEffort = settings.chosenEffort[role] ?? SAME
  const [value, setValue] = useState(current)
  const [model, setModel] = useState(currentModel)
  const [effort, setEffort] = useState(currentEffort)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string }>()
  const changed = value !== current || model !== currentModel || effort !== currentEffort
  const unavailable = settings.options.filter((o) => !o.ready)
  const own = settings.repositoriesWithOwn.filter((r) =>
    role === 'reviewer' ? r.reviewer : r.builder,
  )

  // The agent this role will use, which is the one whose models and effort levels are on offer.
  const engine = value === SAME ? settings.effective.builder : value
  const offered = settings.engines[engine] ?? { models: [], efforts: [] }
  const picked = offered.models.find((m) => m.id === model)
  const levels = picked?.efforts ?? offered.efforts

  function chooseEngine(next: string) {
    setValue(next)
    // A model and an effort belong to one agent: they do not carry over to another.
    setModel(SAME)
    setEffort(SAME)
  }

  function chooseModel(next: string) {
    setModel(next)
    const nextLevels = offered.models.find((m) => m.id === next)?.efforts ?? offered.efforts
    if (!nextLevels.includes(effort)) setEffort(SAME)
  }

  async function save() {
    setBusy(true)
    setMessage(undefined)
    try {
      await put('/api/panel/agents/settings', {
        ...(value === current ? {} : { [role]: value === SAME ? null : value }),
        models: { [role]: model === SAME ? null : model },
        efforts: { [role]: effort === SAME ? null : effort },
      })
      setMessage({
        ok: true,
        text: 'Salvo. Vale para as próximas execuções, sem reiniciar. As que estão rodando terminam como começaram.',
      })
      onSaved()
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-label={`Escolha: ${ROLE_LABEL[role]}`}
      className="space-y-3 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className={caption}>{ROLE_LABEL[role]}</span>
          <select
            aria-label={ROLE_LABEL[role]}
            className={select}
            value={value}
            onChange={(e) => chooseEngine(e.target.value)}
          >
            {role === 'builder' ? null : (
              <option value={SAME}>O mesmo do Construtor ({settings.effective.builder})</option>
            )}
            {settings.options.map((o) => (
              <option key={o.id} value={o.id} disabled={!o.ready}>
                {o.id}
                {o.ready ? '' : ' (indisponível)'}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={caption}>Modelo</span>
          <select
            aria-label={`Modelo do ${ROLE_NAME[role]}`}
            className={select}
            value={model}
            onChange={(e) => chooseModel(e.target.value)}
          >
            <option value={SAME}>Padrão do agente</option>
            {offered.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={caption}>Esforço</span>
          <select
            aria-label={`Esforço do ${ROLE_NAME[role]}`}
            className={`${select} min-w-36`}
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
          >
            <option value={SAME}>Padrão</option>
            {levels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" disabled={!changed || busy} onClick={() => void save()}>
          Salvar
        </Button>
      </div>

      {picked?.note ? <p className="text-xs text-muted-foreground">{picked.note}</p> : null}
      {offered.models.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          A lista de modelos de {engine} não está disponível aqui: ele usa o próprio padrão.
        </p>
      ) : null}

      {unavailable.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {unavailable.map((o) => (
            <li key={o.id}>
              <span className="font-mono">{o.id}</span> não pode ser escolhido: {o.problem}
            </li>
          ))}
        </ul>
      ) : null}

      {own.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Estes repositórios têm um agente próprio, que vale mais do que esta escolha:{' '}
          {own.map((r) => r.repository).join(', ')}.{' '}
          <Link to="/repositories" className="underline underline-offset-2">
            Mudar em Repositórios
          </Link>
        </p>
      ) : null}

      {message ? (
        <p
          role={message.ok ? 'status' : 'alert'}
          className={`text-sm ${message.ok ? 'text-foreground' : 'text-destructive'}`}
        >
          {message.text}
        </p>
      ) : null}
    </section>
  )
}
