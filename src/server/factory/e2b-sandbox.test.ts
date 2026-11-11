import { ALL_TRAFFIC, CommandExitError, SandboxNotRunningError, TimeoutError } from 'e2b'
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
  it('makes Node trust the egress proxy that attaches credentials', () => {
    expect(SANDBOX_ENV.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/certs/ca-certificates.crt')
  })
})

type Run = (command: string, opts: Record<string, unknown>) => Promise<unknown>
const backendThat = (
  run: Run,
  write: (...args: unknown[]) => Promise<unknown> = async () => ({}),
) => {
  const calls: { command: string; opts: Record<string, unknown> }[] = []
  const writes: unknown[][] = []
  const fake = {
    commands: {
      run: (command: string, opts: Record<string, unknown>) => {
        calls.push({ command, opts })
        return run(command, opts)
      },
    },
    files: { write: (...args: unknown[]) => (writes.push(args), write(...args)) },
  }
  return { backend: new E2BBackend(fake as never), calls, writes }
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
    expect(calls[0]?.opts).toMatchObject({ user: 'node', cwd: '/work', timeoutMs: 5_000 })
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
    const { backend } = backendThat(async () =>
      Promise.reject(new SandboxNotRunningError('stopped')),
    )
    await expect(backend.execute('true')).rejects.toBeInstanceOf(SandboxNotRunningError)
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

  it('writes a file as the image user, text or bytes', async () => {
    const { backend, writes } = backendThat(async () => ({}))
    await backend.uploadFile('/work/a.txt', 'hi')
    await backend.uploadFile('/work/b.bin', Buffer.from([1, 2]))
    expect(writes[0]).toEqual(['/work/a.txt', 'hi', { user: 'node' }])
    expect(new Uint8Array(writes[1]?.[1] as ArrayBuffer)).toEqual(new Uint8Array([1, 2]))
  })
})
