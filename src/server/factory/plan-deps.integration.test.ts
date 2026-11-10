import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'

import { factoryDeps } from './deps'
import { planDeps } from './plan-deps'

beforeAll(() => getStorageManager().configure(storageFromUrl(readDatabaseUrl())))
afterAll(() => getStorageManager().dispose())

const key = join(mkdtempSync(join(tmpdir(), 'plan-')), 'app.pem')
writeFileSync(key, 'not a real key: it is only read when a token is asked for')

const base = {
  GITHUB_APP_SLUG: 'factory',
  GITHUB_APP_BOT_USER_ID: '1',
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY_PATH: key,
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
  FACTORY_CODEX_AUTH: 'api-key',
  OPENAI_API_KEY: 'sk-x',
}

const plannerOf = (env: NodeJS.ProcessEnv, labels: string[] = []) =>
  planDeps({ ...base, ...env }).harness(labels).name

describe('the agent that plans', () => {
  it('is the builder agent when the planner was not given another', () => {
    expect(plannerOf({})).toBe('claude-code')
    expect(plannerOf({ FACTORY_HARNESS: 'codex' })).toBe('codex')
  })

  it('is the one the owner gave it, whatever builds', () => {
    expect(plannerOf({ FACTORY_HARNESS: 'claude-code', FACTORY_PLANNER: 'codex' })).toBe('codex')
    expect(plannerOf({ FACTORY_HARNESS: 'codex', FACTORY_PLANNER: 'claude-code' })).toBe(
      'claude-code',
    )
  })

  it('still refuses a name the factory does not know', () => {
    expect(() => plannerOf({ FACTORY_PLANNER: 'gpt-9' })).toThrow(/unknown agent "gpt-9"/)
  })
})

describe('the knowledge base of the agents in a sandbox', () => {
  it('comes from the same source for the runs and for the planner, the mirror on this host', () => {
    const env = { ...base, FACTORY_KNOWLEDGE_DIR: '/state/knowledge' }
    const run = factoryDeps(env).knowledge
    const plans = planDeps(env).knowledge

    expect(run).toBeDefined()
    expect(plans).toBeDefined()
    expect(Object.keys(plans!).sort()).toEqual(['delivered', 'keep', 'pin', 'slice'])
  })
})
