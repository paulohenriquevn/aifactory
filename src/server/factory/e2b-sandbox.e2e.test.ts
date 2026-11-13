import { Sandbox } from 'e2b'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { e2bSandboxProvider } from './e2b-sandbox'
import { createIsolatedSandbox, restoreIsolatedSandbox, type IsolatedSandbox } from './sandbox'

// Runs real E2B sandboxes: needs E2B_API_KEY and the template from scripts/build-e2b-template.mts. httpbin.org
// echoes the headers a request arrived with, which is how the test sees what the egress proxy attached.
const provider = e2bSandboxProvider()
const egress = (secret: string) => [
  { domain: 'registry.npmjs.org' },
  { domain: 'github.com' },
  { domain: 'httpbin.org', headers: { 'x-factory-secret': secret } },
]
const spec = { timeoutMs: 10 * 60_000, egress: egress('the-real-secret') }

let sandbox: IsolatedSandbox
const sh = (command: string, timeoutMs = 60_000) => sandbox.backend.execute(command, { timeoutMs })

beforeAll(async () => {
  sandbox = await createIsolatedSandbox(provider, spec)
}, 120_000)

afterAll(async () => {
  await sandbox?.stop()
})

describe('an E2B sandbox', () => {
  it('reaches the allowed registry and git host with the tools of the image', async () => {
    expect((await sh('npm view left-pad version')).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
    expect((await sh('git ls-remote https://github.com/octocat/Hello-World HEAD')).exitCode).toBe(0)
    expect((await sh('pnpm --version')).exitCode).toBe(0)
  })

  it('has the tools a project test suite calls, such as the seccomp tests of theokit-sdk', async () => {
    // bwrap runs here, so theokit-sdk's sandbox tests run too, and they trace a process with strace.
    expect((await sh('command -v bwrap strace')).stdout.trim().split('\n')).toHaveLength(2)
  })

  it('cannot reach a domain that is not listed', async () => {
    const blocked = await sh('curl -sS -m 15 -o /dev/null https://example.com')
    expect(blocked.exitCode).not.toBe(0)
  })

  it('attaches the credential outside, so the sandbox never holds it', async () => {
    const node = `node -e "fetch('https://httpbin.org/headers').then(r=>r.text()).then(console.log)"`
    expect((await sh(node)).stdout).toContain('the-real-secret')
    expect((await sh('env; cat /proc/1/environ 2>/dev/null; true')).stdout).not.toContain(
      'the-real-secret',
    )
  })

  it('renews the credential while it runs, keeping the rest of the policy', async () => {
    await sandbox.updateEgress?.(egress('the-renewed-secret'))
    expect((await sh('curl -sS https://httpbin.org/headers')).stdout).toContain(
      'the-renewed-secret',
    )
    expect((await sh('curl -sS -m 15 -o /dev/null https://example.com')).exitCode).not.toBe(0)
  })

  it('writes the same file twice, as a run does with its prompt', async () => {
    await sandbox.backend.uploadFile('/tmp/factory-prompt.md', 'first')
    await sandbox.backend.uploadFile('/tmp/factory-prompt.md', 'second')
    expect((await sh('cat /tmp/factory-prompt.md')).stdout).toBe('second')
  })

  it('installs a native module without reaching nodejs.org, as theokit needs for better-sqlite3', async () => {
    const install = await sh(
      'mkdir -p /work/native && cd /work/native && npm init -y >/dev/null && npm install better-sqlite3@12.11.1',
      360_000,
    )
    expect(install.exitCode, install.stdout + install.stderr).toBe(0)
    const query = `node -e "console.log(new (require('better-sqlite3'))(':memory:').prepare('select 1 as x').get().x)"`
    expect((await sh(`cd /work/native && ${query}`)).stdout.trim()).toBe('1')
  }, 400_000)

  it('returns the exit code and the output of a failing command', async () => {
    expect(await sh('echo out; echo err >&2; exit 7')).toMatchObject({
      stdout: 'out\n',
      stderr: 'err\n',
      exitCode: 7,
      timedOut: false,
    })
  })

  it('stops a command at its timeout', async () => {
    expect(await sh('sleep 30', 2_000)).toMatchObject({ exitCode: 124, timedOut: true })
  })

  it('keeps the disk across a snapshot, under the same network rules, and frees it when done', async () => {
    await sh('echo kept > /work/marker')
    const snapshotId = await sandbox.snapshot!()
    sandbox = await restoreIsolatedSandbox(provider, snapshotId, spec)
    expect((await sh('cat /work/marker')).stdout).toBe('kept\n')
    expect((await sh('curl -sS -m 15 -o /dev/null https://example.com')).exitCode).not.toBe(0)

    // What a run does right after restoring: ask for the deletion, which waits for the sandbox to stop.
    await provider.deleteSnapshot?.(snapshotId)
    await sandbox.stop()
    const left = await Sandbox.listSnapshots().nextItems()
    expect(left.map((snapshot) => snapshot.snapshotId)).not.toContain(snapshotId)
  }, 300_000)
})
