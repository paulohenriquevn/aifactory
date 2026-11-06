import { execFileSync } from 'node:child_process'
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
  let code = 0
  try {
    execFileSync('bash', [join(root, 'scripts', 'deploy.sh')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FORCE: '' },
      stdio: 'pipe',
    })
  } catch (error) {
    code = error.status
  }
  const log = readFileSync(calls, 'utf8').trim().split('\n')
  return { code, systemctl: log.filter((l) => l.startsWith('systemctl ')) }
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

  it('restarts nothing while a task is working', () => {
    const { code, systemctl } = deploy({ busy: '2' })

    expect(code).toBe(2)
    expect(systemctl).toEqual([])
  })
})
