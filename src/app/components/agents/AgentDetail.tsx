import { Badge } from '@usetheo/ui'
import { useState } from 'react'

import type { AgentEntry, AgentPrompt, AgentRole, AgentSettings } from '../../../shared/panel'

import { EngineChooser } from './EngineChooser'
import { PromptBlock } from './PromptBlock'

const ROLES = ['builder', 'planner', 'reviewer'] as const satisfies readonly AgentRole[]
const roleOf = (id: string): AgentRole | undefined => ROLES.find((r) => r === id)

const EFFECT = {
  reads: { label: 'só lê', tone: 'default' },
  asks: { label: 'muda algo, pede seu OK', tone: 'warning' },
  sandbox: { label: 'age só dentro do sandbox', tone: 'primary' },
} as const

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm text-foreground/90">{children}</dd>
    </div>
  )
}

/** Everything about one agent: what it does, what runs it, what it may call, and what it is told. */
export function AgentDetail({
  agent,
  shared,
  settings,
  query,
  onSettingsSaved,
}: {
  agent: AgentEntry
  shared: AgentPrompt[]
  settings: AgentSettings
  query: string
  onSettingsSaved: () => void
}) {
  const role = roleOf(agent.id)
  const [chosen, setChosen] = useState(0)
  const index = Math.min(chosen, agent.prompts.length - 1)
  const prompt = agent.prompts[index]
  const context = shared.filter((s) => agent.shared.includes(s.id))

  return (
    <article aria-label={agent.name} className="space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">{agent.name}</h2>
          <Badge variant={agent.runsIn === 'sandbox' ? 'primary' : 'accent'}>
            {agent.runsIn === 'sandbox' ? 'Roda no sandbox' : 'Roda no servidor'}
          </Badge>
        </div>
        <p className="mt-2 text-sm text-foreground/90">{agent.role}</p>
      </header>

      <dl className="grid gap-5 rounded-xl border border-border bg-card p-4 md:grid-cols-2">
        <Fact label="Quando entra em ação">{agent.when}</Fact>
        <Fact label="Modelo ou agente">
          <span className="font-mono text-[13px]">{agent.engine.value}</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            Como mudar: {agent.engine.change}
          </span>
        </Fact>
      </dl>

      {role ? (
        <EngineChooser
          key={`${role}:${settings.chosen[role]}:${settings.effective[role]}`}
          role={role}
          settings={settings}
          onSaved={onSettingsSaved}
        />
      ) : null}

      <section aria-label="O que pode fazer">
        <h3 className="mb-2 text-sm font-semibold">O que pode fazer</h3>
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {agent.tools.map((tool) => (
            <li key={tool.name} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5">
              <code className="shrink-0 font-mono text-[13px] text-foreground">{tool.name}</code>
              <Badge variant={EFFECT[tool.effect].tone} className="shrink-0">
                {EFFECT[tool.effect].label}
              </Badge>
              <span className="min-w-0 basis-full text-xs text-muted-foreground">
                {tool.description}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Instruções">
        <h3 className="mb-2 text-sm font-semibold">
          Instruções {agent.prompts.length > 1 ? `(${agent.prompts.length})` : ''}
        </h3>
        {agent.prompts.length > 1 ? (
          <div
            role="tablist"
            aria-label="Instruções do agente"
            className="mb-3 flex flex-wrap gap-1.5"
          >
            {agent.prompts.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={i === index}
                onClick={() => setChosen(i)}
                className={`rounded-full px-3 py-1 text-[13px] transition-colors ${i === index ? 'bg-white/[0.14] font-medium text-foreground' : 'border border-border text-foreground/75 hover:bg-white/[0.06]'}`}
              >
                {p.title}
              </button>
            ))}
          </div>
        ) : null}
        <PromptBlock key={`${agent.id}:${prompt.id}`} prompt={prompt} query={query} />
      </section>

      {context.map((c) => (
        <details key={c.id} className="rounded-xl border border-border bg-card">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            Também recebe: {c.title}
            <span className="ml-2 text-xs font-normal text-muted-foreground">{c.when}</span>
          </summary>
          <div className="border-t border-border p-3">
            <PromptBlock prompt={c} query={query} />
          </div>
        </details>
      ))}

      <section aria-label="Onde está no código">
        <h3 className="mb-2 text-sm font-semibold">Onde está no código</h3>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {agent.source.map((file) => (
            <li key={file}>
              <code className="font-mono">{file}</code>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          As instruções só se leem aqui: para mudar uma, o texto está nesses arquivos.
        </p>
      </section>
    </article>
  )
}
