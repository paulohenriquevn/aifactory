import { afterEach, describe, expect, it } from 'vitest'

import {
  CHATGPT_STORE,
  chatgptConnection,
  resetChatgptLogin,
  startChatgptLogin,
  type LoginDeps,
} from './chatgpt-login'

afterEach(() => resetChatgptLogin())

const stored = { type: 'oauth', provider: 'openai', access: 'a', refresh: 'r', expires: 1 } as never
const none: LoginDeps = { read: (() => undefined) as never }

describe('the ChatGPT connection', () => {
  it('writes where the framework reads the ChatGPT credential, and nowhere else', () => {
    expect(CHATGPT_STORE).toMatchObject({
      dirName: '.theokit',
      fileName: 'auth.json',
      homeEnvVar: 'THEOKIT_AUTH_HOME',
    })
  })

  it('says whether a credential is kept, without ever returning it', () => {
    expect(chatgptConnection(none)).toEqual({ connected: false, login: { status: 'idle' } })
    const connected = chatgptConnection({ read: (() => stored) as never })
    expect(connected).toEqual({ connected: true, login: { status: 'idle' } })
    expect(JSON.stringify(connected)).not.toContain('refresh')
  })
})

describe('starting the ChatGPT login', () => {
  const waiting = (deps: Partial<LoginDeps> = {}) => {
    let calls = 0
    let finish: () => void = () => {}
    const login = (async (
      _provider: unknown,
      _method: unknown,
      _store: unknown,
      hooks: { onPrompt: (p: unknown) => void },
    ) => {
      calls += 1
      hooks.onPrompt({
        userCode: 'ABCD-1234',
        verificationUri: 'https://auth.openai.com/codex/device',
      })
      await new Promise<void>((done) => (finish = done))
      return { path: '/x' }
    }) as never
    return { deps: { login, ...none, ...deps }, calls: () => calls, finish: () => finish() }
  }

  it('answers with the code to type and the address to open, without waiting for the owner', async () => {
    const { deps } = waiting()
    expect(await startChatgptLogin(deps)).toEqual({
      status: 'waiting',
      userCode: 'ABCD-1234',
      verificationUri: 'https://auth.openai.com/codex/device',
    })
    expect(chatgptConnection(deps).login.status).toBe('waiting')
  })

  it('does not make a second login when the button is pressed twice', async () => {
    const { deps, calls } = waiting()
    const first = await startChatgptLogin(deps)
    const second = await startChatgptLogin(deps)
    expect(second).toEqual(first)
    expect(calls()).toBe(1)
  })

  it('goes back to idle once the owner has approved and the credential is kept', async () => {
    const { deps, finish } = waiting()
    await startChatgptLogin(deps)
    finish()
    await new Promise((r) => setTimeout(r, 5))
    expect(chatgptConnection({ ...deps, read: (() => stored) as never })).toEqual({
      connected: true,
      login: { status: 'idle' },
    })
  })

  it('says why a login failed, and lets the owner try again', async () => {
    const failing = (async () => {
      throw new Error('the code expired')
    }) as never
    expect(await startChatgptLogin({ ...none, login: failing })).toEqual({
      status: 'error',
      message: 'the code expired',
    })
    expect(chatgptConnection(none).login).toEqual({ status: 'error', message: 'the code expired' })

    const { deps } = waiting()
    expect((await startChatgptLogin(deps)).status).toBe('waiting')
  })

  it('reads a failure that is not an Error as text', async () => {
    const failing = (async () => {
      throw 'plain text'
    }) as never
    expect(await startChatgptLogin({ ...none, login: failing })).toEqual({
      status: 'error',
      message: 'plain text',
    })
  })
})
