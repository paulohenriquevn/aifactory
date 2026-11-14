import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  AuthProvider,
  authFilePath,
  CODEX_PROVIDER,
  credentialHome,
  persistOAuthTokens,
  readStoredOAuth,
  writeCredential,
  type CredentialStoreConfig,
  type OAuthTokens,
  type StoredOAuthCredential,
} from '@theokit/agents/auth'
import { withFileLock } from '@theokit/sdk/persistence'

/**
 * The factory's own Codex login, kept in TheoKit's credential store. It is not the Codex login of the owner's
 * daily use, nor the assistant's ChatGPT login: a refresh token rotates, and two users of one login
 * invalidate each other. `FACTORY_CODEX_HOME` moves the folder, as it always has.
 */
export const CODEX_STORE: CredentialStoreConfig = {
  home: homedir(),
  dirName: '.codex-factory-1',
  fileName: 'factory-auth.json',
  homeEnvVar: 'FACTORY_CODEX_HOME',
}

/**
 * The access token is renewed when it has less than this left. It lasts about ten days, and a run carries
 * the same token for up to half an hour, so it must not expire in the middle of one.
 */
export const REFRESH_MARGIN_MS = 2 * 24 * 3600 * 1000

export class CodexLoginError extends Error {
  override name = 'CodexLoginError'
}

export type CodexLogin = { accessToken: string; idToken: string; accountId?: string }

type Env = Record<string, string | undefined>

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const codexHomeOf = (env: Env = process.env) => credentialHome(CODEX_STORE, env)
export const codexAuthFile = (env: Env = process.env) => authFilePath(CODEX_STORE, env)
/** Where `codex login --device-auth` left the login before the panel could make one. */
export const legacyAuthFile = (env: Env = process.env) => join(codexHomeOf(env), 'auth.json')

/** Whether the factory has a Codex subscription login, in either place. */
export const hasCodexLogin = (
  env: Env = process.env,
  exists: (path: string) => boolean = existsSync,
) => exists(codexAuthFile(env)) || exists(legacyAuthFile(env))

/** The claims of a JWT, without checking its signature: only the host's own token is ever read. */
export function claimsOf(jwt: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

type CliAuthFile = {
  tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string }
}

/** The Codex CLI's `auth.json` as a TheoKit credential, so the first read moves an old login over. */
export function fromCliAuth(text: string): StoredOAuthCredential {
  const tokens = (JSON.parse(text) as CliAuthFile).tokens
  const exp = tokens?.access_token ? claimsOf(tokens.access_token).exp : undefined
  if (
    !tokens?.access_token ||
    !tokens.refresh_token ||
    !tokens.id_token ||
    typeof exp !== 'number'
  ) {
    throw new CodexLoginError(
      'the Codex auth.json has no ChatGPT login (it needs an access, a refresh and an ID token)',
    )
  }
  return {
    type: 'oauth',
    provider: CODEX_PROVIDER.oauth.provider,
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: exp * 1000,
    ...(tokens.account_id ? { account_id: tokens.account_id } : {}),
    id_token: tokens.id_token,
  }
}

function loginOf(stored: StoredOAuthCredential, env: Env): CodexLogin {
  if (!stored.id_token) {
    throw new CodexLoginError(
      `the Codex login in ${codexHomeOf(env)} has no ID token: connect Codex again from the Setup page`,
    )
  }
  return {
    accessToken: stored.access,
    idToken: stored.id_token,
    ...(stored.account_id ? { accountId: stored.account_id } : {}),
  }
}

/**
 * The stored login, moving the CLI's file over the first time. Under the store's lock, so two processes
 * never both copy it, and released before a renewal, because the renewal takes the same lock and the lock
 * is not reentrant.
 */
function storedOrMigrated(env: Env): Promise<StoredOAuthCredential | undefined> {
  return withFileLock(codexAuthFile(env), async () => {
    const stored = readStoredOAuth(CODEX_STORE, env)
    if (stored) return stored
    const legacy = legacyAuthFile(env)
    if (!existsSync(legacy)) return undefined
    const migrated = fromCliAuth(readFileSync(legacy, 'utf8'))
    writeCredential(migrated, CODEX_STORE, env)
    return migrated
  })
}

export type CodexAuthDeps = { env?: Env; fetch?: typeof fetch; now?: () => number }

/** TheoKit's refresh for this store: cross-process lock, re-read inside it, retry on a transient failure. */
const provider = new AuthProvider(CODEX_PROVIDER.oauth, CODEX_STORE, {
  refreshBeforeMs: REFRESH_MARGIN_MS,
})

/**
 * The factory's Codex login with an access token that will outlast a run. The renewal is TheoKit's, which
 * re-reads the file under its lock, so two runs never both spend the rotating refresh token and a renewal
 * never writes an old account over a login that just replaced it.
 */
export async function freshCodexLogin(deps: CodexAuthDeps = {}): Promise<CodexLogin> {
  const env = deps.env ?? process.env
  const stored = await storedOrMigrated(env)
  if (!stored) {
    throw new CodexLoginError(
      `there is no Codex login in ${codexHomeOf(env)}: connect Codex from the Setup page`,
    )
  }
  try {
    await provider.ensureFresh(
      {
        kind: 'oauth',
        provider: stored.provider,
        apiKey: stored.access,
        source: codexAuthFile(env),
        inferred: false,
        expiresAt: stored.expires,
      },
      { fetch: deps.fetch ?? fetch, now: deps.now ?? Date.now },
      env,
    )
  } catch (error) {
    throw new CodexLoginError(
      `the Codex login in ${codexHomeOf(env)} could not be renewed (${reason(error)}): connect Codex again from the Setup page`,
      { cause: error },
    )
  }
  // The ID token and the account are in the file, not in what the refresh returns.
  const current = readStoredOAuth(CODEX_STORE, env)
  if (!current) throw new CodexLoginError('the renewed Codex login was not found in its store')
  return loginOf(current, env)
}

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')

/** Beside the store: the hash of the access token the provider refused, never the token. */
const refusalFile = (env: Env) => `${codexAuthFile(env)}.refused`

function refusedHash(env: Env): string | undefined {
  try {
    return readFileSync(refusalFile(env), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * The login in the store, or the CLI's old file, as it is now. Read, never migrated, so it is safe under the
 * lock a renewal takes.
 */
function readLogin(env: Env): StoredOAuthCredential | undefined {
  const stored = readStoredOAuth(CODEX_STORE, env)
  if (stored) return stored
  return existsSync(legacyAuthFile(env))
    ? fromCliAuth(readFileSync(legacyAuthFile(env), 'utf8'))
    : undefined
}

/**
 * Records that the provider refused this access token, whatever its `exp` says. Only when it is the token the
 * store holds now, decided under the store's lock: a refusal that reaches us late, for a token already
 * replaced, says nothing about the login in use and must not hide a refusal of that one.
 */
export function markCodexRefused(token: string, env: Env = process.env): Promise<void> {
  return withFileLock(codexAuthFile(env), async () => {
    if (readLogin(env)?.access !== token) return
    writeFileSync(refusalFile(env), hashOf(token), { mode: 0o600 })
  })
}

/** Renews whatever `exp` says. Its margin is so large that the stored token always counts as stale. */
const forced = new AuthProvider(CODEX_PROVIDER.oauth, CODEX_STORE, {
  refreshBeforeMs: Number.MAX_SAFE_INTEGER,
})

/**
 * The login after the provider refused `refused`, the access token the sandbox holds. When the store no
 * longer holds it, another run or a new sign-in replaced it and that login is used as it is. Otherwise it is
 * renewed at once. That is decided inside the lock the renewal takes: the provider calls `fetch` only after it
 * re-read the store under the lock, so a `fetch` that looks at the store again sees what the renewal would
 * spend, and refuses to go on when it is not the refused token. The refusal marker is cleared only when it is
 * about the token this replaced: a refusal of the replacement, written meanwhile, stays.
 */
export async function renewCodexLogin(
  refused: string,
  deps: CodexAuthDeps = {},
): Promise<CodexLogin> {
  const env = deps.env ?? process.env
  const stored = await storedOrMigrated(env)
  if (!stored) {
    throw new CodexLoginError(
      `there is no Codex login in ${codexHomeOf(env)}: connect Codex from the Setup page`,
    )
  }
  let replaced = false
  let renewed = false
  const send = deps.fetch ?? fetch
  const guarded = (async (...args: Parameters<typeof fetch>) => {
    if (readStoredOAuth(CODEX_STORE, env)?.access !== refused) {
      replaced = true
      throw new Error('stopped: the login was replaced')
    }
    renewed = true
    return send(...args)
  }) as typeof fetch
  if (stored.access === refused) {
    try {
      await forced.ensureFresh(
        {
          kind: 'oauth',
          provider: stored.provider,
          apiKey: stored.access,
          source: codexAuthFile(env),
          inferred: false,
          expiresAt: stored.expires,
        },
        { fetch: guarded, now: deps.now ?? Date.now },
        env,
      )
    } catch (error) {
      if (!replaced) {
        throw new CodexLoginError(
          `the Codex login in ${codexHomeOf(env)} was refused and could not be renewed (${reason(error)}): connect Codex again from the Setup page`,
          { cause: error },
        )
      }
    }
    if (renewed) {
      await withFileLock(codexAuthFile(env), async () => {
        if (refusedHash(env) === hashOf(refused)) rmSync(refusalFile(env), { force: true })
      })
    }
  }
  const current = readStoredOAuth(CODEX_STORE, env)
  if (!current) throw new CodexLoginError('the renewed Codex login was not found in its store')
  if (current.access === refused) {
    throw new CodexLoginError(
      `the Codex login in ${codexHomeOf(env)} was refused and could not be renewed (another renewal was running): connect Codex again from the Setup page`,
    )
  }
  return loginOf(current, env)
}

/** Keeps a new login, under the lock a renewal takes, so the two can never interleave. */
export function saveCodexLogin(tokens: OAuthTokens, env: Env = process.env): Promise<void> {
  if (!tokens.idToken) {
    return Promise.reject(new CodexLoginError('the login gave no ID token, which Codex needs'))
  }
  return withFileLock(codexAuthFile(env), async () => {
    persistOAuthTokens(CODEX_PROVIDER.oauth.provider, tokens, CODEX_STORE, env)
  })
}

/** Who the factory's Codex login belongs to, as the panel shows it. Never a token. */
export type CodexAccount =
  { connected: false; problem?: string } | { connected: true; email?: string; plan?: string }

export function codexAccount(env: Env = process.env): CodexAccount {
  let stored: StoredOAuthCredential | undefined
  try {
    stored = readLogin(env)
  } catch (error) {
    // A file the store refuses (wrong mode, wrong shape) is a login the factory cannot use: say why.
    return { connected: false, problem: reason(error) }
  }
  if (!stored) return { connected: false }
  if (refusedHash(env) === hashOf(stored.access)) {
    return {
      connected: false,
      problem: 'the provider refused the Codex login: connect Codex again from the Setup page',
    }
  }
  const claims = stored.id_token ? claimsOf(stored.id_token) : {}
  const auth = claims['https://api.openai.com/auth'] as { chatgpt_plan_type?: unknown } | undefined
  return {
    connected: true,
    ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
    ...(typeof auth?.chatgpt_plan_type === 'string' ? { plan: auth.chatgpt_plan_type } : {}),
  }
}
