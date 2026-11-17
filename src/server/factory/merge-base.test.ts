import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SandboxBackend } from '@theokit/agents/sandbox'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mergeIntegration } from './merge-base'

/** A backend that runs each command in a shell on this machine, as the sandbox runs it in its own. */
const local = {
  async execute(command: string) {
    try {
      const stdout = execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { exitCode: 0, stdout, stderr: '' }
    } catch (error) {
      const failed = error as { status?: number; stdout?: string; stderr?: string }
      return {
        exitCode: failed.status ?? 1,
        stdout: failed.stdout ?? '',
        stderr: failed.stderr ?? '',
      }
    }
  },
} as unknown as SandboxBackend

let dir = ''
const git = () => `git -c user.name=factory -c user.email=factory@example.com -C ${dir}`
const run = (args: string) => execSync(`${git()} ${args}`, { encoding: 'utf8' }).trim()
const write = (file: string, text: string) => writeFileSync(join(dir, file), text)
const commit = (file: string, text: string, message: string) => {
  write(file, text)
  run(`add ${file}`)
  run(`commit -q -m "${message}"`)
  return run('rev-parse HEAD')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'merge-base-'))
  run('init -q -b workspace')
  commit('CHANGELOG.md', '# Changelog\n', 'start')
  run('switch -q -c factory/7')
  commit('src.txt', 'the work\n', 'the work')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** The integration branch moves on with `text` in its changelog, and the work branch is checked out again. */
const baseMoves = (text: string) => {
  run('switch -q workspace')
  const sha = commit('CHANGELOG.md', text, 'the base moves')
  run('switch -q factory/7')
  return sha
}

describe('mergeIntegration', () => {
  it('leaves a head that holds the commit of the integration branch', async () => {
    const base = baseMoves('# Changelog\n\n## 1.0.0\n')

    expect(await mergeIntegration(local, git(), base)).toEqual({ merged: true })

    expect(() => run(`merge-base --is-ancestor ${base} HEAD`)).not.toThrow()
    expect(run('status --porcelain')).toBe('')
  })

  it('says so when the branch already holds that commit, and makes none', async () => {
    run('switch -q workspace')
    const base = run('rev-parse HEAD')
    run('switch -q factory/7')
    const head = run('rev-parse HEAD')

    expect(await mergeIntegration(local, git(), base)).toEqual({ upToDate: true })

    expect(run('rev-parse HEAD')).toBe(head)
  })

  it('names the files that conflict, and leaves the branch as it was', async () => {
    commit('CHANGELOG.md', '# Changelog\n\nthe work\n', 'the work changes the changelog')
    const head = run('rev-parse HEAD')
    const base = baseMoves('# Changelog\n\nthe base\n')

    expect(await mergeIntegration(local, git(), base)).toEqual({ conflicts: ['CHANGELOG.md'] })

    expect(run('rev-parse HEAD')).toBe(head)
    expect(run('status --porcelain')).toBe('')
  })

  it('throws what git said when the merge fails without a conflict', async () => {
    await expect(mergeIntegration(local, git(), 'f'.repeat(40))).rejects.toThrow(/merge/)
  })
})
