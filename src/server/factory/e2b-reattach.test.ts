import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CommandExitError,
  NotFoundError,
  SandboxError,
  SandboxNotRunningError,
  TimeoutError,
} from 'e2b'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CommandStreamLost,
  DROPPED_STREAM,
  isDroppedStream,
  MAX_REATTACH_ATTEMPTS,
  outputFiles,
  reattachDelayMs,
  recordedExitCode,
  waitAfterDrop,
  wrapCommand,
} from './e2b-reattach'

describe('isDroppedStream', () => {
  it('is the bare SandboxError e2b throws for a stream cut short while the sandbox answers', () => {
    expect(isDroppedStream(new SandboxError('2: [unknown] terminated'))).toBe(true)
  })

  it('is not a subclass that carries the same words, such as a timeout', () => {
    expect(isDroppedStream(new TimeoutError(DROPPED_STREAM))).toBe(false)
  })

  it('is not another error e2b has no class for', () => {
    expect(isDroppedStream(new SandboxError('2: [unknown] fetch failed'))).toBe(false)
    expect(isDroppedStream(new SandboxError(`${DROPPED_STREAM} early`))).toBe(false)
  })

  it('is not an error from elsewhere that only looks like one', () => {
    const lookalike = Object.assign(new Error(DROPPED_STREAM), { name: 'SandboxError' })
    expect(isDroppedStream(lookalike)).toBe(false)
    expect(isDroppedStream(DROPPED_STREAM)).toBe(false)
  })
})

describe('reattachDelayMs', () => {
  it('starts at a second and doubles up to fifteen', () => {
    expect([0, 1, 2, 3, 4, 5].map(reattachDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 15_000, 15_000,
    ])
  })
})

describe('recordedExitCode', () => {
  it('reads the number the wrapper wrote', () => {
    expect(recordedExitCode(7, '3\n')).toBe(3)
    expect(recordedExitCode(7, '0')).toBe(0)
    expect(recordedExitCode(7, '130')).toBe(130)
  })

  it('refuses a missing, empty or garbled record, naming the pid', () => {
    for (const written of [undefined, '', ' \n', '3x', '-1']) {
      expect(() => recordedExitCode(7, written)).toThrow(
        'command pid 7 ended without recording its exit code',
      )
    }
  })
})

const dropped = () => new SandboxError(DROPPED_STREAM)

/** A clock that only moves when the reattach sleeps, and a wait that answers from a script. */
const scripted = (answers: (() => Promise<unknown>)[], timeoutMs = 60_000) => {
  const start = 1_000_000
  const clock = { now: start, slept: [] as number[], waits: [] as number[] }
  const deps = {
    deadline: start + timeoutMs,
    now: () => clock.now,
    sleep: async (ms: number) => {
      clock.slept.push(ms)
      clock.now += ms
    },
    wait: async (remaining: number) => {
      clock.waits.push(remaining)
      const next = answers.shift()
      if (!next) throw dropped()
      return next()
    },
  }
  return { deps, clock }
}

describe('waitAfterDrop', () => {
  it('returns once a reattached stream sees the command end', async () => {
    const { deps, clock } = scripted([async () => ({ exitCode: 0 })])
    await waitAfterDrop(7, dropped(), deps)
    expect(clock.slept).toEqual([1_000])
    expect(clock.waits).toEqual([59_000])
  })

  it('takes a non-zero exit as the end of the command', async () => {
    const exited = new CommandExitError({ stdout: '', stderr: '', exitCode: 2 })
    const { deps } = scripted([async () => Promise.reject(exited)])
    await expect(waitAfterDrop(7, dropped(), deps)).resolves.toBeUndefined()
  })

  it('takes a pid e2b no longer knows as a command that already ended', async () => {
    const { deps } = scripted([async () => Promise.reject(new NotFoundError('no pid 7'))])
    await expect(waitAfterDrop(7, dropped(), deps)).resolves.toBeUndefined()
  })

  it('retries a stream that drops again, pausing longer each time', async () => {
    const { deps, clock } = scripted([
      async () => Promise.reject(dropped()),
      async () => Promise.reject(dropped()),
      async () => ({ exitCode: 0 }),
    ])
    await waitAfterDrop(7, dropped(), deps)
    expect(clock.slept).toEqual([1_000, 2_000, 4_000])
    expect(clock.waits).toEqual([59_000, 57_000, 53_000])
  })

  it('gives up after the last attempt, naming the pid, the attempts and the last error', async () => {
    const last = new SandboxError(DROPPED_STREAM)
    const answers = Array.from({ length: MAX_REATTACH_ATTEMPTS }, (_, i) =>
      i === MAX_REATTACH_ATTEMPTS - 1 ? async () => Promise.reject(last) : undefined,
    ).map((answer) => answer ?? (async () => Promise.reject(dropped())))
    const { deps, clock } = scripted(answers, 10 * 60_000)
    const failure = await waitAfterDrop(7, new Error('first'), deps).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(CommandStreamLost)
    expect((failure as Error).message).toBe(
      `the stream to command pid 7 dropped and ${MAX_REATTACH_ATTEMPTS} reattach attempts failed; last error: ${DROPPED_STREAM}`,
    )
    expect((failure as Error).cause).toBe(last)
    expect(clock.waits).toHaveLength(MAX_REATTACH_ATTEMPTS)
  })

  it('never waits past the deadline, and stops when no time is left', async () => {
    const { deps, clock } = scripted([], 3_000)
    const failure = await waitAfterDrop(7, dropped(), deps).catch((e: unknown) => e)
    expect(clock.slept).toEqual([1_000, 2_000])
    expect(clock.waits).toEqual([2_000])
    expect((failure as Error).message).toContain('pid 7 dropped and 1 reattach attempts failed')
    expect(clock.now).toBe(1_003_000)
  })

  it('reports the error that started it when there was no time to reattach at all', async () => {
    const { deps, clock } = scripted([], 500)
    const failure = await waitAfterDrop(7, new Error('the first drop'), deps).catch(
      (e: unknown) => e,
    )
    expect(clock.slept).toEqual([500])
    expect(clock.waits).toEqual([])
    expect((failure as Error).message).toContain(
      '0 reattach attempts failed; last error: the first drop',
    )
  })

  it('says what a thrown value was when it is not an error', async () => {
    const { deps } = scripted([], 0)
    const failure = await waitAfterDrop(7, 'gone', deps).catch((e: unknown) => e)
    expect((failure as Error).message).toContain('last error: gone')
  })

  it('leaves any other error to the caller, at once', async () => {
    for (const error of [new SandboxNotRunningError('stopped'), new TimeoutError('deadline')]) {
      const { deps, clock } = scripted([async () => Promise.reject(error)])
      await expect(waitAfterDrop(7, dropped(), deps)).rejects.toBe(error)
      expect(clock.waits).toHaveLength(1)
    }
  })
})

describe('wrapCommand, run by a real bash', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const runWrapped = (command: string) => {
    dir = mkdtempSync(join(tmpdir(), 'wrap-'))
    const out = join(dir, 'out')
    const ran = spawnSync('bash', ['-c', wrapCommand(command, out)], { encoding: 'utf8' })
    const files = outputFiles(out)
    return { ran, read: (path: string) => readFileSync(path, 'utf8'), files }
  }

  it('streams stdout, keeps every output in files and records the exit code last', () => {
    const { ran, read, files } = runWrapped(
      `echo '{"a":1}'; echo "it's" >&2; printf 'no newline'; exit 3`,
    )
    expect(ran.status).toBe(3)
    expect(ran.stdout).toBe('{"a":1}\nno newline')
    expect(ran.stderr).toBe("it's\n")
    expect(read(files.stdout)).toBe('{"a":1}\nno newline')
    expect(read(files.stderr)).toBe("it's\n")
    expect(read(files.exit)).toBe('3\n')
  })

  it('reports a command that succeeds as exit 0', () => {
    const { ran, read, files } = runWrapped('true')
    expect(ran.status).toBe(0)
    expect(read(files.exit)).toBe('0\n')
  })
})
