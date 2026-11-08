/**
 * What an agent does while it works, one event per step, in the factory's own shape. Each harness prints
 * its own JSON lines (`claude -p --output-format stream-json`, `codex exec --json`); the functions here
 * turn one line into the events worth showing, and leave out the rest (hooks, init, rate limits).
 *
 * The sandbox holds no secret (the firewall attaches the credentials), but a command's output can still
 * print one, so every event is redacted before it is stored or shown, and cut to 8 KB.
 */

export type AgentEventKind = 'message' | 'tool_use' | 'tool_result' | 'cost' | 'error'

export type AgentEvent = { kind: AgentEventKind; content: string; tool?: string }

export const EVENT_MAX_BYTES = 8 * 1024
const CUT = '[cut]'
const SUMMARY_MAX = 500

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseLine = (line: string): Json | undefined => {
  try {
    const value: unknown = JSON.parse(line)
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The input of a tool call, one line: `key: value` pairs, each value as text. */
export function summarizeInput(input: unknown): string {
  if (!isObject(input)) return text(input).slice(0, SUMMARY_MAX)
  return Object.entries(input)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ')
    .slice(0, SUMMARY_MAX)
}

const resultText = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .filter((part): part is Json => isObject(part) && part.type === 'text')
        .map((part) => text(part.text))
        .join('\n')
    : text(content)

function claudePart(part: unknown): AgentEvent | undefined {
  if (!isObject(part)) return undefined
  if (part.type === 'text' && text(part.text).trim()) {
    return { kind: 'message', content: text(part.text) }
  }
  if (part.type === 'tool_use') {
    return { kind: 'tool_use', tool: text(part.name), content: summarizeInput(part.input) }
  }
  if (part.type === 'tool_result') {
    return {
      kind: part.is_error === true ? 'error' : 'tool_result',
      content: resultText(part.content),
    }
  }
  return undefined
}

/** The events in one line of `claude -p --output-format stream-json --verbose`. */
export function claudeEvents(line: string): AgentEvent[] {
  const event = parseLine(line)
  if (!event) return []
  if (event.type === 'result') {
    if (event.is_error === true) return [{ kind: 'error', content: text(event.result) }]
    const cost = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined
    return cost === undefined ? [] : [{ kind: 'cost', content: `$${cost.toFixed(4)}` }]
  }
  if (event.type !== 'assistant' && event.type !== 'user') return []
  const content = isObject(event.message) ? event.message.content : undefined
  if (!Array.isArray(content)) return []
  return content.map(claudePart).filter((e): e is AgentEvent => e !== undefined)
}

function codexItem(item: Json): AgentEvent[] {
  if (item.type === 'agent_message') {
    return text(item.text) ? [{ kind: 'message', content: text(item.text) }] : []
  }
  if (item.type === 'command_execution') {
    const used: AgentEvent = { kind: 'tool_use', tool: 'shell', content: text(item.command) }
    const output = text(item.aggregated_output)
    const code = typeof item.exit_code === 'number' ? item.exit_code : 0
    if (code !== 0) return [used, { kind: 'error', content: output || `exited ${code}` }]
    return [used, { kind: 'tool_result', content: output }]
  }
  if (item.type === 'file_change' && Array.isArray(item.changes)) {
    const changes = item.changes
      .filter(isObject)
      .map((c) => `${text(c.kind)} ${text(c.path)}`)
      .join(', ')
    return [{ kind: 'tool_use', tool: 'edit', content: changes }]
  }
  return []
}

/** The events in one line of `codex exec --json`. */
export function codexEvents(line: string): AgentEvent[] {
  const event = parseLine(line)
  if (!event) return []
  if (event.type === 'item.completed' && isObject(event.item)) return codexItem(event.item)
  if (event.type === 'turn.completed' && isObject(event.usage)) {
    const { input_tokens: input, output_tokens: output } = event.usage
    return [{ kind: 'cost', content: `${String(input)} tokens in, ${String(output)} out` }]
  }
  if (event.type === 'turn.failed') {
    return [{ kind: 'error', content: isObject(event.error) ? text(event.error.message) : '' }]
  }
  if (event.type === 'error') return [{ kind: 'error', content: text(event.message) }]
  return []
}

// The token formats the factory handles: GitHub (installation, personal, fine-grained), Anthropic,
// OpenAI projects and Vercel. Each needs a body long enough that a word like `ghs_short` is left alone.
const SECRET = new RegExp(
  [
    'gh[sporu]_[A-Za-z0-9]{20,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    'sk-ant-[A-Za-z0-9_-]{16,}',
    'sk-proj-[A-Za-z0-9_-]{16,}',
    'vcp_[A-Za-z0-9]{16,}',
  ].join('|'),
  'g',
)

export const redactSecrets = (value: string): string => value.replace(SECRET, '[redacted]')

/** Cuts text to `max` bytes of UTF-8 without splitting a character, marking the cut. */
function cutToBytes(value: string, max: number): string {
  if (Buffer.byteLength(value) <= max) return value
  const room = max - Buffer.byteLength(CUT)
  let end = Math.min(value.length, room)
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > room) end -= 1
  return `${value.slice(0, end)}${CUT}`
}

/** What is stored and shown of an event: redacted first, so a cut never leaves half a token behind. */
export function toStored(event: AgentEvent): AgentEvent {
  return { ...event, content: cutToBytes(redactSecrets(event.content), EVENT_MAX_BYTES) }
}
