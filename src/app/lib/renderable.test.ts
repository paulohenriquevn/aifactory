import { describe, expect, it } from 'vitest'

import { toRenderable } from './renderable'

const message = (parts: Record<string, unknown>[], extra: object = {}) =>
  ({ id: 'm', role: 'assistant', parts, ...extra }) as never

describe('toRenderable', () => {
  it('keeps text and reasoning, and drops one whose text is not a string', () => {
    const out = toRenderable(
      message([
        { type: 'text', text: 'oi' },
        { type: 'reasoning', text: 'pensando' },
        { type: 'text', text: 4 },
      ]),
    )
    expect(out.parts).toEqual([
      { type: 'text', text: 'oi' },
      { type: 'reasoning', text: 'pensando' },
    ])
  })

  it('keeps a tool call it can draw, and skips a half-built one or one in a state it does not know', () => {
    const drawn = {
      type: 'tool-list_tasks',
      toolCallId: 'c1',
      state: 'output-available',
      output: [1],
    }
    const out = toRenderable(
      message([
        drawn,
        { type: 'tool-x', state: 'output-available' },
        { type: 'tool-x', toolCallId: 'c2', state: 'mystery' },
        { type: 'dynamic-tool', toolCallId: 'c3', state: 'input-available', toolName: 'y' },
      ]),
    )
    expect(out.parts).toHaveLength(2)
    expect(out.parts[0]).toMatchObject(drawn)
    expect(out.parts[1]).toMatchObject({ type: 'dynamic-tool', toolCallId: 'c3' })
  })

  it('keeps data parts, drops a kind it cannot render, and carries the metadata when there is any', () => {
    const out = toRenderable(
      message([{ type: 'data-note', data: { a: 1 } }, { type: 'file' }], { metadata: { k: 1 } }),
    )
    expect(out.parts).toEqual([{ type: 'data-note', data: { a: 1 } }])
    expect(out).toMatchObject({ id: 'm', role: 'assistant', metadata: { k: 1 } })
    expect('metadata' in toRenderable(message([]))).toBe(false)
  })
})
