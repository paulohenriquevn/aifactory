import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { CODEX_PROVIDER, type OAuthTokens } from '@theokit/agents/auth'

import type { CodexLoginState } from '../../shared/panel'

import { saveCodexLogin } from './codex-auth'
import { parseCodexResult } from './harness-codex'

/**
 * Changing the factory's Codex account from the panel. It is TheoKit's OpenAI device login: the owner opens
 * an address signed in to the account they want and types a short code, and the framework polls until they
 * approve. Before the login is kept, Codex is asked one small question with it, so an account that is out
 * of quota is refused at the door instead of failing the next run.
 */

export type CodexLoginDeps = {
  authorize?: (hooks: {
    onPrompt: (p: { userCode: string; verificationUri: string }) => void
  }) => Promise<OAuthTokens>
  /** Asks Codex once with the login; the reason it did not work, or nothing when it did. */
  verify?: (tokens: OAuthTokens) => Promise<string | undefined>
  save?: (tokens: OAuthTokens) => Promise<void>
}

let state: CodexLoginState = { status: 'idle' }
/** Which login the state belongs to. A login given up keeps polling in the framework, so its end is ignored. */
let attempt = 0

export const codexLoginState = (): CodexLoginState => state

/** For tests: forget a login in progress. */
export function resetCodexLogin() {
  attempt += 1
  state = { status: 'idle' }
}

function realAuthorize(hooks: {
  onPrompt: (p: { userCode: string; verificationUri: string }) => void
}): Promise<OAuthTokens> {
  const method = CODEX_PROVIDER.methods.find((m) => m.type === 'oauth')
  if (!method || method.type !== 'oauth') {
    return Promise.reject(new Error('TheoKit has no ChatGPT device login method'))
  }
  return method.authorize(
    { fetch, sleep: (ms) => new Promise((done) => setTimeout(done, ms)), now: Date.now },
    hooks,
  )
}

/** Where codex is: a service does not have the owner's own folders in its PATH. */
function codexBinary(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FACTORY_CODEX_BIN) return env.FACTORY_CODEX_BIN
  const own = join(homedir(), '.local', 'bin', 'codex')
  return existsSync(own) ? own : 'codex'
}

/**
 * The `auth.json` the check runs with: the real access and ID tokens, and a refresh token that is not one,
 * so the CLI cannot spend the rotating refresh token of the login being checked.
 */
export function checkAuth(tokens: OAuthTokens, now: () => number = Date.now): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.access,
      refresh_token: 'placeholder-not-a-secret',
      ...(tokens.accountId ? { account_id: tokens.accountId } : {}),
    },
    last_refresh: new Date(now()).toISOString(),
  })
}

/** Asks Codex one small question with the login, on this machine, in a folder of its own. */
export function realVerify(tokens: OAuthTokens): Promise<string | undefined> {
  const home = mkdtempSync(join(tmpdir(), 'aifactory-codex-check-'))
  writeFileSync(join(home, 'auth.json'), checkAuth(tokens), { mode: 0o600 })
  return new Promise((resolve) => {
    const finish = (verdict: string | undefined) => {
      rmSync(home, { recursive: true, force: true })
      resolve(verdict)
    }
    const child = spawn(
      codexBinary(),
      ['exec', '--skip-git-repo-check', '--json', 'Responda apenas: ok'],
      {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish('o Codex não respondeu a tempo')
    }, 120_000)
    // 'close', not 'exit': it comes after stdout was read to the end.
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(verdictOf(code ?? 1, out, err))
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish('não consegui rodar o codex nesta máquina')
    })
  })
}

/** What Codex answered, as the reason the login cannot be used, or nothing when it worked. */
export function verdictOf(exitCode: number, stdout: string, stderr: string): string | undefined {
  const result = parseCodexResult(exitCode, stdout, stderr)
  if (result.ok) return undefined
  if (result.quota) {
    return `a conta está no limite de uso${result.quota.resetsAt ? ` até ${result.quota.resetsAt}` : ''}`
  }
  return result.summary.slice(0, 200) || 'o Codex recusou a conta'
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Starts the login and answers with the code and the address, without waiting for the owner. A login
 * already going on is returned as it is, so pressing the button twice does not start two.
 */
export function startCodexLogin(deps: CodexLoginDeps = {}): Promise<CodexLoginState> {
  if (state.status === 'waiting' || state.status === 'checking') return Promise.resolve(state)
  const mine = ++attempt
  const current = () => attempt === mine
  const authorize = deps.authorize ?? realAuthorize
  const verify = deps.verify ?? realVerify
  const save = deps.save ?? ((tokens: OAuthTokens) => saveCodexLogin(tokens))
  state = { status: 'idle' }

  return new Promise<CodexLoginState>((resolve) => {
    authorize({
      onPrompt: ({ userCode, verificationUri }) => {
        if (!current()) return
        state = { status: 'waiting', userCode, verificationUri }
        resolve(state)
      },
    })
      .then(async (tokens) => {
        if (!current()) return
        state = { status: 'checking' }
        const problem = await verify(tokens)
        if (!current()) return
        if (problem) {
          state = { status: 'error', message: `Essa conta não pode ser usada agora: ${problem}` }
          return
        }
        await save(tokens)
        if (current()) state = { status: 'done' }
      })
      .catch((error: unknown) => {
        if (!current()) return
        state = { status: 'error', message: `O login do Codex falhou: ${message(error)}` }
      })
      .finally(() => resolve(state))
  })
}

/** Gives the login up. The framework may still be polling; whatever it brings back is ignored. */
export function cancelCodexLogin(): CodexLoginState {
  resetCodexLogin()
  return state
}
