import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const homes = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/**
 * Runs the real deploy script from a copy of the repository layout, with every outside command replaced by
 * one that writes down how it was called. `busy` is what the database says about working tasks.
 */
function deploy({ busy = '0', enabledWorkers = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-test-'))
  homes.push(root)
  mkdirSync(join(root, 'scripts'))
  copyFileSync(new URL('./deploy.sh', import.meta.url), join(root, 'scripts', 'deploy.sh'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const calls = join(root, 'calls.log')
  const fake = (name, body = '') => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${calls}\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  fake('docker', `echo ${busy}`)
  fake('pnpm')
  // `list-dependencies` answers with the units the boot target wants, which is where an enabled worker is.
  const wanted = ['aifactory.service', ...enabledWorkers, 'aifactory-tunnel.service'].join('\\n')
  fake('systemctl', `case "$*" in *list-dependencies*) printf '${wanted}\\n' ;; esac`)
  fake('curl')
  fake('journalctl')
  const run = spawnSync('bash', [join(root, 'scripts', 'deploy.sh')], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  })
  const code = run.status
  const output = `${run.stdout}${run.stderr}`
  const log = readFileSync(calls, 'utf8').trim().split('\n')
  return { code, output, systemctl: log.filter((l) => l.startsWith('systemctl ')) }
}

describe('the deploy script', () => {
  it('restarts the server, and the feeder only when it is running, after the build', () => {
    const { code, systemctl } = deploy()

    expect(code).toBe(0)
    expect(systemctl).toContain('systemctl --user restart aifactory.service')
    // The feeder opens issues in real repositories, so a deploy never starts it.
    expect(systemctl).toContain('systemctl --user try-restart aifactory-feeder.service')
  })

  it('starts every enabled worker, including one that was stopped', () => {
    const { code, systemctl } = deploy({
      enabledWorkers: ['aifactory-worker@1.service', 'aifactory-worker@2.service'],
    })

    expect(code).toBe(0)
    // try-restart left a stopped worker stopped, and the factory ran fewer tasks at once without saying so.
    expect(systemctl).toContain(
      'systemctl --user restart aifactory-worker@1.service aifactory-worker@2.service',
    )
  })

  it('touches no worker when none is enabled', () => {
    const { code, systemctl } = deploy()

    expect(code).toBe(0)
    expect(systemctl.filter((l) => l.includes('aifactory-worker@'))).toEqual([])
  })

  it('restarts while a task is working, and says the restart waits for it', () => {
    const { code, systemctl, output } = deploy({ busy: '2' })

    expect(code).toBe(0)
    expect(systemctl).toContain('systemctl --user restart aifactory.service')
    expect(output).toMatch(/2 task\(s\) are working; the restart waits for them to finish/)
  })
})
