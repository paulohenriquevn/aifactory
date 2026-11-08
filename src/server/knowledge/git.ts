import { spawn } from 'node:child_process'

/** A git command on the factory host that did not succeed, with what it said. */
export class KnowledgeGitError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${command} exited ${exitCode ?? 'by a signal'}: ${stderr.trim().slice(0, 500)}`)
  }
}

export type GitOptions = {
  /** A token for github.com. It reaches git through the environment, never through an argument. */
  token?: string
  input?: string | Buffer
  env?: Record<string, string>
  timeoutMs?: number
}

export type Git = (args: string[], options?: GitOptions) => Promise<Buffer>

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * The environment of one git call. It reads no configuration of the person running the factory (no
 * credential helper may answer instead of the token, no hook or alias applies), never prompts, and gets the
 * token as an HTTP header for github.com only, so it shows in no process list and no URL.
 */
export function gitEnv(options: GitOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    ...options.env,
  }
  if (options.token) {
    const basic = Buffer.from(`x-access-token:${options.token}`).toString('base64')
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`
  }
  return env
}

/** Runs git with arguments, never through a shell, and returns what it printed. */
export const runGit: Git = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      env: gitEnv(options),
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout!.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr!.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out))
      else {
        // The first argument that is not an option names the command; `-C <dir>` is skipped.
        const name = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-C') ?? 'git'
        reject(new KnowledgeGitError(name, code, Buffer.concat(err).toString('utf8')))
      }
    })
    if (child.stdin) {
      // A git that stops before reading its input closes the pipe; its exit code says what happened.
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') reject(error)
      })
      child.stdin.end(options.input)
    }
  })
