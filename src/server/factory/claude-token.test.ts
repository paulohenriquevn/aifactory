import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readStoredToken, saveStoredToken, tokenFile, withClaudeToken } from './claude-token'

const TOKEN = `sk-ant-oat01-${'a'.repeat(80)}`
const OTHER = `sk-ant-oat01-${'b'.repeat(80)}`

const dirs: string[] = []
function scratch(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'claude-token-test-'))
  dirs.push(dir)
  return { FACTORY_CLAUDE_TOKEN_FILE: join(dir, 'secrets', 'token') }
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the saved Claude Code token', () => {
  it('is kept where FACTORY_CLAUDE_TOKEN_FILE says, else under .secrets', () => {
    expect(tokenFile({ FACTORY_CLAUDE_TOKEN_FILE: '/x/token' })).toBe('/x/token')
    expect(tokenFile({})).toBe(join(process.cwd(), '.secrets/claude-oauth-token'))
  })

  it('is read back without the newline it was saved with', () => {
    expect(readStoredToken({}, () => `${TOKEN}\n`)).toBe(TOKEN)
  })

  it('is nothing when the file is missing', () => {
    const missing = () => {
      throw new Error('ENOENT')
    }
    expect(readStoredToken({}, missing)).toBeUndefined()
  })

  it('is nothing when the file holds something that is not a token', () => {
    expect(readStoredToken({}, () => 'sk-ant-api03-not-a-subscription')).toBeUndefined()
  })
})

describe('withClaudeToken', () => {
  it('replaces the token from the environment file with the saved one', () => {
    const env = withClaudeToken({ CLAUDE_CODE_OAUTH_TOKEN: OTHER, KEEP: '1' }, () => TOKEN)
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN, KEEP: '1' })
  })

  it('leaves the environment as it is when nothing is saved', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: OTHER }
    expect(withClaudeToken(env, () => '')).toBe(env)
  })
})

describe('saveStoredToken', () => {
  it('writes a file only the owner can read, which reads back as the token', () => {
    const env = scratch()
    saveStoredToken(TOKEN, env)
    const file = tokenFile(env)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toBe(`${TOKEN}\n`)
    expect(readStoredToken(env)).toBe(TOKEN)
  })

  it('replaces the previous token and leaves no temporary file behind', () => {
    const env = scratch()
    saveStoredToken(OTHER, env)
    saveStoredToken(TOKEN, env)
    expect(readStoredToken(env)).toBe(TOKEN)
    expect(readdirSync(join(tokenFile(env), '..'))).toEqual(['token'])
  })

  it('refuses what is not a Claude Code token, and writes nothing', () => {
    const env = scratch()
    expect(() => saveStoredToken('hello', env)).toThrow(/not a Claude Code token/)
    expect(readStoredToken(env)).toBeUndefined()
  })
})
