import { describe, expect, it } from 'vitest'

import { GUIDE_IDS, guidePath } from '../../shared/guides'
import { GUIDE_INSTRUCTIONS } from '../agents/prompts/guides'

import { buildAssistant } from './assistant'
import { guideCodexModel, guideModel, GUIDE_SPECS } from './guides'

const named = (tools: Record<string, unknown>) =>
  Object.entries(tools).map(([key, tool]) => [key, (tool as { name: string }).name])

describe('the guides', () => {
  it('has one for each page of the menu that is not the chat, and serves each at its own address', () => {
    expect(GUIDE_IDS).toEqual([
      'board',
      'plans',
      'repositories',
      'inbox',
      'health',
      'agents',
      'setup',
    ])
    expect(Object.keys(GUIDE_SPECS)).toEqual([...GUIDE_IDS])
    expect(guidePath('board')).toBe('/api/agents/guide-board')
    expect(guidePath('board', 'codex')).toBe('/api/agents/guide-board-codex')
  })

  it('gives each tool the name it is listed under, because the allowlist is made from those names', () => {
    for (const spec of Object.values(GUIDE_SPECS)) {
      for (const [key, name] of named(spec.tools)) expect(name).toBe(key)
    }
  })

  it('asks the owner about every tool that changes something, and about no other', () => {
    for (const spec of Object.values(GUIDE_SPECS)) {
      for (const name of Object.keys(spec.asks)) expect(Object.keys(spec.tools)).toContain(name)
    }
    const asked = new Set(Object.values(GUIDE_SPECS).flatMap((s) => Object.keys(s.asks)))
    expect([...asked].sort()).toEqual(
      [
        'acknowledge_watch',
        'approve_task',
        'create_plan',
        'create_plan_issues',
        'request_changes',
        'resolve_finding',
        'retry_task',
        'start_job',
        'update_agent_settings',
        'update_repository',
      ].sort(),
    )
    for (const spec of Object.values(GUIDE_SPECS)) {
      for (const name of Object.keys(spec.tools)) {
        if (/^(list|inbox|health|setup|plan_detail|factory|task_detail|repo_)/.test(name)) {
          expect(spec.asks[name], name).toBeUndefined()
        }
      }
    }
  })

  it('keeps to the tools of its own page: the setup guide only reads, and none can release', () => {
    expect(Object.keys(GUIDE_SPECS.setup.tools)).toEqual(['setup_report'])
    expect(GUIDE_SPECS.setup.asks).toEqual({})
    for (const spec of Object.values(GUIDE_SPECS)) {
      for (const name of Object.keys(spec.tools))
        expect(name).not.toMatch(/release|merge|shell|bash|exec|write/)
    }
    expect(Object.keys(GUIDE_SPECS.repositories.tools)).toEqual([
      'list_repositories',
      'repo_files',
      'repo_file',
      'update_repository',
    ])
  })

  it('lets the agents guide read the catalog and, with approval, choose which coding agent does each role', () => {
    expect(Object.keys(GUIDE_SPECS.agents.tools)).toEqual([
      'list_agents',
      'agent_prompt',
      'update_agent_settings',
    ])
    expect(Object.keys(GUIDE_SPECS.agents.asks)).toEqual(['update_agent_settings'])
    expect(GUIDE_INSTRUCTIONS('agents')).toContain('agent_prompt')
    expect(GUIDE_INSTRUCTIONS('agents')).toContain('never describe a prompt you have not read')
    expect(GUIDE_INSTRUCTIONS('agents')).toContain('You cannot change a prompt')
    expect(GUIDE_INSTRUCTIONS('agents')).toContain('update_agent_settings')
    expect(GUIDE_INSTRUCTIONS('agents')).toContain('Never choose an agent that cannot start')
    expect(GUIDE_INSTRUCTIONS('agents')).toContain('modelsOfEachAgent')
    expect(GUIDE_INSTRUCTIONS('agents')).toContain('takes a restart of the panel')
  })

  it('lets the board guide answer "what needs me" from the inbox, not from one column', () => {
    expect(Object.keys(GUIDE_SPECS.board.tools)).toContain('inbox_items')
    expect(GUIDE_INSTRUCTIONS('board')).toContain('inbox_items')
  })

  it('tells every guide how to speak, and tells each one only about its own page', () => {
    for (const id of GUIDE_IDS) {
      const text = GUIDE_INSTRUCTIONS(id)
      expect(text).toContain('How you speak')
      expect(text).toContain('Never ask for, accept or repeat a key')
      expect(text).toContain('You never release')
    }
    expect(GUIDE_INSTRUCTIONS('health')).toContain('"Findings"')
    expect(GUIDE_INSTRUCTIONS('health')).not.toContain('"New plan"')
    expect(GUIDE_INSTRUCTIONS('plans')).toContain('"New plan"')
  })

  it('names, in each manual, the words the screen uses', () => {
    expect(GUIDE_INSTRUCTIONS('board')).toContain('"Will retry itself"')
    expect(GUIDE_INSTRUCTIONS('inbox')).toContain('"Approve this commit"')
    expect(GUIDE_INSTRUCTIONS('repositories')).toContain('"Branch a release lands on"')
    expect(GUIDE_INSTRUCTIONS('setup')).toContain('"Check again"')
  })

  it('picks the model from the environment, falling back from the guide model to the chat model', () => {
    expect(guideModel({})).toBe('openrouter/openai/gpt-4.1-mini')
    expect(guideModel({ FACTORY_CHAT_MODEL: 'openrouter/x/chat' })).toBe('openrouter/x/chat')
    expect(
      guideModel({
        FACTORY_CHAT_MODEL: 'openrouter/x/chat',
        FACTORY_GUIDE_MODEL: 'openrouter/x/guide',
      }),
    ).toBe('openrouter/x/guide')
    expect(guideCodexModel({})).toBe('openai-chatgpt/gpt-5.4')
    expect(guideCodexModel({ FACTORY_CHAT_CODEX_MODEL: 'openai-chatgpt/y' })).toBe(
      'openai-chatgpt/y',
    )
  })
})

describe('buildAssistant', () => {
  it('refuses to ask approval for a tool it does not have', () => {
    expect(() =>
      buildAssistant('openrouter/x/y', { system: 's', tools: {}, asks: { ghost: 'sure?' } }),
    ).toThrow('not one of the tools')
  })
})
