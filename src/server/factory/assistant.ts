import { AgentBuilder, Provider, type ContextualTool } from '@theokit/agents'
import { z } from 'zod'

import { onlyTools } from '../agents/hooks/only-tools'

/** What makes one assistant different from another: how it talks, what it can use, what it must ask about. */
export type AssistantSpec = {
  system: string
  /** The tools it may call, by name. It may call nothing else, not even what the SDK gives every agent. */
  tools: Record<string, ContextualTool>
  /** The tools that change something, each with the question the owner is asked before it runs. */
  asks: Record<string, string>
}

/**
 * An assistant of the panel on a model. It runs inside the server's process, where the factory's credentials
 * are, so it carries `onlyTools` with exactly the tools of its spec; and every tool that changes something
 * is behind an approval the owner gives on the page. The `ChatGPT` provider is not part of the framework's
 * own model resolution, so the plugins are handed over explicitly.
 */
export function buildAssistant(model: string, spec: AssistantSpec) {
  const names = Object.keys(spec.tools)
  for (const name of Object.keys(spec.asks)) {
    if (!names.includes(name))
      throw new Error(`"${name}" asks for approval but is not one of the tools`)
  }
  return AgentBuilder.create()
    .input(z.object({ message: z.string().max(40_000) }))
    .model(model)
    .plugins(Provider.builtins())
    .system(spec.system)
    .tools(Object.values(spec.tools))
    .approvals(
      Object.fromEntries(Object.entries(spec.asks).map(([tool, question]) => [tool, { question }])),
    )
    .hooks(onlyTools(names))
    .build()
}
