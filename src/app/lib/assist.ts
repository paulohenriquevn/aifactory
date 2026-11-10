import type { UIMessage } from 'theokit/client'

export type AssistKind = 'goal' | 'job' | 'issue' | 'changes' | 'resolution' | 'setup'

/** What the assistant hands back through its `propose` tool, which is what the owner can accept. */
export type Proposal = {
  title?: string
  text: string
  domains?: string[]
  notes: string
}

/** The agent each kind talks to: only the one that sets a repository up may read it. */
export const agentFor = (kind: AssistKind) =>
  kind === 'setup' ? '/api/agents/assist-setup' : '/api/agents/assist'

/**
 * The message the assistant gets: a header that says what the text is for and where, then what the owner
 * wrote. An instruction to change a suggestion rides on the same header, so the assistant stays on the
 * same kind of text.
 */
export function buildMessage(input: {
  kind: AssistKind
  repository?: string
  context?: string
  text: string
  instruction?: string
}): string {
  const header = [
    `kind: ${input.kind}`,
    ...(input.repository ? [`repository: ${input.repository}`] : []),
    ...(input.context ? [`context: ${input.context}`] : []),
  ].join('\n')
  const wrote = input.instruction
    ? `${input.text}\n\nThe owner then asked for a change to your suggestion: ${input.instruction}`
    : input.text
  return `${header}\n\nThe owner wrote:\n${wrote}`
}

/** The newest suggestion in the conversation, once its text is complete. */
export function proposalOf(thread: UIMessage[]): Proposal | undefined {
  for (const message of [...thread].reverse()) {
    if (message.role !== 'assistant') continue
    for (const part of [...message.parts].reverse()) {
      // The framework hands a tool call over as a `dynamic-tool` part named by `toolName`; a typed
      // `tool-propose` part is accepted too, so a change of that does not leave the owner with nothing.
      const isPropose =
        part.type === 'tool-propose' ||
        (part.type === 'dynamic-tool' && part.toolName === 'propose')
      if (!isPropose || part.state === 'input-streaming') continue
      const input = part.input as Partial<Proposal> | undefined
      if (typeof input?.text !== 'string' || input.text.trim() === '') continue
      return {
        text: input.text,
        notes: typeof input.notes === 'string' ? input.notes : '',
        ...(typeof input.title === 'string' && input.title.trim() !== ''
          ? { title: input.title }
          : {}),
        ...(Array.isArray(input.domains)
          ? { domains: input.domains.filter((d): d is string => typeof d === 'string') }
          : {}),
      }
    }
  }
  return undefined
}

/** Why the assistant could not answer, in words an owner can act on. */
export function assistProblem(error: Error | undefined): string | undefined {
  if (!error) return undefined
  const message = error.message
  if (/\b(401|403)\b|forbidden|policy/i.test(message))
    return 'Sign in to the panel again, then retry.'
  if (/api[-_ ]?key|authentication|unauthor|credit|billing/i.test(message)) {
    return 'The assistant has no model credit: set ANTHROPIC_API_KEY on the server (see Setup).'
  }
  return `The assistant could not answer: ${message}`
}
