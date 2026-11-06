import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ClaudeLoginState } from '../../shared/panel'

import { saveStoredToken, TOKEN_PATTERN } from './claude-token'

/**
 * Changing the Claude Code account from the panel. The CLI's own command, `claude setup-token`, does the
 * login: it prints a link, the owner opens it signed in to the account they want, the page shows a code,
 * and the CLI takes the code and prints a token. The panel carries the link and the code between the
 * browser and the CLI, in a terminal of its own, and keeps the token. It never shows the token again.
 */

/** What the login needs of a terminal: what it prints, a way to type into it, and a way to end it. */
export type Terminal = {
  onData: (listener: (text: string) => void) => void
  onExit: (listener: () => void) => void
  write: (text: string) => void
  kill: () => void
}

export type LoginDeps = {
  start?: () => Terminal
  /** Asks Claude once with the token; the reason it did not work, or nothing when it did. */
  verify?: (token: string) => Promise<string | undefined>
  save?: (token: string) => void
  linkMs?: number
  codeMs?: number
  expiresMs?: number
  now?: () => number
  enterMs?: number
}

const LINK_MS = 30_000
const CODE_MS = 60_000
/** How long after the code its Enter is pressed. */
const ENTER_MS = 300
const EXPIRES_MS = 10 * 60_000

/** Where claude is: a service does not have the owner's own folders in its PATH. */
export function claudeBinary(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FACTORY_CLAUDE_BIN) return env.FACTORY_CLAUDE_BIN
  const own = join(homedir(), '.local', 'bin', 'claude')
  return existsSync(own) ? own : 'claude'
}

/**
 * The text a terminal prints, as a person reads it: without colours, cursor moves and hyperlink wrappers, and
 * without the carriage returns the terminal adds.
 */
export function plain(text: string): string {
  return (
    text
      // Every OSC (links, and the queries the CLI sends the terminal), then every CSI, private ones included.
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[()][0-9A-B]/g, '')
      .replace(/\r/g, '')
      // Control characters the TUI leaves around (shift-in, bell): never part of what it said.
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  )
}

const HOSTS = ['claude.com', 'claude.ai', 'anthropic.com']

/** The sign-in link in what was printed, only when it goes to Anthropic: nothing else is shown to the owner. */
export function loginUrl(printed: string): string | undefined {
  const found = plain(printed).match(/https:\/\/[^\s]+/g) ?? []
  for (const candidate of found) {
    try {
      const url = new URL(candidate)
      const host = url.hostname
      if (
        HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) &&
        url.pathname.includes('authorize')
      ) {
        return url.toString()
      }
    } catch {
      // Not a link at all: keep looking.
    }
  }
  return undefined
}

/** The token in what was printed, if the CLI got that far. */
export function printedToken(printed: string): string | undefined {
  return plain(printed).match(/sk-ant-oat01-[A-Za-z0-9_-]{60,}/)?.[0]
}

/**
 * The last thing the CLI said, for when the login did not end in a token: a line with no link and no token
 * in it, short enough to read.
 */
export function lastWords(printed: string): string {
  const lines = plain(printed)
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l !== '' &&
        !/https?:\/\//.test(l) &&
        !/sk-ant-/.test(l) &&
        !/^[*✶✻✽✢·]+$/.test(l) &&
        // The CLI echoes the pasted code masked, with its last characters showing: never what it said.
        !/^\*{8,}/.test(l),
    )
  return (lines.at(-1) ?? '').slice(0, 160)
}

/**
 * What the CLI printed, with every run that could be part of a secret (the code, the token) replaced by its
 * length, so the server log can say what the CLI did without carrying anything that signs in.
 */
export function shapeOf(printed: string): string {
  return plain(printed)
    .replace(/[A-Za-z0-9_]{16,}/g, (run) => `<${run.length}>`)
    .slice(-1500)
}

/** A code from the sign-in page: letters, digits and a few signs, with the "#" that ends it. */
export const CODE_PATTERN = /^[A-Za-z0-9_#.~-]{10,400}$/

function realTerminal(): Terminal {
  // A folder of its own, so signing in cannot touch the owner's own Claude Code account in ~/.claude.
  const home = mkdtempSync(join(tmpdir(), 'aifactory-claude-login-'))
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: home,
    TERM: 'xterm',
    // The link is shown in the panel: nothing should open a browser on this machine.
    BROWSER: 'true',
  }
  // `script` gives the CLI the terminal it insists on, wide enough that a long link is not cut in two. `timeout`
  // is a dead-man's switch: if the panel itself goes away, the terminal still ends, a little after the link
  // would have expired. It leads its own group of processes, so ending it ends the CLI under it too.
  const child = spawn(
    'timeout',
    [
      '-k',
      '5',
      String(Math.ceil((EXPIRES_MS + 60_000) / 1000)),
      'script',
      '-qefc',
      `stty cols 400 rows 50; exec ${claudeBinary()} setup-token`,
      '/dev/null',
    ],
    { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true },
  )
  const listeners: ((text: string) => void)[] = []
  const exits: (() => void)[] = []
  const clean = () => rmSync(home, { recursive: true, force: true })
  child.stdout.on('data', (d: Buffer) => listeners.forEach((l) => l(d.toString('utf8'))))
  child.stderr.on('data', (d: Buffer) => listeners.forEach((l) => l(d.toString('utf8'))))
  child.on('exit', () => {
    clean()
    exits.forEach((e) => e())
  })
  child.on('error', () => {
    clean()
    exits.forEach((e) => e())
  })
  return {
    onData: (l) => listeners.push(l),
    onExit: (l) => exits.push(l),
    write: (text) => child.stdin.write(text),
    kill: () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // It had ended already.
      }
    },
  }
}

/** Asks Claude one small question with the token, in the way the factory will: the subscription, no API key. */
export function realVerify(token: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CLAUDE_CODE_OAUTH_TOKEN: token,
    }
    const child = spawn(claudeBinary(), ['-p', 'Responda apenas: ok', '--output-format', 'json'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve('o Claude não respondeu a tempo')
    }, 120_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(verdictOf(out))
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve('não consegui rodar o claude nesta máquina')
    })
  })
}

/** What Claude answered, as the reason it did not work, or nothing when it worked. */
export function verdictOf(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output) as { is_error?: boolean; result?: string }
    return parsed.is_error ? String(parsed.result ?? 'a conta recusou').slice(0, 200) : undefined
  } catch {
    return (output.trim().slice(0, 200) || 'sem resposta do claude').replace(/\s+/g, ' ')
  }
}

type Attempt = { terminal: Terminal; printed: string; timers: ReturnType<typeof setTimeout>[] }

let state: ClaudeLoginState = { status: 'idle' }
let attempt: Attempt | undefined

function finish(next: ClaudeLoginState) {
  if (attempt) {
    attempt.timers.forEach(clearTimeout)
    attempt.terminal.kill()
    attempt = undefined
  }
  state = next
}

export const claudeLoginState = (): ClaudeLoginState => state

/** For tests: forget a login in progress. */
export function resetClaudeLogin() {
  finish({ status: 'idle' })
}

/**
 * Starts the login and answers with the link to open, without waiting for the owner. A login already waiting
 * is returned as it is, so pressing the button twice does not start two. It expires after ten minutes.
 */
export async function startClaudeLogin(deps: LoginDeps = {}): Promise<ClaudeLoginState> {
  if (state.status === 'waiting' || state.status === 'checking') return state
  const now = deps.now ?? Date.now
  const terminal = (deps.start ?? realTerminal)()
  const mine: Attempt = { terminal, printed: '', timers: [] }
  attempt = mine
  state = { status: 'idle' }

  return new Promise<ClaudeLoginState>((resolve) => {
    let shown = false
    terminal.onData((text) => {
      if (attempt !== mine) return
      mine.printed += text
      const url = shown ? undefined : loginUrl(mine.printed)
      if (url) {
        shown = true
        const expiresMs = deps.expiresMs ?? EXPIRES_MS
        state = { status: 'waiting', url, expiresAt: new Date(now() + expiresMs).toISOString() }
        mine.timers.push(
          setTimeout(() => {
            if (attempt === mine)
              finish({ status: 'error', message: 'O link expirou. Comece de novo.' })
          }, expiresMs),
        )
        resolve(state)
      }
    })
    terminal.onExit(() => {
      // Once the code is handed over, the CLI exits right after printing the token: that is a success, and
      // `submitClaudeCode` is the one that reads it.
      if (attempt !== mine || state.status === 'checking') return
      const said = lastWords(mine.printed)
      finish({
        status: 'error',
        message: said ? `O login terminou: ${said}` : 'O login terminou sem dar um token.',
      })
      resolve(state)
    })
    mine.timers.push(
      setTimeout(() => {
        if (attempt === mine && !shown) {
          finish({ status: 'error', message: 'O Claude não mostrou o link de login a tempo.' })
          resolve(state)
        }
      }, deps.linkMs ?? LINK_MS),
    )
  })
}

/**
 * Hands the code from the sign-in page to the CLI, waits for the token it prints, checks that the account
 * really answers, and only then keeps it. A token that does not work is thrown away, with the reason.
 */
export async function submitClaudeCode(
  code: string,
  deps: LoginDeps = {},
): Promise<ClaudeLoginState> {
  if (state.status !== 'waiting' || !attempt) {
    return { status: 'error', message: 'Não há um login esperando o código. Comece de novo.' }
  }
  const trimmed = code.trim()
  if (!CODE_PATTERN.test(trimmed)) {
    return {
      status: 'error',
      message: 'Isso não parece o código da página: cole o texto inteiro, com o #.',
    }
  }
  const mine = attempt
  // What came before is the sign-in screen; only what the CLI says after the code says how it went.
  const printedBefore = mine.printed.length
  state = { status: 'checking' }
  const verify = deps.verify ?? realVerify
  const save = deps.save ?? ((token: string) => saveStoredToken(token))

  const token = await new Promise<string | undefined>((resolve) => {
    const seen = () => printedToken(mine.printed)
    const wait = setTimeout(() => resolve(seen()), deps.codeMs ?? CODE_MS)
    mine.timers.push(wait)
    mine.terminal.onData(() => {
      const found = seen()
      if (found) resolve(found)
    })
    mine.terminal.onExit(() => resolve(seen()))
    // Enter goes on its own: the CLI takes a long code that arrives with it as a paste, the Enter included,
    // and never sends it.
    mine.terminal.write(trimmed)
    mine.timers.push(setTimeout(() => mine.terminal.write('\r'), deps.enterMs ?? ENTER_MS))
  })
  if (attempt !== mine) return state

  if (!token || !TOKEN_PATTERN.test(token)) {
    console.error(
      JSON.stringify({
        event: 'claude_login_no_token',
        printedAfterCode: shapeOf(mine.printed.slice(printedBefore)),
      }),
    )
    const said = lastWords(mine.printed.slice(printedBefore))
    finish({
      status: 'error',
      message: said
        ? `O código não valeu: ${said}`
        : 'O código não valeu, ou expirou. Abra o link de novo e cole o código novo.',
    })
    return state
  }

  const problem = await verify(token)
  if (attempt !== mine) return state
  if (problem) {
    finish({ status: 'error', message: `Essa conta não pode ser usada agora: ${problem}` })
    return state
  }
  save(token)
  finish({ status: 'done' })
  return state
}

/** Ends a login the owner does not want any more. */
export function cancelClaudeLogin(): ClaudeLoginState {
  finish({ status: 'idle' })
  return state
}
