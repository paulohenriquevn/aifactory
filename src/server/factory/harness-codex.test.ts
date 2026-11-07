import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { retryableFailure } from '../../shared/panel'
// @ts-expect-error the feeder is a script, not a typed module
import { isInfraFailure } from '../../../scripts/backlog.mjs'

import { FakeSandbox } from './fake-sandbox'
import {
  CODEX_VERSION,
  codexCredentialFromEnv,
  codexHarness,
  cleaned,
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

describe('a failure with no event that says why', () => {
  const warning =
    '(node:168) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.\n(Use `node --trace-warnings ...` to show where the warning was created)\n'

  it('does not report what Node says about itself as the reason, and gives the exit code instead', () => {
    const result = parseCodexResult(1, '', warning)
    expect(result.ok).toBe(false)
    expect(result.summary).toBe('codex failed: exit 1')
    expect(result.summary).not.toContain('UNDICI')
  })

  it('keeps what the agent did print to stderr, without the noise around it', () => {
    const result = parseCodexResult(2, '', `${warning}error: unexpected argument\n`)
    expect(result.summary).toBe('codex failed: error: unexpected argument (exit 2)')
  })

  it('says a kill with 137 is most likely memory, so it is treated as a failure of the environment', () => {
    const result = parseCodexResult(137, '', warning)
    expect(result.summary).toBe('codex failed: killed (most likely out of memory), exit 137')
    expect(retryableFailure({ error: result.summary })).toBe('environment')
    expect(isInfraFailure(result.summary)).toBe(true)
  })

  it('cleans only lines that are Node noise', () => {
    expect(cleaned('(node:1) Warning: x\nreal error\n(Use `node --trace-warnings`)\n')).toBe(
      'real error',
    )
    expect(cleaned('')).toBe('')
    expect(cleaned('a (node:1) in the middle\n')).toBe('a (node:1) in the middle')
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
      /connect Codex from the Setup page/,
    )
    expect(() => codexCredentialFromEnv({ FACTORY_CODEX_AUTH: 'api-key' }, has(true))).toThrow(
      /OPENAI_API_KEY is not set/,
    )
    expect(() => codexCredentialFromEnv({ FACTORY_CODEX_AUTH: 'x' }, has(true))).toThrow(
      /api-key or subscription/,
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

describe('codexHarness model and effort', () => {
  const done = JSON.stringify({ type: 'turn.completed' })
  const command = async (options: { model?: string; effort?: string }, resume?: string) => {
    const harness = codexHarness({ kind: 'api-key', secret: 'k' }, {}, options)
    const sandbox = new FakeSandbox(() => ({ stdout: done }))
    const { backend } = await sandbox.create({ timeoutMs: 1, egress: [{ domain: 'github.com' }] })
    const input = { prompt: 'P', cwd: '/work/repo', timeoutMs: 5 }
    if (resume) await harness.resume!(backend, resume, input)
    else await harness.run(backend, input)
    return sandbox.backend.commands.at(-1)!
  }

  it('tells the agent which model and how much effort, when it was chosen', async () => {
    const run = await command({ model: 'gpt-6.1-sol', effort: 'high' })
    expect(run).toContain(
      'exec -m gpt-6.1-sol -c model_reasoning_effort=high --skip-git-repo-check',
    )
  })

  it('tells it the same when it picks a session back up', async () => {
    const run = await command(
      { model: 'gpt-6-luna', effort: 'low' },
      '11111111-1111-4111-8111-111111111111',
    )
    expect(run).toContain(
      'exec resume 11111111-1111-4111-8111-111111111111 -m gpt-6-luna -c model_reasoning_effort=low --skip-git-repo-check',
    )
  })

  it('says nothing about either when none was chosen', async () => {
    const run = await command({})
    expect(run).not.toContain(' -m ')
    expect(run).not.toContain('model_reasoning_effort')
    expect(await command({ model: 'gpt-6-luna' })).not.toContain('model_reasoning_effort')
  })

  it('refuses a name a shell would read', () => {
    expect(() => codexHarness({ kind: 'api-key', secret: 'k' }, {}, { model: 'a b' })).toThrow(
      /not a plain name/,
    )
    expect(() =>
      codexHarness({ kind: 'api-key', secret: 'k' }, {}, { effort: 'high; id' }),
    ).toThrow(/not a plain name/)
  })
})

describe('a watched Codex run', () => {
  it('hands each completed step over while it works, and reads the result as before', async () => {
    const stdout = [
      line({ type: 'thread.started', thread_id: '019a0000-0000-7000-8000-000000000001' }),
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'Added it.' } }),
      line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }),
    ].join('\n')
    const sandbox = new FakeSandbox(() => ({ stdout }), { streaming: true })
    const { backend } = await sandbox.create({ timeoutMs: 1, egress: [] })
    const seen: unknown[] = []

    const result = await codexHarness({ kind: 'api-key', secret: 'sk-real' }).run(backend, {
      prompt: 'P',
      cwd: '/work',
      timeoutMs: 5,
      onEvent: (event) => seen.push(event),
    })

    expect(result).toMatchObject({ ok: true, summary: 'Added it.' })
    expect(seen).toEqual([
      { kind: 'message', content: 'Added it.' },
      { kind: 'cost', content: '10 tokens in, 5 out' },
    ])
  })
})
