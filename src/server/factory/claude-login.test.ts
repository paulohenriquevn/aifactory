import { afterEach, describe, expect, it } from 'vitest'

import {
  cancelClaudeLogin,
  claudeLoginState,
  lastWords,
  loginUrl,
  plain,
  printedToken,
  resetClaudeLogin,
  startClaudeLogin,
  submitClaudeCode,
  verdictOf,
  type LoginDeps,
  type Terminal,
  shapeOf,
} from './claude-login'

afterEach(() => resetClaudeLogin())

const TOKEN = `sk-ant-oat01-${'x'.repeat(90)}`
const LINK = 'https://claude.ai/oauth/authorize?code=true&client_id=abc'
const CODE = 'abcdefghij1234567890#state-xyz'

/** A terminal that prints what the test says, and remembers what was typed into it. */
function fakeTerminal() {
  const data: ((text: string) => void)[] = []
  const exits: (() => void)[] = []
  const typed: string[] = []
  let killed = 0
  const terminal: Terminal = {
    onData: (l) => data.push(l),
    onExit: (l) => exits.push(l),
    write: (text) => void typed.push(text),
    kill: () => void (killed += 1),
  }
  return {
    terminal,
    print: (text: string) => data.forEach((l) => l(text)),
    exit: () => exits.forEach((e) => e()),
    typed,
    killed: () => killed,
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

describe('reading what the CLI prints', () => {
  it('drops colours, hyperlink wrappers and carriage returns', () => {
    const printed = '\x1b[1mBold\x1b[0m \x1b]8;;https://x\x07link\x1b]8;;\x07\r\n'
    expect(plain(printed)).toBe('Bold link\n')
  })

  it('finds the sign-in link to Anthropic', () => {
    expect(loginUrl(`Open this:\n\x1b[4m${LINK}\x1b[0m\n`)).toBe(LINK)
  })

  it('ignores a link to any other host', () => {
    expect(loginUrl('https://evil.example/oauth/authorize?x=1')).toBeUndefined()
    expect(loginUrl('https://claude.ai.evil.example/oauth/authorize')).toBeUndefined()
  })

  it('ignores an Anthropic link that is not the sign-in page', () => {
    expect(loginUrl('https://docs.anthropic.com/en/docs')).toBeUndefined()
  })

  it('finds the token once the CLI prints it', () => {
    expect(printedToken(`Your token:\n${TOKEN}\n`)).toBe(TOKEN)
    expect(printedToken('Paste code here >')).toBeUndefined()
  })

  it('keeps the last line said, never one with a link or a token', () => {
    expect(lastWords(`Error: invalid code\n${LINK}\n${TOKEN}\n✻\n`)).toBe('Error: invalid code')
  })

  it('takes a JSON answer that is not an error as success', () => {
    expect(verdictOf('{"is_error":false,"result":"ok"}')).toBeUndefined()
  })

  it('gives the reason from a JSON error answer', () => {
    expect(verdictOf('{"is_error":true,"result":"Credit balance is too low"}')).toBe(
      'Credit balance is too low',
    )
  })

  it('gives the raw output, on one line, when the answer is not JSON', () => {
    expect(verdictOf('Invalid API key\n  please log in')).toBe('Invalid API key please log in')
    expect(verdictOf('')).toBe('sem resposta do claude')
  })
})

describe('starting a change of account', () => {
  it('answers with the sign-in link as soon as the CLI prints it', async () => {
    const t = fakeTerminal()
    const started = startClaudeLogin({ start: () => t.terminal, now: () => 0, expiresMs: 60_000 })
    t.print(`Browser didn't open? Use the url below\n${LINK}\n`)
    expect(await started).toEqual({
      status: 'waiting',
      url: LINK,
      expiresAt: new Date(60_000).toISOString(),
    })
  })

  it('returns the login already waiting instead of starting a second one', async () => {
    const t = fakeTerminal()
    let terminals = 0
    const deps: LoginDeps = { start: () => (terminals++, t.terminal) }
    const first = startClaudeLogin(deps)
    t.print(LINK)
    await first
    expect(await startClaudeLogin(deps)).toMatchObject({ status: 'waiting', url: LINK })
    expect(terminals).toBe(1)
  })

  it('fails and ends the terminal when no link shows up in time', async () => {
    const t = fakeTerminal()
    const state = await startClaudeLogin({ start: () => t.terminal, linkMs: 5 })
    expect(state).toEqual({
      status: 'error',
      message: 'O Claude não mostrou o link de login a tempo.',
    })
    expect(t.killed()).toBe(1)
  })

  it('fails with what the CLI said when it ends before giving a link', async () => {
    const t = fakeTerminal()
    const started = startClaudeLogin({ start: () => t.terminal })
    t.print('command not found: setup-token\n')
    t.exit()
    expect(await started).toEqual({
      status: 'error',
      message: 'O login terminou: command not found: setup-token',
    })
  })

  it('expires a link nobody used', async () => {
    const t = fakeTerminal()
    const started = startClaudeLogin({ start: () => t.terminal, expiresMs: 5 })
    t.print(LINK)
    await started
    await sleep(20)
    expect(claudeLoginState()).toEqual({
      status: 'error',
      message: 'O link expirou. Comece de novo.',
    })
    expect(t.killed()).toBe(1)
  })

  it('is given up on request, ending the terminal', async () => {
    const t = fakeTerminal()
    const started = startClaudeLogin({ start: () => t.terminal })
    t.print(LINK)
    await started
    expect(cancelClaudeLogin()).toEqual({ status: 'idle' })
    expect(t.killed()).toBe(1)
  })
})

describe('handing the code to the CLI', () => {
  async function waitingLogin() {
    const t = fakeTerminal()
    const started = startClaudeLogin({ start: () => t.terminal })
    t.print(`${LINK}\nPaste code here if prompted > `)
    await started
    return t
  }

  it('refuses a code when no login is waiting for one', async () => {
    expect(await submitClaudeCode(CODE)).toEqual({
      status: 'error',
      message: 'Não há um login esperando o código. Comece de novo.',
    })
  })

  it('refuses what does not look like the code, and keeps waiting', async () => {
    const t = await waitingLogin()
    const state = await submitClaudeCode('not a code; rm -rf /')
    expect(state).toMatchObject({ status: 'error' })
    expect(t.typed).toEqual([])
    expect(claudeLoginState()).toMatchObject({ status: 'waiting' })
  })

  it('keeps the token only after the account answered a test call', async () => {
    const t = await waitingLogin()
    const saved: string[] = []
    const checked: string[] = []
    const submitted = submitClaudeCode(`  ${CODE}\n`, {
      verify: async (token) => void checked.push(token),
      save: (token) => void saved.push(token),
      enterMs: 5,
    })
    await sleep(20)
    t.print(`\nLong-lived authentication token created:\n${TOKEN}\n`)
    expect(await submitted).toEqual({ status: 'done' })
    expect(checked).toEqual([TOKEN])
    expect(saved).toEqual([TOKEN])
    expect(t.killed()).toBe(1)
  })

  it('presses Enter apart from the code, because a long code typed with it is taken as a paste and never sent', async () => {
    const t = await waitingLogin()
    const long = `${'a'.repeat(48)}#${'b'.repeat(43)}`
    const submitted = submitClaudeCode(long, {
      verify: async () => undefined,
      save: () => {},
      enterMs: 5,
    })
    expect(t.typed).toEqual([long])
    await sleep(20)
    expect(t.typed).toEqual([long, '\r'])
    t.print(TOKEN)
    expect(await submitted).toEqual({ status: 'done' })
  })

  it('never returns the token in the state the panel reads', async () => {
    const t = await waitingLogin()
    const submitted = submitClaudeCode(CODE, { verify: async () => undefined, save: () => {} })
    t.print(TOKEN)
    expect(JSON.stringify(await submitted)).not.toContain('sk-ant-')
    expect(JSON.stringify(claudeLoginState())).not.toContain('sk-ant-')
  })

  it('throws away a token whose account does not answer, with the reason', async () => {
    const t = await waitingLogin()
    const saved: string[] = []
    const submitted = submitClaudeCode(CODE, {
      verify: async () => 'limite de uso atingido',
      save: (token) => void saved.push(token),
    })
    t.print(TOKEN)
    expect(await submitted).toEqual({
      status: 'error',
      message: 'Essa conta não pode ser usada agora: limite de uso atingido',
    })
    expect(saved).toEqual([])
  })

  it('fails with what the CLI said when the code gives no token', async () => {
    const t = await waitingLogin()
    const saved: string[] = []
    const submitted = submitClaudeCode(CODE, { save: (token) => void saved.push(token) })
    t.print('\nOAuth error: Invalid code\n')
    t.exit()
    expect(await submitted).toEqual({
      status: 'error',
      message: 'O código não valeu: OAuth error: Invalid code',
    })
    expect(saved).toEqual([])
  })

  it('fails when the CLI says nothing after the code, in time', async () => {
    await waitingLogin()
    const state = await submitClaudeCode(CODE, { codeMs: 5 })
    expect(state).toMatchObject({ status: 'error', message: expect.stringMatching(/não valeu/) })
  })
})

describe('what the terminal printed around the code', () => {
  it('drops the terminal queries the CLI sends, so none of them reaches the owner', () => {
    expect(plain('\x1b[>0q\x1b]7501;?\x07\x1b]11;?\x1b\\ready')).toBe('ready')
  })

  it('never gives the masked echo of the pasted code as what the CLI said', () => {
    const printed =
      'Paste code here if prompted >\n\x1b[>0q****************************567890\n\x0f**********\n'
    expect(lastWords(printed)).toBe('Paste code here if prompted >')
  })

  it('shows the shape of the output with every long secret-like run replaced by its length', () => {
    const token = `sk-ant-oat01-${'a'.repeat(95)}`
    const shape = shapeOf(
      `\x1b[32mLong-lived token:\x1b[0m\n${token.slice(0, 50)}\n${token.slice(50)}\n`,
    )
    expect(shape).not.toContain('aaaaaaaaaaaaaaaa')
    expect(shape).toBe('Long-lived token:\nsk-ant-oat01-<37>\n<58>\n')
  })
})
