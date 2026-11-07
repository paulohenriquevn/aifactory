import type { TranscriptEvent } from '../../shared/panel'

/** Puts steps that arrived from the page and from the stream in order, each once. */
export function mergeSteps(
  known: TranscriptEvent[],
  arrived: TranscriptEvent[],
): TranscriptEvent[] {
  if (arrived.length === 0) return known
  const bySeq = new Map(known.map((e) => [e.seq, e]))
  for (const event of arrived) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

export type TranscriptRow =
  | { type: 'say'; seq: number; role: TranscriptEvent['role']; text: string; at: string }
  | {
      type: 'tool'
      seq: number
      role: TranscriptEvent['role']
      tool: string
      target: string
      status: 'running' | 'success' | 'failed'
      output: string
      at: string
    }
  | { type: 'note'; seq: number; role: TranscriptEvent['role']; text: string; failed: boolean }

/**
 * What the panel shows of a transcript: a message is a line of text, a tool call is a card with what
 * came back folded into it (running until something comes back), and a cost or an error on its own is
 * a note. `live` says whether the agent may still answer a tool call that has no result yet.
 */
export function transcriptRows(events: TranscriptEvent[], live: boolean): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let open: Extract<TranscriptRow, { type: 'tool' }> | undefined
  for (const e of events) {
    const answers = open && (e.kind === 'tool_result' || e.kind === 'error')
    if (answers && open) {
      open.status = e.kind === 'error' ? 'failed' : 'success'
      open.output = e.content
      open = undefined
      continue
    }
    if (open) open.status = 'success'
    open = undefined
    if (e.kind === 'message') {
      rows.push({ type: 'say', seq: e.seq, role: e.role, text: e.content, at: e.at })
    } else if (e.kind === 'tool_use') {
      open = {
        type: 'tool',
        seq: e.seq,
        role: e.role,
        tool: e.tool ?? 'tool',
        target: e.content,
        status: 'running',
        output: '',
        at: e.at,
      }
      rows.push(open)
    } else {
      rows.push({
        type: 'note',
        seq: e.seq,
        role: e.role,
        text: e.content,
        failed: e.kind !== 'cost',
      })
    }
  }
  if (open && !live) open.status = 'success'
  return rows
}
