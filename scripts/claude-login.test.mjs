import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { waitingIds } from './retry-waiting.mjs'

const script = resolve(process.cwd(), 'scripts/claude-login.sh')
const GOOD = `sk-ant-oat01-${'A1b2C3d4_-'.repeat(8)}`

/** Runs the script in a scratch directory, with a stand-in for `claude` that answers as told. */
function run({ token, claudeSays, envText }) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-login-'))
  const bin = join(dir, 'bin')
  spawnSync('mkdir', ['-p', bin])
  writeFileSync(join(dir, 'answer'), claudeSays)
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat '${join(dir, 'answer')}'\n`)
  chmodSync(join(bin, 'claude'), 0o755)
  const envFile = join(dir, 'env')
  writeFileSync(envFile, envText)
  chmodSync(envFile, 0o644)
  const result = spawnSync('bash', [script], {
    input: `${token}\n`,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ENV_FILE: envFile, NO_RESTART: '1' },
  })
  return { ...result, file: readFileSync(envFile, 'utf8'), mode: statSync(envFile).mode & 0o777 }
}

const OK = JSON.stringify({ is_error: false, result: 'ok' })
const BEFORE = 'FACTORY_HARNESS=codex\nCLAUDE_CODE_OAUTH_TOKEN=old-token\nOPENROUTER_API_KEY=keep\n'

describe('changing the Claude Code account', () => {
  it('refuses what is not a token, and saves nothing', () => {
    for (const token of ['', 'abc', 'sk-ant-oat01-short', 'AbCdEf#state-code']) {
      const r = run({ token, claudeSays: OK, envText: BEFORE })
      expect(r.status, token).toBe(1)
      expect(r.stderr).toContain('não parece o token')
      expect(r.file).toBe(BEFORE)
    }
  })

  it('refuses a token the account is not allowed to use now, and says why, and saves nothing', () => {
    const limit = JSON.stringify({
      is_error: true,
      result: "You've hit your weekly limit · resets Nov 8, 5pm",
    })
    const r = run({ token: GOOD, claudeSays: limit, envText: BEFORE })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('weekly limit')
    expect(r.stderr).toContain('Nada foi gravado')
    expect(r.file).toBe(BEFORE)
  })

  it('refuses a token when claude does not answer with a result at all', () => {
    const r = run({ token: GOOD, claudeSays: 'Invalid API key', envText: BEFORE })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Invalid API key')
    expect(r.file).toBe(BEFORE)
  })

  it('replaces the token, keeps every other line, asks for the subscription, and keeps the file private', () => {
    const r = run({ token: GOOD, claudeSays: OK, envText: BEFORE })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('O token funciona')
    expect(r.file).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${GOOD}`)
    expect(r.file).not.toContain('old-token')
    expect(r.file).toContain('FACTORY_HARNESS=codex')
    expect(r.file).toContain('OPENROUTER_API_KEY=keep')
    expect(r.file).toContain('FACTORY_CLAUDE_AUTH=subscription')
    expect(r.file.match(/CLAUDE_CODE_OAUTH_TOKEN=/g)).toHaveLength(1)
    expect(r.mode).toBe(0o600)
  })

  it('does not touch a choice of how Claude is paid that was already made', () => {
    const r = run({
      token: GOOD,
      claudeSays: OK,
      envText: `${BEFORE}FACTORY_CLAUDE_AUTH=api-key\n`,
    })
    expect(r.status).toBe(0)
    expect(r.file).toContain('FACTORY_CLAUDE_AUTH=api-key')
    expect(r.file).not.toContain('FACTORY_CLAUDE_AUTH=subscription')
  })

  it('adds the token to a file that had none', () => {
    const r = run({ token: GOOD, claudeSays: OK, envText: 'FACTORY_HARNESS=codex\n' })
    expect(r.file).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${GOOD}`)
    expect(r.file).toContain('FACTORY_HARNESS=codex')
  })

  it('never prints the token, whatever happens', () => {
    const okRun = run({ token: GOOD, claudeSays: OK, envText: BEFORE })
    const refused = run({
      token: GOOD,
      claudeSays: JSON.stringify({ is_error: true, result: 'nope' }),
      envText: BEFORE,
    })
    for (const r of [okRun, refused]) {
      expect(r.stdout).not.toContain(GOOD)
      expect(r.stderr).not.toContain(GOOD)
    }
  })
})

describe('the tasks that wait for something that has passed', () => {
  it('are the failed ones the board lists as retrying themselves, and no other', () => {
    const cards = [
      { id: 1, stage: 'failed', retryable: 'quota' },
      { id: 2, stage: 'failed', retryable: 'environment' },
      { id: 3, stage: 'failed', retryable: null },
      { id: 4, stage: 'build', retryable: null },
      { id: 5, stage: 'done', retryable: 'quota' },
      { id: 6, stage: 'failed' },
    ]
    expect(waitingIds(cards)).toEqual([1, 2])
    expect(waitingIds([])).toEqual([])
  })
})
