import { describe, expect, it } from 'vitest'

import type { ChatMessageView, ChatSummary } from '../../shared/panel'

import { describeApproval, displayed, groupChats, NEW_MESSAGE, promptWith, textOf } from './chat'
import type { RepositoryView } from '../../shared/panel'

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

describe('promptWith a preface', () => {
  it('always sets the preface apart from the new message, even with no history, and the owner never sees it', () => {
    const prompt = promptWith([], 'oi', 'Onde o dono está: Quadro')
    expect(prompt).toBe(`Onde o dono está: Quadro\n\n${NEW_MESSAGE}oi`)
    expect(textOf(displayed({ role: 'user', parts: [{ type: 'text', text: prompt }] }))).toBe('oi')
  })

  it('puts it before the conversation so far', () => {
    const prompt = promptWith([say('user', 'um')], 'dois', 'ONDE')
    expect(prompt.indexOf('ONDE')).toBeLessThan(prompt.indexOf('[dono]: um'))
    expect(prompt.endsWith(`${NEW_MESSAGE}dois`)).toBe(true)
  })
})

describe('describeApproval for the choice of agent', () => {
  it('says which role gets which agent, and that it applies to the next runs', () => {
    const out = describeApproval('update_agent_settings', {
      builder: 'claude-code',
      reviewer: 'codex',
    })
    expect(out.title).toBe('Trocar o agente de código')
    expect(out.request).toContain('- Construtor: claude-code')
    expect(out.request).toContain('- Revisor: codex')
    expect(out.request).not.toContain('Planejador')
    expect(out.request).toContain('próximas execuções, sem reiniciar')
  })

  it("says that a null goes back to the builder's agent, and that an empty change changes nothing", () => {
    expect(describeApproval('update_agent_settings', { planner: null }).request).toContain(
      '- Planejador: volta ao padrão (o mesmo agente do Construtor)',
    )
    expect(describeApproval('update_agent_settings', {}).request).toContain('- nada muda')
    expect(describeApproval('update_agent_settings', { builder: undefined }).request).toContain(
      '- nada muda',
    )
  })
})

describe('describeApproval for the guides', () => {
  it('says in words what each change would do', () => {
    expect(describeApproval('approve_task', { id: 4 }).request).toContain(
      'não faz merge nem release',
    )
    expect(describeApproval('create_plan', { repository: 'o/r', goal: 'g' }).request).toContain(
      'Nenhuma issue é criada ainda',
    )
    expect(describeApproval('create_plan_issues', { planId: 2, start: true }).request).toContain(
      'já começar',
    )
    expect(describeApproval('create_plan_issues', { planId: 2, start: false }).request).toContain(
      'esperando',
    )
    expect(
      describeApproval('resolve_finding', { id: 1, action: 'delete_snapshot' }).request,
    ).toContain('snapshot')
    expect(describeApproval('resolve_finding', { id: 1, action: 'new_thing' }).request).toContain(
      'new_thing',
    )
    expect(describeApproval('acknowledge_watch', { id: 3 }).title).toBe('Marcar como visto')
  })

  it('shows what a save changes, before and after when the repository is known, and says when nothing does', () => {
    const repo = { releaseBranch: 'main' } as RepositoryView
    const change = describeApproval(
      'update_repository',
      { repository: 'o/r', releaseBranch: 'release' },
      repo,
    )
    expect(change.request).toBe('Em o/r:\n- Branch de release: main → release')
    expect(
      describeApproval('update_repository', { repository: 'o/r', releaseBranch: 'main' }, repo)
        .request,
    ).toContain('nada muda')
    expect(
      describeApproval('update_repository', { repository: 'o/r', releaseBranch: 'x' }).request,
    ).toContain('Branch de release: x')
  })
})
