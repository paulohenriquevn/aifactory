import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { repository } from '../db/schema'
import { ActionRefused } from '../panel/actions'
import { changeAgentSettings } from '../panel/agent-settings'

import { agentsView } from './agent-view'
import { agentSettings, effectiveEnv, loadChosen, saveChosen, SettingRefused } from './settings'
import { optionsFor } from './engine-models'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query('truncate table setting, repository restart identity cascade')
})
afterAll(() => getStorageManager().dispose())

const ready = {
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
  FACTORY_CODEX_AUTH: 'api-key',
  OPENAI_API_KEY: 'sk-x',
}

describe('the choice of agent, kept in the panel', () => {
  it('starts with nothing chosen, so the environment decides', async () => {
    expect(await loadChosen(getDb())).toEqual({ builder: null, planner: null, reviewer: null })
    const env = await effectiveEnv(getDb(), { FACTORY_HARNESS: 'codex' })
    expect(env.FACTORY_HARNESS).toBe('codex')
  })

  it('lays a choice over the environment, for that role only', async () => {
    await saveChosen(getDb(), { builder: 'claude-code' }, ready)
    const env = await effectiveEnv(getDb(), {
      FACTORY_HARNESS: 'codex',
      FACTORY_REVIEWER: 'codex',
      PATH: '/bin',
    })
    expect(env.FACTORY_HARNESS).toBe('claude-code')
    expect(env.FACTORY_REVIEWER).toBe('codex')
    expect(env.PATH).toBe('/bin')
    expect(env.FACTORY_PLANNER).toBeUndefined()
  })

  it('changes a choice, keeps the others, and goes back to the environment on null', async () => {
    await saveChosen(getDb(), { builder: 'codex', reviewer: 'claude-code' }, ready)
    await saveChosen(getDb(), { builder: 'claude-code' }, ready)
    expect(await loadChosen(getDb())).toEqual({
      builder: 'claude-code',
      planner: null,
      reviewer: 'claude-code',
    })
    await saveChosen(getDb(), { reviewer: null }, ready)
    expect(await loadChosen(getDb())).toEqual({
      builder: 'claude-code',
      planner: null,
      reviewer: null,
    })
    await saveChosen(getDb(), {}, ready)
    expect((await loadChosen(getDb())).builder).toBe('claude-code')
  })

  it('refuses an agent the factory does not know, and one that could not start, and saves nothing', async () => {
    await expect(saveChosen(getDb(), { builder: 'gpt-9' }, ready)).rejects.toThrow(
      'not an agent the factory knows',
    )
    await expect(
      saveChosen(
        getDb(),
        { builder: 'claude-code' },
        {
          FACTORY_CLAUDE_TOKEN_FILE: '/nonexistent/claude-oauth-token',
        },
      ),
    ).rejects.toThrow(/claude-code cannot start/)
    await expect(
      saveChosen(getDb(), { builder: 'claude-code', planner: 'gpt-9' }, ready),
    ).rejects.toBeInstanceOf(SettingRefused)
    expect(await loadChosen(getDb())).toEqual({ builder: null, planner: null, reviewer: null })
  })

  it('turns a refusal into one the panel can show', async () => {
    await expect(changeAgentSettings(getDb(), { planner: 'nope' }, ready)).rejects.toBeInstanceOf(
      ActionRefused,
    )
  })

  it('says what stands: the options, what was chosen, what runs, and who has an agent of their own', async () => {
    await getDb()
      .insert(repository)
      .values([
        { fullName: 'o/own', enabled: true, harness: 'codex' },
        { fullName: 'o/plain', enabled: true },
        { fullName: 'o/off', enabled: false, harness: 'codex' },
      ])
    await saveChosen(getDb(), { reviewer: 'codex' }, ready)
    const settings = await agentSettings(getDb(), { ...ready, FACTORY_HARNESS: 'claude-code' })
    expect(settings.options.map((o) => [o.id, o.ready])).toEqual([
      ['claude-code', true],
      ['codex', true],
    ])
    expect(settings.chosen).toEqual({ builder: null, planner: null, reviewer: 'codex' })
    expect(settings.effective).toEqual({
      builder: 'claude-code',
      planner: 'claude-code',
      reviewer: 'codex',
    })
    expect(settings.repositoriesWithOwn).toEqual([
      { repository: 'o/own', builder: 'codex', reviewer: null },
    ])
  })

  it('shows the catalog with the agents as they work now, and the settings beside it', async () => {
    await saveChosen(getDb(), { builder: 'codex', planner: 'claude-code' }, ready)
    const view = await agentsView(getDb(), ready, () => 'CONTEXT')
    expect(view.agents.find((a) => a.id === 'builder')?.engine.value).toBe('codex · modelo padrão')
    expect(view.agents.find((a) => a.id === 'planner')?.engine.value).toBe(
      'claude-code · modelo padrão',
    )
    expect(view.settings.effective.builder).toBe('codex')
    expect(view.shared[0].text).toBe('CONTEXT')
  })
})

const cache = JSON.stringify({
  models: [
    {
      slug: 'gpt-6.1-sol',
      display_name: 'GPT-6.1-Sol',
      visibility: 'list',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
    },
    {
      slug: 'gpt-6-luna',
      display_name: 'GPT-6-Luna',
      visibility: 'list',
      supported_reasoning_levels: [{ effort: 'low' }],
    },
  ],
})
const read = () => cache

describe('the model and the effort, kept in the panel', () => {
  it('saves a model and an effort for a role, and a run is told them for that agent', async () => {
    await saveChosen(
      getDb(),
      { builder: 'codex', models: { builder: 'gpt-6.1-sol' }, efforts: { builder: 'high' } },
      ready,
      read,
    )
    const env = await effectiveEnv(getDb(), { ...ready })
    expect(env.FACTORY_MODEL_BUILDER).toBe('codex:gpt-6.1-sol')
    expect(env.FACTORY_EFFORT_BUILDER).toBe('codex:high')
    expect(optionsFor(env, 'builder', 'codex')).toEqual({ model: 'gpt-6.1-sol', effort: 'high' })
    expect(optionsFor(env, 'builder', 'claude-code')).toEqual({})
    expect(optionsFor(env, 'planner', 'codex')).toEqual({ model: 'gpt-6.1-sol', effort: 'high' })
  })

  it('refuses a model the agent does not offer, one of the other agent, and one that is not a plain name', async () => {
    await expect(
      saveChosen(getDb(), { builder: 'codex', models: { builder: 'opus' } }, ready, read),
    ).rejects.toThrow(/"opus" is not a model codex offers \(gpt-6.1-sol, gpt-6-luna\)/)
    await expect(
      saveChosen(
        getDb(),
        { builder: 'claude-code', models: { builder: 'gpt-6.1-sol' } },
        ready,
        read,
      ),
    ).rejects.toThrow(/not a model claude-code offers/)
    await expect(
      saveChosen(getDb(), { builder: 'codex', models: { builder: 'a;b' } }, ready, read),
    ).rejects.toThrow(/not a plain model name/)
    expect(await loadChosen(getDb())).toEqual({ builder: null, planner: null, reviewer: null })
  })

  it('refuses an effort the model does not take, and takes any level of the agent when no model is chosen', async () => {
    await expect(
      saveChosen(
        getDb(),
        { builder: 'codex', models: { builder: 'gpt-6-luna' }, efforts: { builder: 'high' } },
        ready,
        read,
      ),
    ).rejects.toThrow(/not an effort codex offers \(low\)/)
    await saveChosen(getDb(), { builder: 'codex', efforts: { builder: 'high' } }, ready, read)
    expect((await effectiveEnv(getDb(), ready)).FACTORY_EFFORT_BUILDER).toBe('codex:high')
    await expect(
      saveChosen(getDb(), { efforts: { builder: 'ultra' } }, ready, read),
    ).rejects.toThrow(/not an effort/)
  })

  it('checks a model against the agent the role will use once saved, even when it is saved together', async () => {
    await saveChosen(
      getDb(),
      {
        builder: 'claude-code',
        reviewer: 'codex',
        models: { builder: 'opus', reviewer: 'gpt-6-luna' },
      },
      ready,
      read,
    )
    const env = await effectiveEnv(getDb(), ready)
    expect(env.FACTORY_MODEL_BUILDER).toBe('claude-code:opus')
    expect(env.FACTORY_MODEL_REVIEWER).toBe('codex:gpt-6-luna')
  })

  it("checks a planner that follows the builder against the builder's agent", async () => {
    await saveChosen(getDb(), { builder: 'codex' }, ready, read)
    await saveChosen(getDb(), { models: { planner: 'gpt-6-luna' } }, ready, read)
    expect((await effectiveEnv(getDb(), ready)).FACTORY_MODEL_PLANNER).toBe('codex:gpt-6-luna')
    await expect(saveChosen(getDb(), { models: { planner: 'opus' } }, ready, read)).rejects.toThrow(
      /not a model codex offers/,
    )
  })

  it("goes back to the agent's own default on null, and leaves what it was not asked to touch", async () => {
    await saveChosen(
      getDb(),
      { builder: 'codex', models: { builder: 'gpt-6.1-sol' }, efforts: { builder: 'high' } },
      ready,
      read,
    )
    await saveChosen(getDb(), { models: { builder: null } }, ready, read)
    const env = await effectiveEnv(getDb(), ready)
    expect(env.FACTORY_MODEL_BUILDER).toBeUndefined()
    expect(env.FACTORY_EFFORT_BUILDER).toBe('codex:high')
    await saveChosen(getDb(), { efforts: { builder: null } }, ready, read)
    expect((await effectiveEnv(getDb(), ready)).FACTORY_EFFORT_BUILDER).toBeUndefined()
  })

  it('keeps a model and an effort with their agent: another agent is not told them, and the page does not show them', async () => {
    await saveChosen(
      getDb(),
      { builder: 'codex', models: { builder: 'gpt-6.1-sol' }, efforts: { builder: 'high' } },
      ready,
      read,
    )
    await saveChosen(getDb(), { builder: 'claude-code' }, ready, read)
    const settings = await agentSettings(getDb(), ready, read)
    expect(settings.effective.builder).toBe('claude-code')
    expect(settings.chosenModel.builder).toBeNull()
    expect(settings.chosenEffort.builder).toBeNull()
    expect(optionsFor(await effectiveEnv(getDb(), ready), 'builder', 'claude-code')).toEqual({})
    await saveChosen(getDb(), { builder: 'codex' }, ready, read)
    expect((await agentSettings(getDb(), ready, read)).chosenModel.builder).toBe('gpt-6.1-sol')
  })

  it('says to the page which models and levels each agent offers, and what is chosen', async () => {
    await saveChosen(getDb(), { builder: 'codex', models: { builder: 'gpt-6-luna' } }, ready, read)
    const settings = await agentSettings(getDb(), ready, read)
    expect(settings.engines.codex.models.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-luna'])
    expect(settings.engines['claude-code'].models.map((m) => m.id)).toEqual([
      'sonnet',
      'opus',
      'fable',
    ])
    expect(settings.chosenModel).toEqual({ builder: 'gpt-6-luna', planner: null, reviewer: null })
  })

  it('shows the catalog with the model in use', async () => {
    await saveChosen(
      getDb(),
      { builder: 'codex', models: { builder: 'gpt-6.1-sol' }, efforts: { builder: 'high' } },
      ready,
      read,
    )
    const view = await agentsView(getDb(), ready, () => 'CTX')
    expect(view.agents.find((a) => a.id === 'builder')?.engine.value).toBe(
      'codex · gpt-6.1-sol · esforço high',
    )
  })
})
