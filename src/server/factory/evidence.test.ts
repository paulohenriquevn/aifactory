import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LocalBackend } from '../../test/local-backend'
import { FakeBackend } from './fake-sandbox'
import { failingChecks, gate, installDetail, prepareInstall, runChecks } from './evidence'

const row = (name: string, sha: string, passed: boolean) => ({ name, sha, passed })

describe('gate', () => {
  it('opens when every required check passed on the pushed commit', () => {
    expect(
      gate({
        headSha: 'abc1234',
        required: ['test', 'lint'],
        evidence: [row('test', 'abc1234', true), row('lint', 'abc1234', true)],
      }),
    ).toEqual({ open: true })
  })

  it('stays closed with no evidence, whatever the agent claimed', () => {
    const verdict = gate({ headSha: 'abc1234', required: ['test'], evidence: [] })
    expect(verdict).toEqual({ open: false, reasons: ['no evidence for "test" at abc1234'] })
  })

  it('does not count a green result for another commit', () => {
    const verdict = gate({
      headSha: 'new1234',
      required: ['test'],
      evidence: [row('test', 'old1234', true)],
    })
    expect(verdict.open).toBe(false)
  })

  it('stays closed when one required check is missing or failed', () => {
    const verdict = gate({
      headSha: 'abc1234',
      required: ['test', 'lint', 'types'],
      evidence: [row('test', 'abc1234', true), row('lint', 'abc1234', false)],
    })
    expect(verdict).toEqual({
      open: false,
      reasons: ['"lint" failed at abc1234', 'no evidence for "types" at abc1234'],
    })
  })

  it('reads the latest result of a check that ran again', () => {
    const evidence = [row('test', 'abc1234', false), row('test', 'abc1234', true)]
    expect(gate({ headSha: 'abc1234', required: ['test'], evidence }).open).toBe(true)
    expect(
      gate({ headSha: 'abc1234', required: ['test'], evidence: evidence.reverse() }).open,
    ).toBe(false)
  })

  it('refuses to verify nothing', () => {
    expect(gate({ headSha: 'abc1234', required: [], evidence: [] }).open).toBe(false)
  })
})

describe('failingChecks', () => {
  const result = (name: string, passed: boolean, output = '') => ({
    name,
    command: name,
    exitCode: passed ? 0 : 1,
    timedOut: false,
    passed,
    output,
    durationMs: 1,
  })

  it('names only the checks whose last run failed, once each', () => {
    const results = [
      result('tests', false, 'flaky'),
      result('tests', true),
      result('lint', false, 'first'),
      result('lint', false, 'second'),
      result('types', true),
    ]

    expect(failingChecks(results).map((r) => [r.name, r.output])).toEqual([['lint', 'second']])
  })
})

describe('runChecks', () => {
  it('runs each command in the repository and reports the real exit code', async () => {
    const backend = new FakeBackend((c) =>
      c.endsWith('npm test')
        ? { exitCode: 1, stdout: 'not ok 1', stderr: 'boom' }
        : { stdout: 'fine' },
    )

    const results = await runChecks(
      backend,
      '/work/repo',
      [
        { name: 'test', command: 'npm test' },
        { name: 'lint', command: 'npm run lint' },
      ],
      1_000,
    )

    expect(backend.commands).toEqual([
      'cd /work/repo && npm test',
      'cd /work/repo && npm test',
      'cd /work/repo && npm run lint',
    ])
    expect(results.map((r) => [r.name, r.passed, r.exitCode])).toEqual([
      ['test', false, 1],
      ['test', false, 1],
      ['lint', true, 0],
    ])
    expect(results[0].output).toBe('not ok 1boom')
  })

  it('runs a failed check once more and keeps both results, the second deciding', async () => {
    let runs = 0
    const backend = new FakeBackend(() => (++runs === 1 ? { exitCode: 1, stdout: 'timeout' } : {}))

    const results = await runChecks(backend, '/r', [{ name: 'test', command: 'npm test' }], 1)

    expect(results.map((r) => [r.name, r.passed])).toEqual([
      ['test', false],
      ['test', true],
    ])
  })

  it('does not run again a check that ran out of time', async () => {
    const backend = new FakeBackend(() => ({}))
    let runs = 0
    backend.execute = async () => {
      runs++
      return { stdout: '', stderr: '', exitCode: 124, timedOut: true }
    }

    const results = await runChecks(backend, '/r', [{ name: 'test', command: 'npm test' }], 1)

    expect(runs).toBe(1)
    expect(results).toHaveLength(1)
  })

  it('fails a check that timed out even if it exited 0', async () => {
    const backend = new FakeBackend(() => ({}))
    backend.execute = async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: true })
    const [result] = await runChecks(backend, '/r', [{ name: 'test', command: 'npm test' }], 1)
    expect(result.passed).toBe(false)
  })

  it('keeps only the tail of a long output', async () => {
    const backend = new FakeBackend(() => ({ stdout: 'x'.repeat(10_000) + 'END' }))
    const [result] = await runChecks(backend, '/r', [{ name: 'test', command: 'npm test' }], 1)
    expect(result.output.length).toBe(4_000)
    expect(result.output.endsWith('END')).toBe(true)
  })
})

describe('what the checks default to and how they are timed', () => {
  it('requires `npm test` unless told otherwise', async () => {
    const { DEFAULT_CHECKS } = await import('./evidence')
    expect(DEFAULT_CHECKS).toEqual([{ name: 'test', command: 'npm test' }])
  })

  it('gives each check the time it was allowed, and records how long it really took', async () => {
    const seen: unknown[] = []
    const backend = new FakeBackend(() => ({}))
    backend.execute = (async (_command: string, opts?: unknown) => {
      seen.push(opts)
      return { stdout: '', stderr: '', exitCode: 0 }
    }) as never

    const [result] = await runChecks(backend, '/r', [{ name: 'test', command: 'npm test' }], 1_234)

    expect(seen).toEqual([{ timeoutMs: 1_234 }])
    expect(result.timedOut).toBe(false) // the backend did not say, and silence is not a timeout
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.durationMs).toBeLessThan(5_000)
  })

  it('says why nothing was verified, and cuts the commit to seven characters in what it reports', () => {
    expect(gate({ headSha: 'abc', required: [], evidence: [] })).toEqual({
      open: false,
      reasons: ['no checks are required, so nothing was verified'],
    })
    const long = 'abcdef1234567890'
    expect(
      gate({ headSha: long, required: ['a', 'b'], evidence: [row('b', long, false)] }),
    ).toEqual({
      open: false,
      reasons: ['no evidence for "a" at abcdef1', '"b" failed at abcdef1'],
    })
  })
})

describe('prepareInstall', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** A fresh clone: a tracked lockfile, and dependencies git ignores. */
  function clone(): string {
    const dir = mkdtempSync(join(tmpdir(), 'preinstall-'))
    dirs.push(dir)
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-C',
          dir,
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@e',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        {
          encoding: 'utf8',
        },
      )
    git('init', '-q')
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    git('add', '-A')
    git('commit', '-qm', 'base')
    return dir
  }
  const install = (command: string) => [
    { name: 'install', command },
    { name: 'test', command: 'true' },
  ]
  const CHANGES =
    'echo resolved >> pnpm-lock.yaml && mkdir -p node_modules && touch node_modules/dep && touch generated.txt'

  it('puts back what the install changed in the checkout, so the commit after it holds only the work', async () => {
    const dir = clone()
    const backend = new LocalBackend()

    const done = await prepareInstall(backend, dir, install(CHANGES), 60_000)

    expect(done?.result.passed).toBe(true)
    expect(done?.restored).toEqual(['M pnpm-lock.yaml', '?? generated.txt'])
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('lockfileVersion: 9\n')
    expect(existsSync(join(dir, 'generated.txt'))).toBe(false)
    // What git ignores is what the builder needs to run the tests: it stays.
    expect(existsSync(join(dir, 'node_modules', 'dep'))).toBe(true)

    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'work.ts'), 'export {}\n')
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-C',
          dir,
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@e',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        {
          encoding: 'utf8',
        },
      )
    git('add', '-A')
    git('commit', '-qm', 'work')
    expect(git('show', '--name-only', '--format=', 'HEAD').trim()).toBe('src/work.ts')
  })

  it('puts the checkout back after an install that failed too, and answers the failure', async () => {
    const dir = clone()

    const done = await prepareInstall(
      new LocalBackend(),
      dir,
      install('echo resolved >> pnpm-lock.yaml; echo tarball missing >&2; exit 1'),
      60_000,
    )

    expect(done?.result).toMatchObject({ passed: false, exitCode: 1 })
    expect(done?.result.output).toContain('tarball missing')
    expect(done?.restored).toEqual(['M pnpm-lock.yaml'])
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('lockfileVersion: 9\n')
  })

  it('touches nothing when the install changed nothing git tracks', async () => {
    const backend = new FakeBackend((command) =>
      command.includes('status --porcelain') ? { stdout: '' } : undefined,
    )
    const done = await prepareInstall(backend, '/w/r', install('pnpm install'), 1_000)
    expect(done?.restored).toEqual([])
    expect(backend.commands).toEqual(['cd /w/r && pnpm install', 'git -C /w/r status --porcelain'])
  })

  it('runs nothing for a repository with no install check', async () => {
    const backend = new FakeBackend(() => ({}))
    expect(await prepareInstall(backend, '/w/r', [{ name: 'test', command: 't' }], 1_000)).toBe(
      undefined,
    )
    expect(backend.commands).toEqual([])
  })

  it('answers an install that could not start as a failure', async () => {
    const backend = new FakeBackend((command) => {
      if (command.includes('pnpm install')) throw new Error('sandbox gone')
      return { stdout: '' }
    })
    const done = await prepareInstall(backend, '/w/r', install('pnpm install'), 1_000)
    expect(done?.result).toMatchObject({ passed: false, exitCode: -1, output: 'sandbox gone' })
  })
})

describe('installDetail', () => {
  const result = (output: string, passed: boolean, durationMs = 61_400) => ({
    name: 'install',
    command: 'pnpm install',
    exitCode: passed ? 0 : 1,
    timedOut: false,
    passed,
    output,
    durationMs,
  })

  it('records whether the install passed, its seconds and its last lines', () => {
    const output = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    const detail = installDetail({ result: result(output, false), restored: [] })
    expect(detail).toEqual({
      ok: false,
      seconds: 61,
      tail: Array.from({ length: 15 }, (_, i) => `line ${i + 16}`).join('\n'),
    })
  })

  it('names what it put back, when the install changed the checkout', () => {
    expect(
      installDetail({ result: result('ok\n', true, 400), restored: ['M pnpm-lock.yaml'] }),
    ).toEqual({ ok: true, seconds: 0, tail: 'ok', restored: ['M pnpm-lock.yaml'] })
  })
})
