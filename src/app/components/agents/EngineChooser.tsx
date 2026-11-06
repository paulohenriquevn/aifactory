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

const select = 'h-9 min-w-52 rounded-lg border border-border bg-card px-2 text-sm text-foreground'

/**
 * The choice of which coding agent does a role, saved in the panel and applied to the next run with no restart.
 * An agent that cannot start (its credential is missing) is listed but cannot be picked, with what is missing,
 * because a choice that breaks every run is worse than none. Planner and reviewer can follow the builder.
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
  const [value, setValue] = useState(current)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string }>()
  const changed = value !== current
  const unavailable = settings.options.filter((o) => !o.ready)
  const own = settings.repositoriesWithOwn.filter((r) =>
    role === 'reviewer' ? r.reviewer : r.builder,
  )

  async function save() {
    setBusy(true)
    setMessage(undefined)
    try {
      await put('/api/panel/agents/settings', { [role]: value === SAME ? null : value })
      setMessage({
        ok: true,
        text: 'Salvo. Vale para as próximas execuções, sem reiniciar. As que estão rodando terminam com o agente antigo.',
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
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {ROLE_LABEL[role]}
          </span>
          <select
            aria-label={ROLE_LABEL[role]}
            className={select}
            value={value}
            onChange={(e) => setValue(e.target.value)}
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
        <Button size="sm" disabled={!changed || busy} onClick={() => void save()}>
          Salvar
        </Button>
      </div>

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
