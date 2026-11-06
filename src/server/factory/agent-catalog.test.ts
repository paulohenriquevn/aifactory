import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { GUIDE_IDS } from '../../shared/guides'
import { ACTING_TOOLS, CHAT_TOOLS } from './chat-agent'

import { agentCatalog } from './agent-catalog'
import { buildPrompt } from './harness'
import { planPrompt } from './plan'
import { reviewPrompt } from './review'

const read = () => 'CONTEXT OF THE FACTORY'
const catalog = (env: NodeJS.ProcessEnv = {}) => agentCatalog(env, read)
const agent = (id: string, env: NodeJS.ProcessEnv = {}) =>
  catalog(env).agents.find((a) => a.id === id)!

describe('the catalog of agents', () => {
  it('lists the ones that build first and the ones that talk to the owner after, each once', () => {
    const { agents } = catalog()
    expect(agents.map((a) => a.id)).toEqual([
      'builder',
      'reviewer',
      'planner',
      'chat',
      ...GUIDE_IDS.map((id) => `guide-${id}`),
      'assist',
      'assist-setup',
    ])
    expect(new Set(agents.map((a) => a.id)).size).toBe(agents.length)
    expect(agents.filter((a) => a.group === 'factory').map((a) => a.runsIn)).toEqual([
      'sandbox',
      'sandbox',
      'sandbox',
    ])
    expect(agents.filter((a) => a.group === 'panel').every((a) => a.runsIn === 'server')).toBe(true)
  })

  it('has a guide for every page of the menu, and an agent file serving each of them', () => {
    const files = new Set(readdirSync(resolve(process.cwd(), 'src/server/agents')))
    for (const id of GUIDE_IDS) {
      expect(files.has(`guide-${id}.ts`), id).toBe(true)
      expect(files.has(`guide-${id}-codex.ts`), `${id} codex`).toBe(true)
    }
    for (const id of ['chat', 'chat-codex', 'assist', 'assist-setup'])
      expect(files.has(`${id}.ts`), id).toBe(true)
  })

  it('shows the prompts the code builds, with marks where the data of a task goes', () => {
    const builder = agent('builder')
    expect(builder.prompts.map((p) => p.id)).toEqual([
      'build',
      'build-silent',
      'build-feedback',
      'rework',
      'answer',
    ])
    const first = builder.prompts[0].text
    expect(first).toBe(
      buildPrompt({
        repo: '‹repositório›',
        issueNumber: 0,
        title: '‹título da issue›',
        body: '‹texto da issue›',
        branch: '‹branch›',
      }).replaceAll('#0)', '#‹número›)'),
    )
    expect(first).toContain('(#‹número›)')
    expect(first).not.toContain('#0')
    expect(builder.prompts.every((p) => p.template)).toBe(true)
    expect(agent('reviewer').prompts[0].text).toBe(
      reviewPrompt({
        repo: '‹repositório›',
        issueNumber: 0,
        title: '‹título da issue›',
        body: '‹texto da issue›',
        branch: '‹branch›',
        baseSha: '‹commit base›',
      }).replaceAll('#0)', '#‹número›)'),
    )
    expect(agent('planner').prompts[0].text).toBe(
      planPrompt({ repo: '‹repositório›', goal: '‹o objetivo que você escreveu›' }),
    )
  })

  it('tells the variants of the builder prompt apart by what really differs', () => {
    const [first, silent, feedback, rework, answer] = agent('builder').prompts.map((p) => p.text)
    expect(first).toContain('QUESTION:')
    expect(silent).not.toContain('QUESTION:')
    expect(silent).toContain('do not ask one')
    expect(feedback).toContain('‹o pedido da pessoa›')
    expect(rework).toContain('‹comando do check›')
    expect(rework).toContain('‹arquivo›')
    expect(answer).toContain('‹a resposta›')
  })

  it('gives a panel agent its instructions whole, and has no marks in them', () => {
    for (const a of catalog().agents.filter((x) => x.group === 'panel')) {
      expect(a.prompts).toHaveLength(1)
      expect(a.prompts[0].template, a.id).toBe(false)
      expect(a.prompts[0].text.length, a.id).toBeGreaterThan(200)
    }
    expect(agent('guide-board').prompts[0].text).toContain('How you speak')
    expect(agent('guide-board').prompts[0].text).toContain('Board')
    expect(agent('guide-health').prompts[0].text).not.toContain('"New plan"')
  })

  it('says which tools only read and which ask the owner, the same ones the agents are held to', () => {
    const chat = agent('chat')
    expect(chat.tools.map((t) => t.name)).toEqual(CHAT_TOOLS)
    expect(chat.tools.filter((t) => t.effect === 'asks').map((t) => t.name)).toEqual(ACTING_TOOLS)
    expect(chat.tools.every((t) => t.description.length > 10)).toBe(true)
    expect(agent('guide-setup').tools.map((t) => t.effect)).toEqual(['reads'])
    expect(agent('guide-agents').tools.map((t) => [t.name, t.effect])).toEqual([
      ['list_agents', 'reads'],
      ['agent_prompt', 'reads'],
      ['update_agent_settings', 'asks'],
    ])
    expect(agent('assist-setup').tools.map((t) => t.name)).toEqual([
      'propose',
      'repo_files',
      'repo_file',
    ])
    expect(agent('assist').tools.map((t) => t.name)).toEqual(['propose'])
  })

  it('says the agents that build act only inside the sandbox', () => {
    for (const id of ['builder', 'reviewer', 'planner']) {
      expect(agent(id).tools).toHaveLength(1)
      expect(agent(id).tools[0].effect).toBe('sandbox')
    }
  })

  it('reports the model and the coding agent as they are configured now', () => {
    expect(agent('builder').engine.value).toBe('claude-code')
    expect(agent('builder', { FACTORY_HARNESS: 'codex' }).engine.value).toBe('codex')
    expect(agent('planner', { FACTORY_HARNESS: 'codex' }).engine.value).toBe(
      'codex (o mesmo do construtor)',
    )
    expect(
      agent('planner', { FACTORY_HARNESS: 'codex', FACTORY_PLANNER: 'claude-code' }).engine.value,
    ).toBe('claude-code')
    expect(agent('reviewer').engine.value).toContain('o mesmo do construtor')
    expect(agent('reviewer', { FACTORY_REVIEWER: 'codex' }).engine.value).toBe('codex')
    expect(agent('chat').engine.value).toContain('openrouter/google/gemini-2.5-flash')
    expect(agent('chat', { FACTORY_CHAT_MODEL: 'openrouter/x/y' }).engine.value).toContain(
      'openrouter/x/y',
    )
    expect(agent('guide-board', { FACTORY_GUIDE_MODEL: 'openrouter/g/h' }).engine.value).toContain(
      'openrouter/g/h',
    )
    expect(agent('assist').engine.value).toBe('anthropic/claude-sonnet-4-6')
    expect(agent('assist-setup', { FACTORY_ASSIST_MODEL: 'openrouter/a/b' }).engine.value).toBe(
      'openrouter/a/b',
    )
    expect(agent('chat').engine.change).toContain('FACTORY_CHAT_MODEL')
  })

  it('adds the context of the factory to every panel agent, and to no agent that builds', () => {
    const view = catalog()
    expect(view.shared).toHaveLength(1)
    expect(view.shared[0]).toMatchObject({ id: 'theo', text: 'CONTEXT OF THE FACTORY' })
    for (const a of view.agents) expect(a.shared, a.id).toEqual(a.group === 'panel' ? ['theo'] : [])
  })

  it('has no shared context, and still lists the agents, when the file is not there', () => {
    const view = agentCatalog({}, () => {
      throw new Error('ENOENT')
    })
    expect(view.shared).toEqual([])
    expect(view.agents.length).toBeGreaterThan(10)
  })

  it('reads the real context file of the factory when it is not told another', () => {
    const view = agentCatalog({})
    expect(view.shared[0].text).toContain('What the aifactory is')
  })

  it('names, for every agent, source files that exist, so the page does not point at nothing', () => {
    for (const a of catalog().agents) {
      expect(a.source.length, a.id).toBeGreaterThan(0)
      for (const file of a.source)
        expect(existsSync(resolve(process.cwd(), file)), `${a.id}: ${file}`).toBe(true)
    }
  })

  it('carries no credential: it is built from prompts and names, never from the environment values', () => {
    const view = catalog({
      OPENROUTER_API_KEY: 'sk-or-SECRET',
      GITHUB_APP_PRIVATE_KEY_PATH: '/secret/key',
      FACTORY_PANEL_TOKEN: 'tok-SECRET',
    })
    const text = JSON.stringify(view)
    for (const secret of ['sk-or-SECRET', '/secret/key', 'tok-SECRET'])
      expect(text).not.toContain(secret)
  })
})
