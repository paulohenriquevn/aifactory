import { describe, expect, it } from 'vitest'

import { FakeBackend } from './fake-sandbox'
import { gate, runChecks } from './evidence'

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

    expect(backend.commands).toEqual(['cd /work/repo && npm test', 'cd /work/repo && npm run lint'])
    expect(results.map((r) => [r.name, r.passed, r.exitCode])).toEqual([
      ['test', false, 1],
      ['lint', true, 0],
    ])
    expect(results[0].output).toBe('not ok 1boom')
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
