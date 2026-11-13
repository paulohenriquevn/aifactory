import { Badge } from '@usetheo/ui'

import type { AgentEntry } from '../../../shared/panel'
import { GROUPS } from '../../lib/agents'

/** The agents in two groups, the chosen one marked. A group with none left by the search is not shown. */
export function AgentList({
  agents,
  selected,
  onSelect,
}: {
  agents: AgentEntry[]
  selected: string | undefined
  onSelect: (id: string) => void
}) {
  return (
    <nav aria-label="Agentes" className="space-y-5">
      {GROUPS.map((group) => {
        const inGroup = agents.filter((a) => a.group === group.id)
        if (inGroup.length === 0) return null
        return (
          <section key={group.id} aria-label={group.title}>
            <h2 className="px-3 text-sm font-semibold text-foreground">{group.title}</h2>
            <p className="mb-1 px-3 text-xs text-muted-foreground">{group.about}</p>
            <ul className="space-y-0.5">
              {inGroup.map((agent) => {
                const active = agent.id === selected
                return (
                  <li key={agent.id}>
                    <button
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      onClick={() => onSelect(agent.id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${active ? 'bg-muted font-medium text-foreground' : 'text-foreground/85 hover:bg-muted/60'}`}
                    >
                      <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                      {agent.prompts.length > 1 ? (
                        <Badge variant="default" className="shrink-0">
                          {agent.prompts.length}
                        </Badge>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </nav>
  )
}
