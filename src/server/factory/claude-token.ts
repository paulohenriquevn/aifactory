import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** A Claude Code subscription token: the prefix the CLI prints, then about a hundred plain characters. */
export const TOKEN_PATTERN = /^sk-ant-oat01-[A-Za-z0-9_-]{60,}$/

/**
 * Where the token the panel saved is kept: a file of its own, private to the owner, beside the other
 * secrets. It is read when a run starts, so a new account applies to the next run in every process with no
 * restart, which a value in the environment file cannot do.
 */
export const tokenFile = (env: NodeJS.ProcessEnv = process.env) =>
  env.FACTORY_CLAUDE_TOKEN_FILE || resolve(process.cwd(), '.secrets/claude-oauth-token')

/** The saved token, or nothing when there is none or what is there is not a token. */
export function readStoredToken(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string | undefined {
  try {
    const token = read(tokenFile(env)).trim()
    return TOKEN_PATTERN.test(token) ? token : undefined
  } catch {
    return undefined
  }
}

/** The environment with the saved token laid over the one in the environment file, which it replaces. */
export function withClaudeToken(
  env: NodeJS.ProcessEnv,
  read?: (path: string) => string,
): NodeJS.ProcessEnv {
  const token = readStoredToken(env, read)
  return token ? { ...env, CLAUDE_CODE_OAUTH_TOKEN: token } : env
}

/**
 * Saves a token so only the owner can read it, in one step: written beside the file and moved over it, so a
 * failure never leaves it half written, and never wider than 0600 for even a moment.
 */
export function saveStoredToken(token: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!TOKEN_PATTERN.test(token)) throw new Error('that is not a Claude Code token')
  const file = tokenFile(env)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}
