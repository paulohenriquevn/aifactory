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
    await expect(saveChosen(getDb(), { builder: 'claude-code' }, {})).rejects.toThrow(
      /claude-code cannot start/,
    )
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
    expect(view.agents.find((a) => a.id === 'builder')?.engine.value).toBe('codex')
    expect(view.agents.find((a) => a.id === 'planner')?.engine.value).toBe('claude-code')
    expect(view.settings.effective.builder).toBe('codex')
    expect(view.shared[0].text).toBe('CONTEXT')
  })
})
