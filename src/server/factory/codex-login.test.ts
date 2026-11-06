import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { OAuthTokens } from '@theokit/agents/auth'
import { afterEach, describe, expect, it } from 'vitest'

import {
  cancelCodexLogin,
  checkAuth,
  codexLoginState,
  realVerify,
  resetCodexLogin,
  startCodexLogin,
  verdictOf,
  type CodexLoginDeps,
} from './codex-login'

afterEach(() => resetCodexLogin())

const TOKENS: OAuthTokens = {
  access: 'access-jwt',
  refresh: 'refresh-secret',
  expires: 1,
  accountId: 'acc-1',
  idToken: 'id-jwt',
}
const PROMPT = { userCode: 'ABCD-1234', verificationUri: 'https://auth.openai.com/codex/device' }

/** A device login the test finishes when it wants, as the owner approving on the other device. */
function pendingLogin() {
  let approve: (tokens: OAuthTokens) => void = () => {}
  let refuse: (error: Error) => void = () => {}
  let calls = 0
  const authorize: CodexLoginDeps['authorize'] = (hooks) => {
    calls += 1
    hooks.onPrompt(PROMPT)
    return new Promise<OAuthTokens>((ok, fail) => {
      approve = ok
      refuse = fail
    })
  }
  return {
    authorize,
    approve: (tokens = TOKENS) => approve(tokens),
    refuse: (error: Error) => refuse(error),
    calls: () => calls,
  }
}

const settled = async () => {
  for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0))
}

describe('starting a change of Codex account', () => {
  it('answers with the code to type and the address, without waiting for the owner', async () => {
    const login = pendingLogin()
    expect(await startCodexLogin({ authorize: login.authorize })).toEqual({
      status: 'waiting',
      ...PROMPT,
    })
  })

  it('returns the login already waiting instead of starting a second one', async () => {
    const login = pendingLogin()
    await startCodexLogin({ authorize: login.authorize })
    expect(await startCodexLogin({ authorize: login.authorize })).toMatchObject({
      status: 'waiting',
    })
    expect(login.calls()).toBe(1)
  })

  it('says why when the device login cannot even start', async () => {
    const authorize: CodexLoginDeps['authorize'] = () =>
      Promise.reject(new Error('device usercode endpoint returned HTTP 503'))
    expect(await startCodexLogin({ authorize })).toEqual({
      status: 'error',
      message: 'O login do Codex falhou: device usercode endpoint returned HTTP 503',
    })
  })
})

describe('once the owner approves', () => {
  it('keeps the login only after Codex answered with it', async () => {
    const login = pendingLogin()
    const checked: OAuthTokens[] = []
    const saved: OAuthTokens[] = []
    await startCodexLogin({
      authorize: login.authorize,
      verify: async (tokens) => void checked.push(tokens),
      save: async (tokens) => void saved.push(tokens),
    })
    login.approve()
    await settled()
    expect(codexLoginState()).toEqual({ status: 'done' })
    expect(checked).toEqual([TOKENS])
    expect(saved).toEqual([TOKENS])
  })

  it('throws away a login whose account cannot be used now, with the reason', async () => {
    const login = pendingLogin()
    const saved: OAuthTokens[] = []
    await startCodexLogin({
      authorize: login.authorize,
      verify: async () => 'a conta está no limite de uso até Nov 8th, 2026 5:00 PM',
      save: async (tokens) => void saved.push(tokens),
    })
    login.approve()
    await settled()
    expect(codexLoginState()).toEqual({
      status: 'error',
      message:
        'Essa conta não pode ser usada agora: a conta está no limite de uso até Nov 8th, 2026 5:00 PM',
    })
    expect(saved).toEqual([])
  })

  it('says so when the login could not be kept', async () => {
    const login = pendingLogin()
    await startCodexLogin({
      authorize: login.authorize,
      verify: async () => undefined,
      save: async () => {
        throw new Error('EACCES: permission denied')
      },
    })
    login.approve()
    await settled()
    expect(codexLoginState()).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/EACCES/),
    })
  })

  it('reports a device code that expired before the owner typed it', async () => {
    const login = pendingLogin()
    await startCodexLogin({ authorize: login.authorize })
    login.refuse(new Error('device code expired'))
    await settled()
    expect(codexLoginState()).toEqual({
      status: 'error',
      message: 'O login do Codex falhou: device code expired',
    })
  })
})

describe('giving the login up', () => {
  it('goes back to idle and ignores an approval that arrives later', async () => {
    const login = pendingLogin()
    const saved: OAuthTokens[] = []
    await startCodexLogin({
      authorize: login.authorize,
      verify: async () => undefined,
      save: async (tokens) => void saved.push(tokens),
    })
    expect(cancelCodexLogin()).toEqual({ status: 'idle' })
    login.approve()
    await settled()
    expect(codexLoginState()).toEqual({ status: 'idle' })
    expect(saved).toEqual([])
  })
})

describe('the check run with a new login', () => {
  it('carries the real access and ID tokens but never the refresh token', () => {
    const auth = JSON.parse(checkAuth(TOKENS, () => 0))
    expect(auth.tokens).toEqual({
      id_token: 'id-jwt',
      access_token: 'access-jwt',
      refresh_token: 'placeholder-not-a-secret',
      account_id: 'acc-1',
    })
    expect(JSON.stringify(auth)).not.toContain('refresh-secret')
  })

  it('takes a completed turn as a working account', () => {
    const out = [
      JSON.stringify({ type: 'thread.started', thread_id: 't-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ].join('\n')
    expect(verdictOf(0, out, '')).toBeUndefined()
  })

  it('gives a quota stop as the reason, with when it ends', () => {
    const message =
      'You’ve hit your usage limit. Upgrade to Pro, or try again at Nov 8th, 2026 5:00 PM.'
    const out = [
      JSON.stringify({ type: 'error', message }),
      JSON.stringify({ type: 'turn.failed', error: { message } }),
    ].join('\n')
    expect(verdictOf(1, out, '')).toBe('a conta está no limite de uso até Nov 8th, 2026 5:00 PM')
  })
})

describe('asking codex with a new login on this machine', () => {
  const bins: string[] = []
  afterEach(() => {
    delete process.env.FACTORY_CODEX_BIN
    for (const dir of bins.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** A codex that prints `events`, and writes where it was run from and the auth it was given. */
  function fakeCodex(events: object[], exitCode = 0) {
    const dir = mkdtempSync(join(tmpdir(), 'fake-codex-'))
    bins.push(dir)
    const bin = join(dir, 'codex')
    const lines = events.map((e) => `echo '${JSON.stringify(e)}'`).join('\n')
    writeFileSync(
      bin,
      `#!/bin/sh\ncat "$CODEX_HOME/auth.json" > ${dir}/seen-auth\necho "$CODEX_HOME" > ${dir}/seen-home\n${lines}\nexit ${exitCode}\n`,
      { mode: 0o755 },
    )
    process.env.FACTORY_CODEX_BIN = bin
    return dir
  }

  it('accepts an account that answers, with the placeholder refresh token, and cleans up after itself', async () => {
    const dir = fakeCodex([
      { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
      { type: 'turn.completed', usage: {} },
    ])

    expect(await realVerify(TOKENS)).toBeUndefined()

    const seen = readFileSync(join(dir, 'seen-auth'), 'utf8')
    expect(seen).toContain('access-jwt')
    expect(seen).not.toContain('refresh-secret')
    expect(existsSync(readFileSync(join(dir, 'seen-home'), 'utf8').trim())).toBe(false)
  })

  it('refuses an account at its usage limit, with when it ends', async () => {
    const message = 'You’ve hit your usage limit. Try again at Nov 8th, 2026 5:00 PM.'
    fakeCodex(
      [
        { type: 'error', message },
        { type: 'turn.failed', error: { message } },
      ],
      1,
    )
    expect(await realVerify(TOKENS)).toBe('a conta está no limite de uso até Nov 8th, 2026 5:00 PM')
  })

  it('says so when codex cannot run here', async () => {
    process.env.FACTORY_CODEX_BIN = join(tmpdir(), 'no-such-codex-binary')
    expect(await realVerify(TOKENS)).toBe('não consegui rodar o codex nesta máquina')
  })
})
