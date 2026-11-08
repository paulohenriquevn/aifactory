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
function deploy({ busy = '0' } = {}) {
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
  fake('systemctl')
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
  it('restarts the server, and the workers and the feeder that are running, after the build', () => {
    const { code, systemctl } = deploy()

    expect(code).toBe(0)
    expect(systemctl).toContain('systemctl --user restart aifactory.service')
    // A worker or a feeder left alone keeps running the code from before the build.
    expect(systemctl).toContain(
      'systemctl --user try-restart aifactory-worker@*.service aifactory-feeder.service',
    )
  })

  it('restarts while a task is working, and says the restart waits for it', () => {
    const { code, systemctl, output } = deploy({ busy: '2' })

    expect(code).toBe(0)
    expect(systemctl).toContain('systemctl --user restart aifactory.service')
    expect(output).toMatch(/2 task\(s\) are working; the restart waits for them to finish/)
  })
})
