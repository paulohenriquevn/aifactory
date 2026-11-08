import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import { TOKEN_LIFE_LEFT_MS } from '../github/app'
import { JOB_SHUTDOWN_WAIT_MS } from './drain'
import { DEFAULT_TIMEOUTS } from './run'

// A restart must let the run in progress finish (usetheokit/theokit#1292). Four places have to agree on that,
// and each one alone looks right; these tests fail when one of them drifts from the others.
const unit = (name: string) => readFileSync(`ops/systemd/${name}`, 'utf8')
const stopTimeoutMs = (text: string) => {
  const match = /^TimeoutStopSec=(\d+)min$/m.exec(text)
  if (!match) throw new Error('the unit sets no TimeoutStopSec in minutes')
  return Number(match[1]) * 60_000
}
// What theokit start still takes after the job: closing storage, then up to 25 s to exit.
const AFTER_THE_JOB_MS = 30_000

describe('a restart of a process that runs tasks', () => {
  it('tells theokit how long to wait, in a key its config schema keeps', async () => {
    // theokit before 0.79 dropped the key without a word, and the types did not catch it either.
    vi.stubEnv('DATABASE_URL', 'postgres://factory:factory@localhost:1/factory')
    vi.stubEnv('FACTORY_JOBS', '')
    vi.resetModules()
    const { default: loaded } = await import('../../../theo.config')
    vi.unstubAllEnvs()

    expect(loaded.jobs?.worker.shutdownTimeoutMs).toBe(JOB_SHUTDOWN_WAIT_MS)
  })

  it('lets a run last long enough for a builder, the checks, a review and a rework', () => {
    expect(DEFAULT_TIMEOUTS.sandboxMs).toBe(50 * 60_000)
  })

  it('ends every run before the GitHub token it took at the start expires, an hour after it was made', () => {
    expect(TOKEN_LIFE_LEFT_MS).toBeGreaterThan(JOB_SHUTDOWN_WAIT_MS)
    expect(TOKEN_LIFE_LEFT_MS).toBeLessThan(60 * 60_000)
  })

  it('waits for a run longer than a run can last, since its sandbox stops it at the latest', () => {
    expect(JOB_SHUTDOWN_WAIT_MS).toBeGreaterThan(DEFAULT_TIMEOUTS.sandboxMs)
  })

  for (const name of ['aifactory.service', 'aifactory-worker@.service']) {
    it(`is not cut short by systemd in ${name}`, () => {
      expect(stopTimeoutMs(unit(name))).toBeGreaterThanOrEqual(
        JOB_SHUTDOWN_WAIT_MS + AFTER_THE_JOB_MS,
      )
    })

    it(`signals only the server in ${name}, so the agent's commands keep running while it drains`, () => {
      expect(unit(name)).toMatch(/^KillMode=mixed$/m)
    })
  }

  it('reaches theokit itself: the script that starts it hands its process over, with no wrapper between', () => {
    const lines = readFileSync('scripts/run-server.sh', 'utf8').trim().split('\n')
    expect(lines.at(-1)).toBe('exec node_modules/.bin/theokit start')
  })
})
