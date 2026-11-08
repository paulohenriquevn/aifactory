import { describe, expect, it } from 'vitest'

import type { ChatMessageView } from '../../shared/panel'

import { titleFrom } from './chats'

const user = (text: string): ChatMessageView => ({
  id: 'u',
  role: 'user',
  parts: [{ type: 'text', text }],
})
const assistant = (text: string): ChatMessageView => ({
  id: 'a',
  role: 'assistant',
  parts: [{ type: 'text', text }],
})

describe('titleFrom', () => {
  it('is the start of what the owner first wrote, on one line', () => {
    expect(titleFrom([user('Quais tarefas\n   estão travadas?')])).toBe(
      'Quais tarefas estão travadas?',
    )
  })

  it('skips an answer that came first, and a message with no text', () => {
    expect(titleFrom([assistant('Olá'), user('   '), user('Reabra o B-399')])).toBe(
      'Reabra o B-399',
    )
    expect(titleFrom([{ id: 'u', role: 'user', parts: [{ type: 'file' }] }, user('Depois')])).toBe(
      'Depois',
    )
  })

  it('cuts a long first message to a title the menu can show, ending in an ellipsis', () => {
    const title = titleFrom([user(`${'palavra '.repeat(30)}`)])
    expect(title.length).toBe(60)
    expect(title.endsWith('…')).toBe(true)
    expect(titleFrom([user('x'.repeat(60))])).toBe('x'.repeat(60))
    expect(titleFrom([user('x'.repeat(61))]).length).toBe(60)
  })

  it('has no title before the owner has written anything', () => {
    expect(titleFrom([])).toBe('')
    expect(titleFrom([assistant('Pronto quando você quiser.')])).toBe('')
  })

  it('reads every text part of a message, and ignores tool calls', () => {
    expect(
      titleFrom([
        {
          id: 'u',
          role: 'user',
          parts: [{ type: 'text', text: 'um' }, { type: 'tool-x' }, { type: 'text', text: 'dois' }],
        },
      ]),
    ).toBe('um dois')
  })
})
