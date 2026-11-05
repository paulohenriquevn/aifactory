import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { SandboxBackend } from '@theokit/agents/sandbox'

import type { FetchLike } from '../github/app'

import {
  assertSessionId,
  detectQuota,
  PROMPT_FILE,
  SUMMARY_MAX,
  type CodingHarness,
  type HarnessInput,
  type HarnessResult,
} from './harness'
import type { EgressRule } from './sandbox'

/** Pinned so a new release cannot change what a run does. */
export const CODEX_VERSION = '0.166.0'

const CODEX = '$HOME/.local/bin/codex'
const AUTH_FILE = '$HOME/.codex/auth.json'
const REFRESH_URL = 'https://auth.openai.com/oauth/token'
/** The access token is replaced when it has less than this left. It lasts ten days. */
const REFRESH_MARGIN_S = 2 * 24 * 3600

/**
 * How Codex pays. An API key signs calls to the OpenAI API. A subscription is the ChatGPT login
 * `codex login --device-auth` wrote in `home`: it must be a login of the factory's own, because the
 * refresh token rotates and two users of one login invalidate each other.
 */
export type CodexCredential =
  { kind: 'api-key'; secret: string } | { kind: 'subscription'; home: string }

export const defaultCodexHome = () => join(homedir(), '.codex-factory-1')

/** Picks the credential from the environment, the API key first. */
export function codexCredentialFromEnv(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
): CodexCredential {
  const apiKey = env.OPENAI_API_KEY
  const home = env.FACTORY_CODEX_HOME || defaultCodexHome()
  const wanted = env.FACTORY_CODEX_AUTH
  if (wanted !== undefined && wanted !== 'api-key' && wanted !== 'subscription') {
    throw new Error(`FACTORY_CODEX_AUTH must be api-key or subscription, got ${wanted}`)
  }
  const kind =
    wanted ?? (apiKey ? 'api-key' : exists(join(home, 'auth.json')) ? 'subscription' : undefined)
  if (kind === 'api-key') {
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set')
    return { kind, secret: apiKey }
  }
  if (kind === 'subscription') {
    if (!exists(join(home, 'auth.json'))) {
      throw new Error(
        `no Codex login in ${home} (run CODEX_HOME=${home} codex login --device-auth)`,
      )
    }
    return { kind, home }
  }
  throw new Error(
    `OPENAI_API_KEY is not set and there is no Codex login in ${home} (run CODEX_HOME=${home} codex login --device-auth)`,
  )
}

type AuthFile = {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  tokens: {
    id_token: string
    access_token: string
    refresh_token: string
    account_id?: string
  }
  last_refresh?: string
}

export type CodexLogin = { accessToken: string; idToken: string; accountId?: string }

const claimsOf = (jwt: string): { exp?: number; client_id?: string } => {
  const payload = jwt.split('.')[1] ?? ''
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
}

/**
 * Reads the factory's Codex login and renews the access token when it is close to expiring. The
 * refresh token is used here, on the host, and never reaches a sandbox.
 */
export async function loadCodexLogin(
  home: string,
  io: { fetch?: FetchLike; now?: () => number } = {},
): Promise<CodexLogin> {
  const path = join(home, 'auth.json')
  const auth = JSON.parse(readFileSync(path, 'utf8')) as AuthFile
  const now = io.now ?? Date.now
  const exp = claimsOf(auth.tokens.access_token).exp ?? 0
  if (exp - now() / 1000 < REFRESH_MARGIN_S) {
    const clientId = claimsOf(auth.tokens.access_token).client_id
    const response = await (io.fetch ?? ((url, init) => fetch(url, init)))(REFRESH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: auth.tokens.refresh_token,
        scope: 'openid profile email',
      }),
    })
    if (!response.ok) {
      throw new Error(
        `the Codex login in ${home} could not be renewed (HTTP ${response.status}); run CODEX_HOME=${home} codex login --device-auth`,
      )
    }
    const fresh = (await response.json()) as {
      access_token: string
      refresh_token?: string
      id_token?: string
    }
    auth.tokens = {
      ...auth.tokens,
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token ?? auth.tokens.refresh_token,
      id_token: fresh.id_token ?? auth.tokens.id_token,
    }
    auth.last_refresh = new Date(now()).toISOString()
    writeFileSync(path, JSON.stringify(auth, null, 2))
    chmodSync(path, 0o600)
  }
  return {
    accessToken: auth.tokens.access_token,
    idToken: auth.tokens.id_token,
    accountId: auth.tokens.account_id,
  }
}

/** A token with the original claims and a signature that verifies against nothing. */
const unsigned = (jwt: string) => `${jwt.split('.').slice(0, 2).join('.')}.c2lnbmF0dXJlLXJlbW92ZWQ`

/**
 * The `auth.json` a sandbox gets: claims Codex reads (plan, account), tokens that cannot be used.
 * The firewall adds the real bearer token on the way out.
 */
export function placeholderAuth(login: CodexLogin, now: () => number = Date.now): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: unsigned(login.idToken),
      access_token: unsigned(login.accessToken),
      refresh_token: 'placeholder-not-a-secret',
      ...(login.accountId ? { account_id: login.accountId } : {}),
    },
    last_refresh: new Date(now()).toISOString(),
  })
}

/**
 * Codex in headless mode, `codex exec --json`. Codex's own sandbox is off because the microVM is
 * the boundary (and its sandbox needs kernel features the VM may not give it).
 */
export function codexHarness(
  credential: CodexCredential,
  io: { fetch?: FetchLike; now?: () => number } = {},
): CodingHarness {
  let login: CodexLogin | undefined

  const subscriptionLogin = async () =>
    credential.kind === 'subscription'
      ? (login ??= await loadCodexLogin(credential.home, io))
      : undefined

  async function invoke(
    backend: SandboxBackend,
    { prompt, cwd, timeoutMs }: HarnessInput,
    resume: string,
  ) {
    await backend.uploadFile(PROMPT_FILE, prompt)
    const env = credential.kind === 'api-key' ? 'OPENAI_API_KEY=placeholder-not-a-secret ' : ''
    // `cwd` is a path the factory built, and `resume` was checked to be a UUID.
    const result = await backend.execute(
      `cd ${cwd} && ${env}${CODEX} exec${resume ? ` resume ${resume}` : ''} --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --json - < ${PROMPT_FILE}`,
      { timeoutMs },
    )
    return parseCodexResult(result.exitCode, result.stdout, result.stderr)
  }

  return {
    name: 'codex',

    async egress(): Promise<EgressRule[]> {
      if (credential.kind === 'api-key') {
        return [
          {
            domain: 'api.openai.com',
            headers: { authorization: `Bearer ${credential.secret}` },
          },
        ]
      }
      const { accessToken } = (await subscriptionLogin())!
      return [{ domain: 'chatgpt.com', headers: { authorization: `Bearer ${accessToken}` } }]
    },

    async prepare(backend) {
      const install = await backend.execute(
        `npm i -g --prefix $HOME/.local @openai/codex@${CODEX_VERSION} 2>&1 | tail -3`,
        { timeoutMs: 180_000 },
      )
      const check = await backend.execute(`${CODEX} --version`)
      if (check.exitCode !== 0) {
        throw new Error(
          `codex did not install: ${(install.stdout || check.stderr).trim().slice(-300)}`,
        )
      }
      const current = await subscriptionLogin()
      if (current) {
        await backend.uploadFile('/tmp/codex-auth.json', placeholderAuth(current, io.now))
        const placed = await backend.execute(
          `mkdir -p $HOME/.codex && mv /tmp/codex-auth.json ${AUTH_FILE} && chmod 600 ${AUTH_FILE}`,
        )
        if (placed.exitCode !== 0)
          throw new Error(`could not place the Codex login: ${placed.stderr}`)
      }
    },

    run: (backend, input) => invoke(backend, input, ''),
    resume: async (backend, sessionId, input) => invoke(backend, input, assertSessionId(sessionId)),
  }
}

type CodexEvent = {
  type?: string
  thread_id?: string
  message?: string
  item?: { type?: string; text?: string; message?: string }
  error?: { message?: string }
}

/**
 * Reads the JSON lines `codex exec --json` prints: the thread id for `resume`, the last thing the
 * agent said as the summary, and a failure or quota stop in the agent's own words.
 */
/**
 * What Node prints to stderr about itself, which says nothing about why the agent stopped. A run that failed
 * was reported with only this ("EnvHttpProxyAgent is experimental"), and the real reason was lost.
 */
const NODE_NOISE = /^\(node:\d+\) |^\(Use `node --trace-/

export function cleaned(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !NODE_NOISE.test(line.trim()))
    .join('\n')
    .trim()
}

/** The exit code is the one fact that is always there: 137 is a kill, almost always for memory. */
function withExitCode(exitCode: number, text: string): string {
  const killed = exitCode === 137 ? 'killed (most likely out of memory), ' : ''
  return text ? `${text} (${killed}exit ${exitCode})` : `${killed}exit ${exitCode}`
}

export function parseCodexResult(exitCode: number, stdout: string, stderr: string): HarnessResult {
  let sessionId: string | undefined
  let summary = ''
  let completed = false
  let failure: string | undefined
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    let event: CodexEvent
    try {
      event = JSON.parse(line) as CodexEvent
    } catch {
      continue
    }
    if (event.type === 'thread.started' && event.thread_id) sessionId = event.thread_id
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      summary = event.item.text ?? summary
    }
    if (event.type === 'turn.completed') completed = true
    if (event.type === 'turn.failed') failure = event.error?.message ?? 'the turn failed'
    // A stream that fell back to another transport is reported as an error event but the turn goes on.
    if (
      event.type === 'error' &&
      event.message &&
      !/reconnecting|falling back/i.test(event.message)
    ) {
      failure ??= event.message
    }
  }
  const ok = exitCode === 0 && completed && failure === undefined
  const text =
    failure ?? (ok ? '' : withExitCode(exitCode, (cleaned(stderr) || stdout).trim().slice(-1000)))
  const quota = ok ? undefined : detectQuota(text)
  return {
    ok,
    summary: (ok ? summary : `codex failed: ${text || `exit ${exitCode}`}`).slice(0, SUMMARY_MAX),
    ...(sessionId ? { sessionId } : {}),
    ...(quota ? { quota } : {}),
  }
}
