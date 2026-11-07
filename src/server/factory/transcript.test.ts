import { describe, expect, it } from 'vitest'

import {
  claudeEvents,
  codexEvents,
  EVENT_MAX_BYTES,
  redactSecrets,
  summarizeInput,
  toStored,
  type AgentEvent,
} from './transcript'

const line = (value: unknown) => JSON.stringify(value)

describe('the transcript of Claude Code (stream-json)', () => {
  it('reads what the agent says and each tool it calls, with the input summed up', () => {
    const events = claudeEvents(
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I will run the tests.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test', timeout: 600 } },
          ],
        },
      }),
    )
    expect(events).toEqual<AgentEvent[]>([
      { kind: 'message', content: 'I will run the tests.' },
      { kind: 'tool_use', tool: 'Bash', content: 'command: npm test, timeout: 600' },
    ])
  })

  it('reads a tool result written as text or as a list of parts, and says when it was an error', () => {
    const asText = claudeEvents(
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok 1' }] } }),
    )
    const asParts = claudeEvents(
      line({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              is_error: true,
              content: [
                { type: 'text', text: 'not ok 1' },
                { type: 'image', source: {} },
              ],
            },
          ],
        },
      }),
    )
    expect(asText).toEqual([{ kind: 'tool_result', content: 'ok 1' }])
    expect(asParts).toEqual([{ kind: 'error', content: 'not ok 1' }])
  })

  it('reads the cost at the end, and the error when the run failed', () => {
    expect(claudeEvents(line({ type: 'result', is_error: false, total_cost_usd: 0.1234 }))).toEqual(
      [{ kind: 'cost', content: '$0.1234' }],
    )
    expect(
      claudeEvents(line({ type: 'result', is_error: true, result: 'usage limit reached' })),
    ).toEqual([{ kind: 'error', content: 'usage limit reached' }])
  })

  it('leaves out what is not about the work: hooks, init, rate limits, and lines that are not JSON', () => {
    for (const text of [
      line({ type: 'system', subtype: 'hook_started' }),
      line({ type: 'system', subtype: 'init' }),
      line({ type: 'rate_limit_event' }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: '  ' }] } }),
      line({ type: 'assistant' }),
      line({ type: 'user', message: { content: 'plain' } }),
      'not json',
      line([1, 2]),
      line(null),
    ]) {
      expect(claudeEvents(text), text).toEqual([])
    }
  })
})

describe('the transcript of Codex (exec --json)', () => {
  it('reads messages, commands with their output, and file changes once they complete', () => {
    expect(
      codexEvents(line({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } })),
    ).toEqual([{ kind: 'message', content: 'Done.' }])
    expect(
      codexEvents(
        line({
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command: 'bash -lc "npm test"',
            aggregated_output: 'ok 1',
            exit_code: 0,
          },
        }),
      ),
    ).toEqual([
      { kind: 'tool_use', tool: 'shell', content: 'bash -lc "npm test"' },
      { kind: 'tool_result', content: 'ok 1' },
    ])
    expect(
      codexEvents(
        line({
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command: 'false',
            aggregated_output: '',
            exit_code: 1,
          },
        }),
      ),
    ).toEqual([
      { kind: 'tool_use', tool: 'shell', content: 'false' },
      { kind: 'error', content: 'exited 1' },
    ])
    expect(
      codexEvents(
        line({
          type: 'item.completed',
          item: {
            type: 'file_change',
            changes: [
              { path: 'src/a.ts', kind: 'update' },
              { path: 'src/b.ts', kind: 'add' },
            ],
          },
        }),
      ),
    ).toEqual([{ kind: 'tool_use', tool: 'edit', content: 'update src/a.ts, add src/b.ts' }])
  })

  it('reads the tokens of a turn and the error of a failed one', () => {
    expect(
      codexEvents(
        line({ type: 'turn.completed', usage: { input_tokens: 1200, output_tokens: 300 } }),
      ),
    ).toEqual([{ kind: 'cost', content: '1200 tokens in, 300 out' }])
    expect(codexEvents(line({ type: 'turn.failed', error: { message: 'quota' } }))).toEqual([
      { kind: 'error', content: 'quota' },
    ])
    expect(codexEvents(line({ type: 'error', message: 'stream lost' }))).toEqual([
      { kind: 'error', content: 'stream lost' },
    ])
  })

  it('leaves out an item that started, reasoning, and what is not JSON', () => {
    for (const text of [
      line({ type: 'item.started', item: { type: 'command_execution', command: 'x' } }),
      line({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } }),
      line({ type: 'item.completed', item: { type: 'agent_message', text: '' } }),
      line({ type: 'thread.started', thread_id: 't' }),
      line({ type: 'turn.completed' }),
      'nope',
    ]) {
      expect(codexEvents(text), text).toEqual([])
    }
  })
})

describe('what is stored of an event', () => {
  it('has no token of a known format, whatever printed it', () => {
    const text = [
      'ghs_abcdefghijklmnopqrstuvwxyz0123',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'sk-ant-oat01-abcdefghijklmnop_qrstuv',
      'sk-proj-ABCDEFGHIJKLMNOP-qrstuvwx',
      'vcp_abcdefghijklmnopqrst',
    ].join(' and ')
    const redacted = redactSecrets(text)
    expect(redacted).toBe(
      '[redacted] and [redacted] and [redacted] and [redacted] and [redacted] and [redacted]',
    )
    expect(redactSecrets('ghs_short and sk-ant- alone')).toBe('ghs_short and sk-ant- alone')
  })

  it('is cut to 8 KB, counted in bytes, and redacted before it is cut', () => {
    const long = `${'é'.repeat(EVENT_MAX_BYTES)}`
    const stored = toStored({ kind: 'message', content: long })
    expect(Buffer.byteLength(stored.content)).toBeLessThanOrEqual(EVENT_MAX_BYTES)
    expect(stored.content.endsWith('[cut]')).toBe(true)
    const token = 'ghs_abcdefghijklmnopqrstuvwxyz0123'
    const edge = `${'a'.repeat(EVENT_MAX_BYTES - 10)}${token}`
    expect(toStored({ kind: 'tool_result', content: edge }).content).not.toContain('ghs_abc')
  })

  it('keeps the tool and an event that fits as it is', () => {
    expect(toStored({ kind: 'tool_use', tool: 'Bash', content: 'ls' })).toEqual({
      kind: 'tool_use',
      tool: 'Bash',
      content: 'ls',
    })
  })
})

describe('the edges of what an agent prints', () => {
  it('sums up an input that is not an object, cuts a long one, and writes a structured value as JSON', () => {
    expect(summarizeInput('ls -la')).toBe('ls -la')
    expect(summarizeInput(7)).toBe('')
    expect(summarizeInput('x'.repeat(900))).toHaveLength(500)
    expect(summarizeInput({ a: 'y'.repeat(900) })).toHaveLength(500)
    expect(summarizeInput({ paths: ['a', 'b'], n: 2 })).toBe('paths: ["a","b"], n: 2')
  })

  it('leaves out what Claude prints that is not a step of the work', () => {
    for (const value of [
      { type: 'result', is_error: false },
      { type: 'result', is_error: false, total_cost_usd: '0.1' },
      { type: 'stream_event', message: { content: [{ type: 'text', text: 'partial' }] } },
      { type: 'assistant', message: { content: [null, 'x', { type: 'thinking', text: 'hmm' }] } },
    ]) {
      expect(claudeEvents(line(value)), JSON.stringify(value)).toEqual([])
    }
  })

  it('names a tool with no name by nothing, and reads a result with no text as empty', () => {
    expect(
      claudeEvents(
        line({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', input: {} },
              { type: 'tool_result', content: 3 },
            ],
          },
        }),
      ),
    ).toEqual([
      { kind: 'tool_use', tool: '', content: '' },
      { kind: 'tool_result', content: '' },
    ])
  })

  it('takes a Codex command with no exit code as one that worked', () => {
    expect(
      codexEvents(
        line({
          type: 'item.completed',
          item: { type: 'command_execution', command: 'ls', aggregated_output: 'a' },
        }),
      ),
    ).toEqual([
      { kind: 'tool_use', tool: 'shell', content: 'ls' },
      { kind: 'tool_result', content: 'a' },
    ])
  })

  it('leaves out what Codex prints that is not a step, and a change that is not a change', () => {
    for (const value of [
      {
        type: 'item.completed',
        item: { type: 'todo_list', changes: [{ path: 'a', kind: 'add' }] },
      },
      { type: 'item.updated', usage: { input_tokens: 1, output_tokens: 1 } },
      { type: 'turn.completed', usage: 'none' },
    ]) {
      expect(codexEvents(line(value)), JSON.stringify(value)).toEqual([])
    }
    expect(
      codexEvents(
        line({
          type: 'item.completed',
          item: { type: 'file_change', changes: [null, { path: 'a', kind: 'add' }] },
        }),
      ),
    ).toEqual([{ kind: 'tool_use', tool: 'edit', content: 'add a' }])
    expect(codexEvents(line({ type: 'turn.failed' }))).toEqual([{ kind: 'error', content: '' }])
  })

  it('keeps an event of exactly 8 KB whole, and cuts one byte more to 8 KB with the mark', () => {
    const exact = 'a'.repeat(EVENT_MAX_BYTES)
    expect(toStored({ kind: 'message', content: exact }).content).toBe(exact)
    const over = toStored({ kind: 'message', content: `${exact}b` }).content
    expect(Buffer.byteLength(over)).toBe(EVENT_MAX_BYTES)
    expect(over).toBe(`${'a'.repeat(EVENT_MAX_BYTES - 5)}[cut]`)
  })

  it('cuts text of two-byte characters at a whole character, keeping as many as fit', () => {
    const cut = toStored({ kind: 'message', content: 'é'.repeat(EVENT_MAX_BYTES) }).content
    expect(cut).toBe(`${'é'.repeat(Math.floor((EVENT_MAX_BYTES - 5) / 2))}[cut]`)
  })
})
