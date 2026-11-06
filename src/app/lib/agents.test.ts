import { describe, expect, it } from 'vitest'

import type { AgentEntry } from '../../shared/panel'

import { filterAgents, markCount, pieces } from './agents'

const agent = (over: Partial<AgentEntry>): AgentEntry => ({
  id: 'a',
  group: 'panel',
  name: 'Assistente',
  role: 'Ajuda',
  runsIn: 'server',
  engine: { value: 'openrouter/x/y', change: 'X' },
  when: '',
  tools: [],
  prompts: [{ id: 'p', title: 'Instruções', when: '', text: 'Be brief.', template: false }],
  shared: [],
  source: [],
  ...over,
})

describe('filterAgents', () => {
  const agents = [
    agent({
      id: 'builder',
      name: 'Construtor',
      prompts: [
        { id: 'p', title: 'Primeira', when: '', text: 'Implement this issue', template: true },
      ],
    }),
    agent({
      id: 'reviewer',
      name: 'Revisor',
      role: 'Lê a mudança',
      tools: [{ name: 'list_tasks', description: '', effect: 'reads' }],
    }),
    agent({
      id: 'chat',
      name: 'Assistente do chat',
      engine: { value: 'gemini-2.5-flash', change: 'X' },
    }),
  ]

  it('keeps all of them when nothing is typed, or only spaces', () => {
    expect(filterAgents(agents, '')).toHaveLength(3)
    expect(filterAgents(agents, '   ')).toHaveLength(3)
  })

  it('looks in the name, the role, the model, the tools and every word of the prompts', () => {
    expect(filterAgents(agents, 'construtor').map((a) => a.id)).toEqual(['builder'])
    expect(filterAgents(agents, 'mudança').map((a) => a.id)).toEqual(['reviewer'])
    expect(filterAgents(agents, 'gemini').map((a) => a.id)).toEqual(['chat'])
    expect(filterAgents(agents, 'list_tasks').map((a) => a.id)).toEqual(['reviewer'])
    expect(filterAgents(agents, 'implement this').map((a) => a.id)).toEqual(['builder'])
    expect(filterAgents(agents, 'primeira').map((a) => a.id)).toEqual(['builder'])
  })

  it('ignores accents and capitals, in what is typed and in what is searched', () => {
    expect(filterAgents(agents, 'LE A MUDANCA').map((a) => a.id)).toEqual(['reviewer'])
    expect(filterAgents(agents, 'lê a mudança').map((a) => a.id)).toEqual(['reviewer'])
    expect(filterAgents(agents, 'ASSISTENTE').length).toBeGreaterThan(0)
  })

  it('finds nothing for what no agent says', () => {
    expect(filterAgents(agents, 'zzzz')).toEqual([])
  })
})

describe('pieces', () => {
  const kinds = (text: string, query = '') => pieces(text, query).map((p) => `${p.kind}:${p.text}`)

  it('marks the places a task fills in, and leaves the rest plain', () => {
    expect(kinds('on ‹branch› now')).toEqual(['plain:on ', 'mark:‹branch›', 'plain: now'])
    expect(kinds('‹a›‹b›')).toEqual(['mark:‹a›', 'mark:‹b›'])
    expect(kinds('plain only')).toEqual(['plain:plain only'])
    expect(kinds('')).toEqual([])
  })

  it('marks what a search matched, without accents or capitals, keeping the original letters', () => {
    expect(kinds('A mudança e outra MUDANCA', 'mudanca')).toEqual([
      'plain:A ',
      'hit:mudança',
      'plain: e outra ',
      'hit:MUDANCA',
    ])
    expect(kinds('abc', 'zz')).toEqual(['plain:abc'])
    expect(kinds('abc', '  ')).toEqual(['plain:abc'])
  })

  it('does not search inside a mark, so a mark and a match never overlap', () => {
    expect(kinds('‹branch› and branch', 'branch')).toEqual([
      'mark:‹branch›',
      'plain: and ',
      'hit:branch',
    ])
  })

  it('reassembles into exactly the text it was given', () => {
    const text = 'You are on ‹repo›, and the repo is Ünïcode. ‹x›'
    for (const query of ['', 'repo', 'ünï', 'zzz']) {
      expect(
        pieces(text, query)
          .map((p) => p.text)
          .join(''),
      ).toBe(text)
    }
  })
})

describe('markCount', () => {
  it('counts the places a task fills in', () => {
    expect(markCount('‹a› and ‹b› and ‹a›')).toBe(3)
    expect(markCount('none')).toBe(0)
  })
})
