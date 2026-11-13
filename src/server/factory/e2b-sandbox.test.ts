import {
  ALL_TRAFFIC,
  CommandExitError,
  FileNotFoundError,
  NotFoundError,
  SandboxError,
  SandboxNotRunningError,
  SandboxUnreachableError,
  TimeoutError,
} from 'e2b'
import { shellEscapePosix } from '@theokit/agents/sandbox'
import { describe, expect, it } from 'vitest'

import { E2BBackend, e2bMaxSessionMs, networkFor, SANDBOX_ENV } from './e2b-sandbox'

const spec = (egress: { domain: string; headers?: Record<string, string> }[]) => ({
  egress,
  timeoutMs: 60_000,
})

describe('networkFor', () => {
  it('allows only the listed domains and denies everything else', () => {
    const net = networkFor(spec([{ domain: 'github.com' }, { domain: 'registry.npmjs.org' }]))
    expect(net.allowOut).toEqual(['github.com', 'registry.npmjs.org'])
    expect(net.denyOut).toEqual([ALL_TRAFFIC])
  })

  it('attaches a rule headers outside the sandbox, and only to that domain', () => {
    const net = networkFor(
      spec([
        { domain: 'api.github.com', headers: { authorization: 'token t' } },
        { domain: 'x.dev' },
      ]),
    )
    expect(net.rules).toEqual({
      'api.github.com': [{ transform: { headers: { authorization: 'token t' } } }],
    })
  })
})

describe('e2bMaxSessionMs', () => {
  it('is the free plan hour unless a positive number says otherwise', () => {
    expect(e2bMaxSessionMs({})).toBe(60 * 60_000)
    expect(e2bMaxSessionMs({ E2B_MAX_SESSION_MS: 'soon' })).toBe(60 * 60_000)
    expect(e2bMaxSessionMs({ E2B_MAX_SESSION_MS: '0' })).toBe(60 * 60_000)
    expect(e2bMaxSessionMs({ E2B_MAX_SESSION_MS: '7200000' })).toBe(7_200_000)
  })
})

describe('the sandbox environment', () => {
  it('builds native modules against the headers in the image, since nodejs.org is not allowed', () => {
    expect(SANDBOX_ENV.npm_config_nodedir).toBe('/usr/local')
  })

  it('makes Node trust the egress proxy that attaches credentials', () => {
    expect(SANDBOX_ENV.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/certs/ca-certificates.crt')
  })
})

type Run = (command: string, opts: Record<string, unknown>) => Promise<unknown>
type Connect = (pid: number, opts: Record<string, unknown>) => Promise<unknown>
const PID = 7
/** What E2B throws when the HTTP/2 stream drops while the sandbox still answers its health probe. */
const dropped = () => new SandboxError('2: [unknown] terminated')

/**
 * A fake E2B sandbox. `run` is what waiting on the started command does, `connect` what waiting on a reattached
 * one does, and `files` are the files the command left in its output directory, by name.
 */
const backendThat = (
  run: Run,
  more: {
    connect?: Connect
    files?: Record<string, string>
    write?: (...args: unknown[]) => Promise<unknown>
  } = {},
) => {
  const calls: { command: string; opts: Record<string, unknown> }[] = []
  const connects: { pid: number; opts: Record<string, unknown> }[] = []
  const writes: unknown[][] = []
  const clock = { now: 1_000_000, slept: [] as number[] }
  const { connect = async () => ({}), files = {}, write = async () => ({}) } = more
  const fake = {
    commands: {
      run: async (command: string, opts: Record<string, unknown>) => {
        calls.push({ command, opts })
        return { pid: PID, wait: () => run(command, opts) }
      },
      connect: async (pid: number, opts: Record<string, unknown>) => {
        connects.push({ pid, opts })
        return { pid, wait: () => connect(pid, opts) }
      },
    },
    files: {
      write: (...args: unknown[]) => (writes.push(args), write(...args)),
      read: async (path: string) => {
        const content = files[path.slice(path.lastIndexOf('/') + 1)]
        if (content === undefined) throw new FileNotFoundError(`${path} not found`)
        return content
      },
    },
  }
  const timing = {
    now: () => clock.now,
    sleep: async (ms: number) => {
      clock.slept.push(ms)
      clock.now += ms
    },
  }
  return { backend: new E2BBackend(fake as never, timing), calls, connects, writes, clock }
}

describe('E2BBackend', () => {
  it('runs as the image user in the work directory and returns the output', async () => {
    const { backend, calls } = backendThat(async () => ({
      stdout: 'ok\n',
      stderr: '',
      exitCode: 0,
    }))
    expect(await backend.execute('echo ok', { timeoutMs: 5_000 })).toEqual({
      stdout: 'ok\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    })
    expect(calls[0]?.opts).toMatchObject({
      user: 'node',
      cwd: '/work',
      timeoutMs: 5_000,
      background: true,
    })
  })

  it('returns the real exit code of a command that fails, which E2B throws for', async () => {
    const failed = new CommandExitError({ stdout: 'o', stderr: 'e', exitCode: 3, error: 'exit 3' })
    const { backend } = backendThat(async () => Promise.reject(failed))
    expect(await backend.execute('false')).toEqual({
      stdout: 'o',
      stderr: 'e',
      exitCode: 3,
      timedOut: false,
    })
  })

  it('reports a command that ran out of time as exit 124', async () => {
    const { backend } = backendThat(async () => Promise.reject(new TimeoutError('deadline')))
    expect(await backend.execute('sleep 9', { timeoutMs: 1_000 })).toMatchObject({
      exitCode: 124,
      timedOut: true,
    })
  })

  it('throws when the sandbox itself is gone, rather than calling it a slow command', async () => {
    const { backend, connects } = backendThat(async () =>
      Promise.reject(new SandboxNotRunningError('stopped')),
    )
    await expect(backend.execute('true')).rejects.toBeInstanceOf(SandboxNotRunningError)
    expect(connects).toHaveLength(0)
  })

  it('throws at once when the sandbox cannot be reached, without reattaching', async () => {
    const { backend, connects } = backendThat(async () =>
      Promise.reject(new SandboxUnreachableError('no answer')),
    )
    await expect(backend.execute('true')).rejects.toBeInstanceOf(SandboxUnreachableError)
    expect(connects).toHaveLength(0)
  })

  it('hands the output over line by line while a command runs', async () => {
    const { backend } = backendThat(async (_command, opts) => {
      const onStdout = opts.onStdout as (chunk: string) => void
      onStdout('one\ntw')
      onStdout('o\n')
      return { stdout: 'one\ntwo\n', stderr: '', exitCode: 0 }
    })
    const lines: string[] = []
    await backend.executeStreaming('agent', { onStdoutLine: (line) => lines.push(line) })
    expect(lines).toEqual(['one', 'two'])
  })

  it('removes a file before writing it again, which E2B refuses to overwrite in /tmp', async () => {
    const { backend, calls, writes } = backendThat(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }))
    await backend.uploadFile("/tmp/factory prompt's.md", 'again')
    const rm = `rm -f -- ${shellEscapePosix("/tmp/factory prompt's.md")}`
    expect(calls[0]?.command).toContain(shellEscapePosix(rm))
    expect(writes).toHaveLength(1)
  })

  it('writes a file as the image user, text or bytes', async () => {
    const { backend, writes } = backendThat(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    await backend.uploadFile('/work/a.txt', 'hi')
    await backend.uploadFile('/work/b.bin', Buffer.from([1, 2]))
    expect(writes[0]).toEqual(['/work/a.txt', 'hi', { user: 'node' }])
    expect(new Uint8Array(writes[1]?.[1] as ArrayBuffer)).toEqual(new Uint8Array([1, 2]))
  })
})

describe('E2BBackend after the stream to a running command drops', () => {
  it('reattaches and returns the real exit code and the whole output of the command', async () => {
    const full = '{"type":"start"}\n{"type":"result"}\n'
    const { backend, connects } = backendThat(async () => Promise.reject(dropped()), {
      connect: async () =>
        Promise.reject(
          new CommandExitError({ stdout: '{"type":"result"}\n', stderr: '', exitCode: 3 }),
        ),
      files: { stdout: full, stderr: 'warn\n', exit: '3\n' },
    })
    expect(await backend.execute('claude -p', { timeoutMs: 60_000 })).toEqual({
      stdout: full,
      stderr: 'warn\n',
      exitCode: 3,
      timedOut: false,
    })
    expect(connects.map((c) => c.pid)).toEqual([PID])
  })

  it('reads the exit code the command left when it ended before the reattach', async () => {
    const { backend } = backendThat(async () => Promise.reject(dropped()), {
      connect: async () => Promise.reject(new NotFoundError('process with pid 7 not found')),
      files: { stdout: 'all of it', stderr: '', exit: '0' },
    })
    expect(await backend.execute('npm test')).toEqual({
      stdout: 'all of it',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    })
  })

  it('hands a watcher the lines it missed, after the ones it already had', async () => {
    const { backend } = backendThat(
      async (_command, opts) => {
        ;(opts.onStdout as (chunk: string) => void)('one\ntw')
        throw dropped()
      },
      {
        connect: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        files: { stdout: 'one\ntwo\nthree\n', stderr: '', exit: '0' },
      },
    )
    const lines: string[] = []
    await backend.executeStreaming('agent', { onStdoutLine: (line) => lines.push(line) })
    expect(lines).toEqual(['one', 'two', 'three'])
  })

  it('fails naming the pid and the last error when reattaching keeps failing, within the timeout', async () => {
    const { backend, clock, connects } = backendThat(async () => Promise.reject(dropped()), {
      connect: async () => Promise.reject(dropped()),
    })
    const start = clock.now
    const failure = backend.execute('claude -p', { timeoutMs: 60_000 })
    await expect(failure).rejects.toThrow(/pid 7/)
    await expect(failure).rejects.toThrow(/2: \[unknown\] terminated/)
    expect(connects.length).toBeGreaterThan(1)
    expect(clock.now - start).toBeLessThanOrEqual(60_000)
  })

  it('gives each reattach only the time the command has left', async () => {
    const { backend, connects, clock } = backendThat(async () => Promise.reject(dropped()), {
      connect: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      files: { stdout: '', stderr: '', exit: '0' },
    })
    await backend.execute('true', { timeoutMs: 60_000 })
    expect(connects[0]?.opts.timeoutMs).toBe(60_000 - (clock.slept[0] ?? 0))
  })

  it('still fails at once when the sandbox stopped', async () => {
    const { backend, connects } = backendThat(async () => Promise.reject(dropped()), {
      connect: async () => Promise.reject(new SandboxNotRunningError('stopped')),
    })
    await expect(backend.execute('true')).rejects.toBeInstanceOf(SandboxNotRunningError)
    expect(connects).toHaveLength(1)
  })

  it('reports a reattached command that runs out of time as exit 124, as before', async () => {
    const { backend } = backendThat(async () => Promise.reject(dropped()), {
      connect: async () => Promise.reject(new TimeoutError('deadline')),
    })
    expect(await backend.execute('sleep 99', { timeoutMs: 5_000 })).toMatchObject({
      exitCode: 124,
      timedOut: true,
    })
  })

  it('fails loudly when the command is gone and left no exit code', async () => {
    const { backend } = backendThat(async () => Promise.reject(dropped()), {
      connect: async () => Promise.reject(new NotFoundError('process with pid 7 not found')),
      files: { stdout: 'partial', stderr: '' },
    })
    await expect(backend.execute('true')).rejects.toThrow(/pid 7.*exit code/)
  })

  it('does not reattach on another error E2B has no class for', async () => {
    const { backend, connects } = backendThat(async () =>
      Promise.reject(new SandboxError('2: [unknown] something else')),
    )
    await expect(backend.execute('true')).rejects.toThrow('something else')
    expect(connects).toHaveLength(0)
  })
})
