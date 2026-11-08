import { AgentBuilder, Provider, type ContextualTool } from '@theokit/agents'
import { z } from 'zod'

import { onlyTools } from '../agents/hooks/only-tools'
import { KNOWLEDGE_TOOLS } from '../agents/tools/knowledge'
import { ASSISTANT_KNOWLEDGE_NOTE } from '../knowledge/prompt'

/** What makes one assistant different from another: how it talks, what it can use, what it must ask about. */
export type AssistantSpec = {
  system: string
  /** The tools it may call, by name. It may call nothing else, not even what the SDK gives every agent. */
  tools: Record<string, ContextualTool>
  /** The tools that change something, each with the question the owner is asked before it runs. */
  asks: Record<string, string>
  /** The longest message it takes. */
  maxInput?: number
}

/**
 * The tools an assistant ends up with: its own, and the knowledge base's, which every assistant has so each
 * one answers from the same rules and notes as the agents in the sandboxes.
 */
export const assistantTools = (spec: AssistantSpec): AssistantSpec['tools'] => ({
  ...spec.tools,
  ...KNOWLEDGE_TOOLS,
})

/**
 * An assistant of the panel on a model, and the only way one is built. It runs inside the server's process,
 * where the factory's credentials are, so it carries `onlyTools` with exactly the tools of its spec and the
 * knowledge base's two (read-only); and every tool that changes something
 * is behind an approval the owner gives on the page. The `ChatGPT` provider is not part of the framework's
 * own model resolution, so the plugins are handed over explicitly.
 */
export function buildAssistant(model: string, spec: AssistantSpec) {
  const tools = assistantTools(spec)
  const names = Object.keys(tools)
  for (const name of Object.keys(spec.asks)) {
    if (!names.includes(name))
      throw new Error(`"${name}" asks for approval but is not one of the tools`)
  }
  return AgentBuilder.create()
    .input(z.object({ message: z.string().max(spec.maxInput ?? 40_000) }))
    .model(model)
    .plugins(Provider.builtins())
    .system(`${spec.system}\n\n${ASSISTANT_KNOWLEDGE_NOTE}`)
    .tools(Object.values(tools))
    .approvals(
      Object.fromEntries(Object.entries(spec.asks).map(([tool, question]) => [tool, { question }])),
    )
    .hooks(onlyTools(names))
    .build()
}
