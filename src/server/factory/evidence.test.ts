import { describe, expect, it } from 'vitest'

import { FakeBackend } from './fake-sandbox'
import { failingChecks, gate, runChecks } from './evidence'

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
