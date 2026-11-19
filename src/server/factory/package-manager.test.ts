import { describe, expect, it } from 'vitest'

import { prepareDeclaredPackageManager } from './package-manager'

const backendWith = (declared: string, commands: string[]) =>
  ({
    execute: async (command: string) => {
      commands.push(command)
      return { stdout: command.startsWith('node') ? declared : '', stderr: '', exitCode: 0 }
    },
  }) as never

describe('prepareDeclaredPackageManager', () => {
  it('installs the declared version in the user cache, not in COREPACK_HOME', async () => {
    const commands: string[] = []
    await prepareDeclaredPackageManager(backendWith('pnpm@10.34.1\n', commands), '/work/r')
    expect(commands[1]).toBe('cd /work/r && env -u COREPACK_HOME corepack install')
  })

  it('does nothing for a repository that declares none', async () => {
    const commands: string[] = []
    await prepareDeclaredPackageManager(backendWith('\n', commands), '/work/r')
    expect(commands).toHaveLength(1)
  })
})
