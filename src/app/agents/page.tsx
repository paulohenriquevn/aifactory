import { Alert, Input } from '@usetheo/ui'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Metadata } from 'theokit/client'

import type { AgentsView } from '../../shared/panel'
import { AgentDetail } from '../components/agents/AgentDetail'
import { AgentList } from '../components/agents/AgentList'
import { filterAgents } from '../lib/agents'
import { useResource } from '../lib/live'

/** Who works in the factory, what each is told, and what each may do. Read from the code that runs them. */
export default function AgentsPage() {
  const { data, error, reload } = useResource<AgentsView>('/api/panel/agents', {
    stream: false,
    everyMs: 60_000,
  })
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')

  const shown = data ? filterAgents(data.agents, query) : []
  const wanted = params.get('agent')
  const selected = shown.find((a) => a.id === wanted) ?? shown[0]

  return (
    <div className="space-y-5">
      <Metadata
        title="Agentes · aifactory"
        description="Os agentes da fábrica e os prompts de cada um."
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Quem trabalha na fábrica, o que cada um recebe de instrução e o que pode fazer. As
            instruções são só para ler; o agente de código de cada papel dá para trocar aqui.
          </p>
        </div>
        <label className="relative block w-full max-w-sm">
          <span className="sr-only">Buscar agente ou texto de uma instrução</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Buscar agente ou texto de uma instrução"
            placeholder="Buscar agente ou texto de uma instrução"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </label>
      </div>

      {error ? (
        <Alert intent="destructive" title="Não consegui carregar os agentes" description={error} />
      ) : null}
      {!data && !error ? <p className="text-sm text-muted-foreground">Carregando…</p> : null}

      {data ? (
        shown.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            Nenhum agente tem “{query}” no nome nem nas instruções.
          </p>
        ) : (
          <div className="grid gap-8 lg:grid-cols-[260px_minmax(0,1fr)]">
            <div className="lg:sticky lg:top-2 lg:self-start">
              <AgentList
                agents={shown}
                selected={selected?.id}
                onSelect={(id) => setParams({ agent: id }, { replace: true })}
              />
            </div>
            {selected ? (
              <AgentDetail
                key={selected.id}
                agent={selected}
                shared={data.shared}
                settings={data.settings}
                query={query}
                onSettingsSaved={reload}
              />
            ) : null}
          </div>
        )
      ) : null}
    </div>
  )
}
