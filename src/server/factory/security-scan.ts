import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SandboxBackend } from '@theokit/agents/sandbox'

import { withTimeout } from './clone'
import { must } from './run-support'
import {
  addedLines,
  scanText,
  securityFloor,
  type AuditOutputs,
  type SecretScan,
  type SecurityFloor,
} from './security-floor'

/**
 * Reads what the security floor decides over (#241): the diff and the changed files from the sandbox, the
 * dependency audit of the base and of the head, each in a checkout of its own, and a secret scan of the lines
 * the diff adds. The scan runs on the factory's host, not in the sandbox: the diff is text the factory already
 * holds, and the scanner is a binary the factory owns, which a change in the repository cannot replace.
 */

/** Scans text for secrets; never throws, so a scanner that cannot run is a finding, not a pass. */
export type SecretScanner = (text: string) => Promise<SecretScan>

/** Where the base and the head are checked out for their audits, beside the work's checkout. */
export const SECURITY_DIR = '/tmp/aifactory-security'

/** A secret scan of a diff takes seconds; one that takes minutes has stalled. */
export const GITLEAKS_TIMEOUT_MS = 2 * 60_000

/**
 * The flags of every scan. `--redact=85` leaves only the first characters of a value in the report;
 * `--ignore-gitleaks-allow` reads past the `gitleaks:allow` comments a change could add; and the scan runs in an
 * empty folder with no config in its environment, so no `.gitleaksignore`, `.gitleaks.toml` or baseline of the
 * repository reaches it.
 */
const GITLEAKS_ARGS = [
  'stdin',
  '--no-banner',
  '--no-color',
  '--redact=85',
  '--report-format',
  'json',
  '--report-path',
  '-',
  '--exit-code',
  '0',
  '--ignore-gitleaks-allow',
  '--log-level',
  'error',
]

/** Runs gitleaks over `text` in `cwd`, answering its report, or why it gave none. */
function runGitleaks(binary: string, text: string, cwd: string): Promise<SecretScan> {
  return new Promise((resolve) => {
    const child = spawn(binary, GITLEAKS_ARGS, {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: cwd },
      timeout: GITLEAKS_TIMEOUT_MS,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', (error) =>
      resolve({
        failed: `${binary} could not start (${error.message}); FACTORY_GITLEAKS names the binary`,
      }),
    )
    child.on('close', (code, signal) =>
      resolve(
        code === 0
          ? { report: stdout }
          : { failed: `${binary} exited ${code ?? signal}: ${stderr.trim().slice(-300)}` },
      ),
    )
    // A scanner that exits before reading its input breaks the pipe; its exit says what went wrong.
    child.stdin.on('error', () => undefined)
    child.stdin.end(text)
  })
}

/**
 * The secret scanner of the factory: gitleaks on the host, `FACTORY_GITLEAKS` or `gitleaks` on the `PATH`. Text
 * with nothing in it has no secret to find, and is not scanned.
 */
export function gitleaksScanner(env: NodeJS.ProcessEnv = process.env): SecretScanner {
  const binary = env.FACTORY_GITLEAKS || 'gitleaks'
  return async (text) => {
    if (text.trim() === '') return { report: '[]' }
    const dir = await mkdtemp(join(tmpdir(), 'aifactory-gitleaks-'))
    try {
      return await runGitleaks(binary, text, dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

/** Each lockfile the floor audits, and the command that audits it from the lockfile alone, with no install. */
const AUDITS = [
  { lockfile: 'pnpm-lock.yaml', command: 'pnpm audit --json' },
  { lockfile: 'package-lock.json', command: 'npm audit --json --package-lock-only' },
]

/** What a base with no lockfile has: no advisory. */
const NO_ADVISORY = JSON.stringify({ advisories: {} })

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
/** A commit id or a branch name, with nothing a shell reads as more than a word. */
const PLAIN_REV = /^[\w][\w./-]{0,200}$/

async function commitOf(backend: SandboxBackend, git: string, rev: string): Promise<string> {
  const sha = (await must(backend, `${git} rev-parse --verify ${rev}^{commit}`)).stdout.trim()
  if (!COMMIT.test(sha)) throw new Error(`git named no commit for ${rev}: "${sha.slice(0, 80)}"`)
  return sha
}

async function hasFile(backend: SandboxBackend, git: string, sha: string, path: string) {
  return (await backend.execute(`${git} cat-file -e ${sha}:${path}`)).exitCode === 0
}

/**
 * The audit of one commit, in a checkout of its own: what it printed, whatever its exit code, since an audit
 * exits non-zero when it finds an advisory. What it printed is read by the floor, which blocks on anything that
 * is not an audit's JSON.
 */
async function auditAt(
  backend: SandboxBackend,
  git: string,
  sha: string,
  name: string,
  command: string,
): Promise<string> {
  const dir = `${SECURITY_DIR}/${name}`
  await must(backend, `rm -rf ${dir} && ${git} worktree add --detach ${dir} ${sha}`)
  try {
    const result = await backend.execute(`cd ${dir} && ${command}`)
    return result.stdout.trim() === '' ? result.stderr : result.stdout
  } finally {
    await must(backend, `${git} worktree remove --force ${dir}`)
  }
}

/** The audits of the base and the head for the first lockfile the head has; undefined when it has none. */
async function readAudits(
  backend: SandboxBackend,
  git: string,
  base: string,
  head: string,
): Promise<AuditOutputs | undefined> {
  for (const { lockfile, command } of AUDITS) {
    if (!(await hasFile(backend, git, head, lockfile))) continue
    const before = (await hasFile(backend, git, base, lockfile))
      ? await auditAt(backend, git, base, 'base', command)
      : NO_ADVISORY
    return { lockfile, base: before, head: await auditAt(backend, git, head, 'head', command) }
  }
  return undefined
}

export type SecurityScanInput = {
  repoDir: string
  /** The commit the work is measured from; the change is what HEAD adds since its merge base with it. */
  baseSha: string
  scanSecrets: SecretScanner
  timeoutMs: number
}

/**
 * The security floor of the change on HEAD, measured from the merge base of `baseSha` and HEAD, as the reviewer
 * reads it. Reads only: the audits run in checkouts of their own, which are removed after.
 */
export async function readSecurityFloor(
  sandbox: SandboxBackend,
  input: SecurityScanInput,
): Promise<SecurityFloor> {
  if (!PLAIN_REV.test(input.baseSha)) throw new Error(`"${input.baseSha}" is not a plain revision`)
  const backend = withTimeout(sandbox, input.timeoutMs)
  const git = `git -C ${input.repoDir}`
  const head = await commitOf(backend, git, 'HEAD')
  const tip = await commitOf(backend, git, input.baseSha)
  const base = (await must(backend, `${git} merge-base ${tip} ${head}`)).stdout.trim()
  if (!COMMIT.test(base)) throw new Error(`git named no merge base of ${tip} and ${head}`)
  const diff = (
    await must(
      backend,
      `${git} -c core.quotePath=false diff --no-color --no-ext-diff --no-renames -U0 ${base} ${head}`,
    )
  ).stdout
  const changedFiles = (
    await must(
      backend,
      `${git} -c core.quotePath=false diff --name-only --no-renames ${base} ${head}`,
    )
  ).stdout
    .split('\n')
    .filter(Boolean)
  const secrets = await input.scanSecrets(scanText(addedLines(diff)).text)
  const audit = await readAudits(backend, git, base, head)
  return securityFloor({ diff, changedFiles, secrets, ...(audit ? { audit } : {}) })
}
