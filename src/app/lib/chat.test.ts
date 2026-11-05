import { describe, expect, it } from 'vitest'

import type { ChatMessageView, ChatSummary } from '../../shared/panel'

import { describeApproval, displayed, groupChats, NEW_MESSAGE, promptWith, textOf } from './chat'

const say = (role: ChatMessageView['role'], text: string): ChatMessageView => ({
  id: text,
  role,
  parts: [{ type: 'text', text }],
})

const summary = (id: string, title: string, pinned = false): ChatSummary => ({
  id,
  title,
  pinned,
  model: 'openrouter',
  updatedAt: '2026-11-05T10:00:00Z',
})

describe('textOf', () => {
  it('joins the text parts and ignores the rest', () => {
    expect(
      textOf({
        parts: [{ type: 'text', text: 'a' }, { type: 'tool-x' }, { type: 'text', text: 'b' }],
      }),
    ).toBe('ab')
    expect(textOf({ parts: [{ type: 'text', text: 5 }] })).toBe('')
  })
})

describe('promptWith', () => {
  it('is just the text when nothing was said before', () => {
    expect(promptWith([], 'oi')).toBe('oi')
    expect(promptWith([say('system', 'x'), say('user', '   ')], 'oi')).toBe('oi')
  })

  it('puts the conversation first, oldest first, then marks the new message', () => {
    const prompt = promptWith([say('user', 'um'), say('assistant', 'dois')], 'três')
    expect(prompt).toBe(
      `Conversa até aqui, a mais antiga primeiro:\n[dono]: um\n[assistente]: dois\n\n${NEW_MESSAGE}três`,
    )
  })

  it('keeps only the last twenty messages, and the first part of a long one', () => {
    const history = Array.from({ length: 25 }, (_, i) => say('user', `m${i}`))
    const prompt = promptWith(history, 'fim')
    expect(prompt).not.toContain('[dono]: m4\n')
    expect(prompt).toContain('[dono]: m5\n')
    const long = promptWith([say('user', 'x'.repeat(3000))], 'fim')
    expect(long).toContain(`[dono]: ${'x'.repeat(1500)}\n`)
    expect(long).not.toContain('x'.repeat(1501))
  })
})

describe('displayed', () => {
  it('shows a user message without the history that rode along with it', () => {
    const sent = say('user', promptWith([say('user', 'um')], 'três'))
    expect(textOf(displayed(sent))).toBe('três')
  })

  it('leaves alone an answer, a message with no marker, and a part that is not text', () => {
    const answer = say('assistant', `${NEW_MESSAGE}x`)
    expect(displayed(answer)).toBe(answer)
    expect(textOf(displayed(say('user', 'simples')))).toBe('simples')
    const tool = { id: 't', role: 'user', parts: [{ type: 'file' }, { type: 'text', text: 5 }] }
    expect(displayed(tool).parts).toEqual(tool.parts)
  })
})

describe('groupChats', () => {
  const chats = [summary('1', 'Backlog', true), summary('2', 'Tarefa 49'), summary('3', '')]

  it('splits the pinned from the rest, keeping the order', () => {
    const { pinned, recent } = groupChats(chats)
    expect(pinned.map((c) => c.id)).toEqual(['1'])
    expect(recent.map((c) => c.id)).toEqual(['2', '3'])
  })

  it('filters by title, with no case, and counts an untitled chat as "novo chat"', () => {
    expect(groupChats(chats, ' TAREFA ').recent.map((c) => c.id)).toEqual(['2'])
    expect(groupChats(chats, 'novo').recent.map((c) => c.id)).toEqual(['3'])
    expect(groupChats(chats, 'zzz')).toEqual({ pinned: [], recent: [] })
  })
})

describe('describeApproval', () => {
  it('says in words what each acting tool is about to do', () => {
    expect(describeApproval('retry_task', { id: 49 })).toMatchObject({
      title: 'Repetir uma tarefa',
      request: expect.stringContaining('tarefa 49'),
    })
    expect(describeApproval('request_changes', { id: 7, note: 'troque X' }).request).toContain(
      'troque X',
    )
    expect(describeApproval('request_changes', { id: 7 }).request).toContain('tarefa 7')
    const job = describeApproval('start_job', {
      repository: 'o/r',
      title: 'T',
      body: 'b'.repeat(900),
    })
    expect(job.request).toContain('o/r: T')
    expect(job.request.length).toBeLessThan(700)
  })

  it('shows the raw input for a tool it does not know, and copes with no input', () => {
    expect(describeApproval('other', { a: 1 })).toEqual({
      title: 'other',
      request: '{\n  "a": 1\n}',
    })
    expect(describeApproval(undefined, undefined).title).toBe('Ação')
    expect(describeApproval('retry_task', null).request).toContain('undefined')
  })
})
