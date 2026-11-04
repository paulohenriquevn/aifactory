import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FakeSandbox } from './fake-sandbox'
import {
  CODEX_VERSION,
  codexCredentialFromEnv,
  codexHarness,
  loadCodexLogin,
  parseCodexResult,
  placeholderAuth,
} from './harness-codex'

const jwt = (claims: object) =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.real-signature`

const SECRET_ACCESS = (exp: number) => jwt({ exp, client_id: 'app_test', sub: 'user' })
const NOW = 1_800_000_000_000

function loginDir(expInSeconds: number, refresh = 'refresh-real') {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: jwt({ email: 'a@b.c', plan: 'plus' }),
        access_token: SECRET_ACCESS(NOW / 1000 + expInSeconds),
        refresh_token: refresh,
        account_id: 'acct-1',
      },
      last_refresh: '2026-11-04T00:00:00Z',
    }),
  )
  return home
}

const line = (event: object) => JSON.stringify(event)

describe('parseCodexResult', () => {
  it('reads the thread id and the last thing the agent said', () => {
    const stdout = [
      line({ type: 'thread.started', thread_id: '019a0000-0000-7000-8000-000000000001' }),
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'Added truncate.' } }),
      line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }),
    ].join('\n')

    expect(parseCodexResult(0, stdout, '')).toEqual({
      ok: true,
      summary: 'Added truncate.',
      sessionId: '019a0000-0000-7000-8000-000000000001',
    })
  })

  it('reads a quota stop as a wait, with the time it ends', () => {
    const message =
      'You’ve hit your usage limit. Upgrade to Pro, or try again at Nov 5th, 2026 11:48 AM.'
    const stdout = [
      line({ type: 'error', message: 'Reconnecting... 5/5 (stream disconnected)' }),
      line({ type: 'error', message }),
      line({ type: 'turn.failed', error: { message } }),
    ].join('\n')

    const result = parseCodexResult(1, stdout, '')

    expect(result.ok).toBe(false)
    expect(result.quota?.resetsAt).toBe('Nov 5th, 2026 11:48 AM')
  })

  it('is not ok without a completed turn, and ignores transport fallbacks', () => {
    const stdout = line({ type: 'error', message: 'Falling back from WebSockets to HTTPS' })
    const result = parseCodexResult(0, stdout, 'boom')
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('boom')
    expect(result.quota).toBeUndefined()
  })

  it('keeps a plain failure apart from a quota stop', () => {
    const stdout = line({ type: 'turn.failed', error: { message: 'model not found' } })
    const result = parseCodexResult(1, stdout, '')
    expect(result).toMatchObject({ ok: false, summary: 'codex failed: model not found' })
    expect(result.quota).toBeUndefined()
  })
})

describe('codexCredentialFromEnv', () => {
  const home = '/factory-home'
  const has = (yes: boolean) => () => yes

  it('prefers an API key, then a login in the factory home', () => {
    expect(codexCredentialFromEnv({ OPENAI_API_KEY: 'k' }, has(true))).toEqual({
      kind: 'api-key',
      secret: 'k',
    })
    expect(codexCredentialFromEnv({ FACTORY_CODEX_HOME: home }, has(true))).toEqual({
      kind: 'subscription',
      home,
    })
  })

  it('lets FACTORY_CODEX_AUTH choose and says what is missing', () => {
    expect(
      codexCredentialFromEnv(
        { OPENAI_API_KEY: 'k', FACTORY_CODEX_AUTH: 'subscription', FACTORY_CODEX_HOME: home },
        has(true),
      ).kind,
    ).toBe('subscription')
    expect(() => codexCredentialFromEnv({ FACTORY_CODEX_HOME: home }, has(false))).toThrow(
      /codex login --device-auth/,
    )
    expect(() => codexCredentialFromEnv({ FACTORY_CODEX_AUTH: 'api-key' }, has(true))).toThrow(
      /OPENAI_API_KEY is not set/,
    )
    expect(() => codexCredentialFromEnv({ FACTORY_CODEX_AUTH: 'x' }, has(true))).toThrow(
      /api-key or subscription/,
    )
  })
})

describe('loadCodexLogin', () => {
  it('uses the stored token while it has days left, without calling out', async () => {
    const home = loginDir(5 * 24 * 3600)
    const fetch = async () => {
      throw new Error('must not be called')
    }

    const login = await loadCodexLogin(home, { fetch, now: () => NOW })

    expect(login.accountId).toBe('acct-1')
    expect(login.accessToken.split('.').length).toBe(3)
  })

  it('renews a token close to expiring and keeps the rotated refresh token', async () => {
    const home = loginDir(3600)
    const fresh = SECRET_ACCESS(NOW / 1000 + 10 * 24 * 3600)
    let sent: { client_id: string; refresh_token: string } | undefined
    const fetch = async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ access_token: fresh, refresh_token: 'refresh-next' }))
    }

    const login = await loadCodexLogin(home, { fetch, now: () => NOW })

    expect(sent).toMatchObject({ client_id: 'app_test', refresh_token: 'refresh-real' })
    expect(login.accessToken).toBe(fresh)
    const stored = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'))
    expect(stored.tokens.refresh_token).toBe('refresh-next')
    expect(stored.tokens.account_id).toBe('acct-1')
  })

  it('says how to log in again when the renewal is refused', async () => {
    const home = loginDir(60)
    const fetch = async () => new Response('{}', { status: 401 })
    await expect(loadCodexLogin(home, { fetch, now: () => NOW })).rejects.toThrow(
      /could not be renewed \(HTTP 401\).*codex login --device-auth/,
    )
  })
})

describe('placeholderAuth', () => {
  it('keeps the claims Codex reads and none of the secrets', () => {
    const login = {
      accessToken: SECRET_ACCESS(NOW / 1000 + 100),
      idToken: jwt({ plan: 'plus' }),
      accountId: 'acct-1',
    }

    const text = placeholderAuth(login, () => NOW)
    const auth = JSON.parse(text)

    expect(text).not.toContain('real-signature')
    expect(text).not.toContain('refresh-real')
    expect(auth.tokens.refresh_token).toBe('placeholder-not-a-secret')
    expect(auth.tokens.account_id).toBe('acct-1')
    expect(auth.tokens.access_token.split('.')[1]).toBe(login.accessToken.split('.')[1])
  })
})

describe('codexHarness', () => {
  const input = { prompt: 'PROMPT', cwd: '/work/repo', timeoutMs: 5 }
  const done = line({ type: 'turn.completed' })

  it('signs an API key at api.openai.com and leaves the sandbox a placeholder', async () => {
    const harness = codexHarness({ kind: 'api-key', secret: 'sk-real' })
    const sandbox = new FakeSandbox(() => ({ stdout: done }))
    const { backend } = await sandbox.create({ timeoutMs: 1, egress: [{ domain: 'github.com' }] })

    expect(await harness.egress()).toEqual([
      { domain: 'api.openai.com', headers: { authorization: 'Bearer sk-real' } },
    ])
    await harness.prepare?.(backend)
    const result = await harness.run(backend, input)

    expect(result.ok).toBe(true)
    const everything = [...sandbox.backend.commands, ...sandbox.backend.files.values()].join('\n')
    expect(everything).not.toContain('sk-real')
    const run = sandbox.backend.commands.at(-1)!
    expect(run).toContain('cd /work/repo && OPENAI_API_KEY=placeholder-not-a-secret')
    expect(run).toContain(
      'exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --json -',
    )
    expect(run).toContain('< /tmp/factory-prompt.md')
    expect(sandbox.backend.commands[0]).toContain(`@openai/codex@${CODEX_VERSION}`)
  })

  it('signs the subscription access token at chatgpt.com and installs a placeholder login', async () => {
    const home = loginDir(5 * 24 * 3600)
    const access = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')).tokens.access_token
    const harness = codexHarness({ kind: 'subscription', home }, { now: () => NOW })
    const sandbox = new FakeSandbox(() => ({ stdout: done }))
    const { backend } = await sandbox.create({ timeoutMs: 1, egress: [{ domain: 'github.com' }] })

    expect(await harness.egress()).toEqual([
      { domain: 'chatgpt.com', headers: { authorization: `Bearer ${access}` } },
    ])
    await harness.prepare?.(backend)

    const everything = [...sandbox.backend.commands, ...sandbox.backend.files.values()].join('\n')
    expect(everything).not.toContain('refresh-real')
    expect(everything).not.toContain('real-signature')
    expect(sandbox.backend.files.get('/tmp/codex-auth.json')).toContain('placeholder-not-a-secret')
    expect(sandbox.backend.commands.some((c) => c.includes('chmod 600'))).toBe(true)
  })

  it('stops when codex does not install', async () => {
    const harness = codexHarness({ kind: 'api-key', secret: 'k' })
    const sandbox = new FakeSandbox((c) =>
      c.includes('--version') ? { exitCode: 127, stderr: 'not found' } : { stdout: 'npm ERR!' },
    )
    const { backend } = await sandbox.create({ timeoutMs: 1, egress: [{ domain: 'github.com' }] })
    await expect(harness.prepare?.(backend)).rejects.toThrow(/codex did not install/)
  })

  it('resumes a session by id, and refuses an id that is not a UUID', async () => {
    const harness = codexHarness({ kind: 'api-key', secret: 'k' })
    const sandbox = new FakeSandbox(() => ({ stdout: done }))
    const { backend } = await sandbox.create({ timeoutMs: 1, egress: [{ domain: 'github.com' }] })
    const id = '019a0000-0000-7000-8000-000000000001'

    await harness.resume?.(backend, id, input)
    expect(sandbox.backend.commands.at(-1)).toContain(`exec resume ${id} --skip-git-repo-check`)

    await expect(harness.resume?.(backend, 'x; rm -rf /', input)).rejects.toThrow(/UUID/)
  })
})
