import { SandboxBackend } from '@theokit/agents/sandbox'
import { describe, expect, it } from 'vitest'

import { CLONE_ATTEMPTS, CLONE_TIMEOUT_MS, cloneRepository, withTimeout } from './clone'

/** A backend whose clone answers from a list, one reply per attempt, and that keeps each command's timeout. */
class CloneBackend extends SandboxBackend {
  calls: { command: string; timeoutMs?: number }[] = []
  constructor(private readonly clones: { exitCode: number; stderr?: string }[]) {
    super()
  }
  async execute(command: string, opts: { timeoutMs?: number } = {}) {
    this.calls.push({ command, timeoutMs: opts.timeoutMs })
    const reply = command.includes(' clone ')
      ? (this.clones.shift() ?? { exitCode: 0 })
      : command.includes('--show-toplevel')
        ? { exitCode: 0, stdout: '/work/work\n' }
        : { exitCode: 0 }
    return { stdout: '', stderr: '', timedOut: false, ...reply }
  }
  async uploadFile(_path: string, _content: string | Buffer) {}
  clonesRun() {
    return this.calls.filter((c) => c.command.includes(' clone ')).length
  }
}

const options = { repoUrl: 'https://github.com/o/r.git', ref: 'workspace', instanceId: 'work' }
const stalled = { exitCode: 124, stderr: 'timed out after 180000 ms' }

describe('cloneRepository', () => {
  it('clones once and returns the checkout when the first clone works', async () => {
    const backend = new CloneBackend([{ exitCode: 0 }])

    const result = await cloneRepository(backend, options)

    expect(result).toEqual({ repoDir: '/work/work' })
    expect(backend.clonesRun()).toBe(1)
  })

  it('bounds every command of the clone by its own timeout', async () => {
    const backend = new CloneBackend([{ exitCode: 0 }])

    await cloneRepository(backend, options)

    expect(backend.calls.map((c) => c.timeoutMs)).toEqual(backend.calls.map(() => CLONE_TIMEOUT_MS))
    expect(CLONE_TIMEOUT_MS).toBe(180_000)
  })

  it('removes the partial checkout and clones again after a stalled clone', async () => {
    const backend = new CloneBackend([stalled, { exitCode: 0 }])

    const result = await cloneRepository(backend, options)

    expect(result).toEqual({ repoDir: '/work/work' })
    const commands = backend.calls.map((c) => c.command)
    const removed = commands.indexOf("rm -rf -- 'work'")
    expect(removed).toBeGreaterThan(0)
    expect(commands.slice(removed + 1).some((c) => c.includes(' clone '))).toBe(true)
  })

  it('gives up with the clone error after the last attempt', async () => {
    const backend = new CloneBackend(Array.from({ length: CLONE_ATTEMPTS }, () => stalled))

    await expect(cloneRepository(backend, options)).rejects.toThrow(
      /clone failed: timed out after 180000 ms/,
    )
    expect(backend.clonesRun()).toBe(CLONE_ATTEMPTS)
    expect(CLONE_ATTEMPTS).toBe(3)
  })

  it('does not clone again when what failed is the checkout of the branch', async () => {
    const backend = new CloneBackend([{ exitCode: 0 }])
    const failing = Object.assign(backend, {
      execute: async (command: string, opts?: { timeoutMs?: number }) => {
        const result = await CloneBackend.prototype.execute.call(backend, command, opts)
        return command.includes('checkout --quiet')
          ? { ...result, exitCode: 1, stderr: 'pathspec did not match' }
          : result
      },
    })

    await expect(cloneRepository(failing, options)).rejects.toThrow(/checkout workspace failed/)
    expect(backend.clonesRun()).toBe(1)
  })
})

describe('withTimeout', () => {
  it('keeps a timeout the caller passes', async () => {
    const backend = new CloneBackend([])

    await withTimeout(backend, 1_000).execute('true', { timeoutMs: 5 })

    expect(backend.calls).toEqual([{ command: 'true', timeoutMs: 5 }])
  })

  it('leaves every other member of the backend working on the backend itself', async () => {
    const backend = new CloneBackend([])
    const uploaded: string[] = []
    backend.uploadFile = async function (this: CloneBackend, path: string) {
      uploaded.push(`${this === backend}:${path}`)
    }
    const bounded = withTimeout(backend, 1_000)

    await bounded.uploadFile('/tmp/a', 'x')

    expect(uploaded).toEqual(['true:/tmp/a'])
    expect((bounded as unknown as CloneBackend).calls).toBe(backend.calls)
  })
})
