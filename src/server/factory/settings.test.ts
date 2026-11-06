import { describe, expect, it } from 'vitest'

import { effectiveOf, engineOptions, ROLE_ENV } from './settings'

// The token the panel saved lives in the project folder; a test that reads it depends on the machine.
const nothingSaved = { FACTORY_CLAUDE_TOKEN_FILE: '/nonexistent/claude-oauth-token' }
const withClaude = { ...nothingSaved, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' }
const withBoth = { ...withClaude, CODEX_HOME: '/nowhere' }

describe('which agent a role uses', () => {
  it('reads each role from the variable it always came from', () => {
    expect(ROLE_ENV).toEqual({
      builder: 'FACTORY_HARNESS',
      planner: 'FACTORY_PLANNER',
      reviewer: 'FACTORY_REVIEWER',
    })
  })

  it('is claude-code for all three when nothing says otherwise', () => {
    expect(effectiveOf({})).toEqual({
      builder: 'claude-code',
      planner: 'claude-code',
      reviewer: 'claude-code',
    })
  })

  it('makes the planner and the reviewer follow the builder, until each is given another', () => {
    expect(effectiveOf({ FACTORY_HARNESS: 'codex' })).toEqual({
      builder: 'codex',
      planner: 'codex',
      reviewer: 'codex',
    })
    expect(effectiveOf({ FACTORY_HARNESS: 'codex', FACTORY_REVIEWER: 'claude-code' })).toEqual({
      builder: 'codex',
      planner: 'codex',
      reviewer: 'claude-code',
    })
    expect(effectiveOf({ FACTORY_PLANNER: 'codex' }).planner).toBe('codex')
    expect(effectiveOf({ FACTORY_PLANNER: '', FACTORY_HARNESS: '' })).toEqual({
      builder: 'claude-code',
      planner: 'claude-code',
      reviewer: 'claude-code',
    })
  })
})

describe('the agents that could start now', () => {
  it('lists every agent the factory knows, ready or not', () => {
    expect(engineOptions(nothingSaved).map((o) => o.id)).toEqual(['claude-code', 'codex'])
  })

  it('says what is missing for one that cannot start, instead of hiding it', () => {
    const [claude] = engineOptions(nothingSaved)
    expect(claude.ready).toBe(false)
    expect(claude.problem).toBeTruthy()
    expect(JSON.stringify(engineOptions(nothingSaved))).not.toContain('sk-ant')
  })

  it('calls an agent ready when its credential is there', () => {
    expect(engineOptions(withClaude).find((o) => o.id === 'claude-code')).toEqual({
      id: 'claude-code',
      ready: true,
    })
    expect(withBoth).toBeDefined()
  })
})
