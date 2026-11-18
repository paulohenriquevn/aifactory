import { existsSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { FakeBackend, type Reply } from './fake-sandbox'
import {
  gitleaksScanner,
  readSecurityFloor,
  SECURITY_DIR,
  type SecretScanner,
} from './security-scan'

// Fake values in the documented formats, built in pieces so that no scanner, GitHub's included, reads a key here.
const AWS_KEY = 'AKIA' + 'Z7QXRM2BTKD5PL6W'
const GITHUB_TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'

const HEAD = 'a'.repeat(40)
const TIP = 'b'.repeat(40)
const BASE = 'c'.repeat(40)

const diff = [
  'diff --git a/src/config.ts b/src/config.ts',
  '--- a/src/config.ts',
  '+++ b/src/config.ts',
  '@@ -4,0 +5,2 @@',
  '+const region = "x"',
  `+const awsKeyId = "${AWS_KEY}"`,
].join('\n')

const pnpmAudit = (...ids: string[]) =>
  JSON.stringify({
    advisories: Object.fromEntries(
      ids.map((id, i) => [
        String(i),
        { github_advisory_id: id, module_name: 'picomatch', severity: 'high', title: 'ReDoS' },
      ]),
    ),
  })

type Repo = {
  lockfiles?: { base: string[]; head: string[] }
  audits?: { base: Reply; head: Reply }
}

/** A sandbox whose repository answers git the way a real one would, and audits as scripted. */
function sandbox({ lockfiles = { base: [], head: [] }, audits }: Repo = {}) {
  return new FakeBackend((command) => {
    if (command.includes('rev-parse --verify HEAD^{commit}')) return { stdout: `${HEAD}\n` }
    if (command.includes('rev-parse --verify workspace^{commit}')) return { stdout: `${TIP}\n` }
    if (command.includes(`merge-base ${TIP} ${HEAD}`)) return { stdout: `${BASE}\n` }
    if (command.includes(`diff --no-color`)) return { stdout: diff }
    if (command.includes('diff --name-only')) return { stdout: 'src/config.ts\n.github/ci.yml\n' }
    const lock = command.match(/cat-file -e (\w+):(\S+)/)
    if (lock) {
      const at = lock[1] === BASE ? lockfiles.base : lockfiles.head
      return { exitCode: at.includes(lock[2]) ? 0 : 128 }
    }
    if (command.startsWith(`cd ${SECURITY_DIR}/base`)) return audits?.base
    if (command.startsWith(`cd ${SECURITY_DIR}/head`)) return audits?.head
    return undefined
  })
}

const noSecret: SecretScanner = async () => ({ report: '[]' })
const input = (scanSecrets: SecretScanner = noSecret) => ({
  repoDir: '/work/repo',
  baseSha: 'workspace',
  scanSecrets,
  timeoutMs: 60_000,
})

describe('reading the security floor in a sandbox', () => {
  it('hands the scanner only the lines the change adds, from the merge base', async () => {
    const backend = sandbox()
    const seen: string[] = []
    await readSecurityFloor(
      backend,
      input(async (text) => {
        seen.push(text)
        return { report: '[]' }
      }),
    )
    expect(seen).toEqual([`const region = "x"\nconst awsKeyId = "${AWS_KEY}"`])
    expect(backend.commands).toContain(
      `git -C /work/repo -c core.quotePath=false diff --no-color --no-ext-diff --no-renames -U0 ${BASE} ${HEAD}`,
    )
  })

  it('blocks on what the scanner found, at its file and line', async () => {
    const scan: SecretScanner = async () => ({
      report: JSON.stringify([
        {
          RuleID: 'aws-access-token',
          StartLine: 2,
          EndLine: 2,
          StartColumn: 20,
          EndColumn: 39,
          Secret: 'AKI...',
        },
      ]),
    })
    const floor = await readSecurityFloor(sandbox(), input(scan))
    expect(floor.blocked).toBe(true)
    expect(floor.findings.find((f) => f.kind === 'secret')).toMatchObject({
      file: 'src/config.ts',
      line: 6,
    })
    expect(floor.findings.find((f) => f.kind === 'sensitive_path')?.file).toBe('.github/ci.yml')
  })

  it('blocks when the scanner did not run', async () => {
    const floor = await readSecurityFloor(
      sandbox(),
      input(async () => ({ failed: 'gitleaks could not start' })),
    )
    expect(floor.blocked).toBe(true)
  })

  it('audits the base and the head each in a checkout of its own, and removes both', async () => {
    const backend = sandbox({
      lockfiles: { base: ['pnpm-lock.yaml'], head: ['pnpm-lock.yaml'] },
      audits: {
        base: { stdout: pnpmAudit('GHSA-old0-old0-old0'), exitCode: 1 },
        head: { stdout: pnpmAudit('GHSA-old0-old0-old0', 'GHSA-new0-new0-new0'), exitCode: 1 },
      },
    })
    const floor = await readSecurityFloor(backend, input())
    expect(floor.blocked).toBe(true)
    expect(floor.findings.filter((f) => f.kind === 'advisory').map((f) => f.detail)).toEqual([
      'GHSA-new0-new0-new0 in picomatch (high): ReDoS',
    ])
    expect(backend.commands).toEqual(
      expect.arrayContaining([
        `rm -rf ${SECURITY_DIR}/base && git -C /work/repo worktree add --detach ${SECURITY_DIR}/base ${BASE}`,
        `cd ${SECURITY_DIR}/base && pnpm audit --json`,
        `git -C /work/repo worktree remove --force ${SECURITY_DIR}/base`,
        `cd ${SECURITY_DIR}/head && pnpm audit --json`,
        `git -C /work/repo worktree remove --force ${SECURITY_DIR}/head`,
      ]),
    )
  })

  it('takes a base with no lockfile as one with no advisory, and audits npm from its lockfile alone', async () => {
    const backend = sandbox({
      lockfiles: { base: [], head: ['package-lock.json'] },
      audits: { base: {}, head: { stdout: pnpmAudit('GHSA-new0-new0-new0'), exitCode: 1 } },
    })
    const floor = await readSecurityFloor(backend, input())
    expect(floor.findings.filter((f) => f.kind === 'advisory')).toHaveLength(1)
    expect(backend.commands.some((c) => c.startsWith(`cd ${SECURITY_DIR}/base`))).toBe(false)
    expect(backend.commands).toContain(
      `cd ${SECURITY_DIR}/head && npm audit --json --package-lock-only`,
    )
  })

  it('blocks on an audit that printed no JSON, with what it printed instead', async () => {
    const backend = sandbox({
      lockfiles: { base: ['pnpm-lock.yaml'], head: ['pnpm-lock.yaml'] },
      audits: {
        base: { stdout: pnpmAudit() },
        head: { stdout: '', stderr: 'ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS', exitCode: 1 },
      },
    })
    const floor = await readSecurityFloor(backend, input())
    expect(floor.blocked).toBe(true)
    expect(floor.findings[0].detail).toContain('ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS')
  })

  it('removes the checkout even when its audit throws', async () => {
    const backend = sandbox({ lockfiles: { base: [], head: ['pnpm-lock.yaml'] } })
    const execute = backend.execute.bind(backend)
    backend.execute = async (command: string) => {
      if (command.startsWith(`cd ${SECURITY_DIR}/head`)) throw new Error('sandbox gone')
      return execute(command)
    }
    await expect(readSecurityFloor(backend, input())).rejects.toThrow('sandbox gone')
    expect(backend.commands).toContain(
      `git -C /work/repo worktree remove --force ${SECURITY_DIR}/head`,
    )
  })

  it('refuses a base that a shell would read as more than a word', async () => {
    await expect(
      readSecurityFloor(sandbox(), { ...input(), baseSha: 'x; rm -rf /' }),
    ).rejects.toThrow(/not a plain revision/)
  })
})

describe('the gitleaks scanner', () => {
  it('does not scan text with nothing in it', async () => {
    expect(await gitleaksScanner({ FACTORY_GITLEAKS: '/nowhere/gitleaks' })('  \n')).toEqual({
      report: '[]',
    })
  })

  it('says it could not start when the binary is missing, never that the text is clean', async () => {
    const scan = await gitleaksScanner({ FACTORY_GITLEAKS: '/nowhere/gitleaks' })('const a = 1')
    expect(scan).toEqual({ failed: expect.stringMatching(/\/nowhere\/gitleaks could not start/) })
  })

  it('says how it failed when the binary exits with an error', async () => {
    const scan = await gitleaksScanner({ FACTORY_GITLEAKS: 'false' })('const a = 1')
    expect(scan).toEqual({ failed: 'false exited 1: ' })
  })
})

// Runs only where gitleaks is installed: the factory's host has it, a laptop may not.
const GITLEAKS = process.env.FACTORY_GITLEAKS || '/home/paulo/go/bin/gitleaks'
describe.runIf(existsSync(GITLEAKS))('gitleaks, for real', () => {
  it('finds the keys a diff adds, places them, and reports no value', async () => {
    const real = diff + `\n+const token = "${GITHUB_TOKEN}"`
    const backend = sandbox()
    const execute = backend.execute.bind(backend)
    backend.execute = async (command: string) =>
      command.includes('diff --no-color')
        ? { stdout: real, stderr: '', exitCode: 0, timedOut: false }
        : execute(command)
    const floor = await readSecurityFloor(
      backend,
      input(gitleaksScanner({ FACTORY_GITLEAKS: GITLEAKS })),
    )
    const secrets = floor.findings.filter((f) => f.kind === 'secret')
    expect(floor.blocked).toBe(true)
    expect(secrets.map((f) => [f.file, f.line, f.detail]).sort()).toEqual([
      ['src/config.ts', 6, 'aws-access-token: AKI… (20 characters)'],
      ['src/config.ts', 7, 'github-pat: ghp_… (40 characters)'],
    ])
    expect(JSON.stringify(floor)).not.toContain(AWS_KEY.slice(4))
    expect(JSON.stringify(floor)).not.toContain(GITHUB_TOKEN.slice(4))
  }, 60_000)

  it('ignores a gitleaks:allow comment the change adds', async () => {
    const scan = await gitleaksScanner({ FACTORY_GITLEAKS: GITLEAKS })(
      `const awsKeyId = "${AWS_KEY}" // gitleaks:allow`,
    )
    expect('report' in scan && JSON.parse(scan.report)).toHaveLength(1)
  }, 60_000)
})
