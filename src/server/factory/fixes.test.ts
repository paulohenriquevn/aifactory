import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LocalBackend } from '../../test/local-backend'
import { FakeBackend } from './fake-sandbox'
import { fixDetail, runFixes } from './fixes'

const run = promisify(execFile)

describe('fixDetail', () => {
  const ran = { command: 'fmt', exitCode: 1, timedOut: false, output: 'bad' }

  it('records nothing for a round with no fixes, or none at all', () => {
    expect(fixDetail(undefined)).toEqual({})
    expect(fixDetail({ sha: 's', outcomes: [] })).toEqual({})
  })

  it('records the outcomes of fixes that made no commit', () => {
    expect(fixDetail({ sha: 's', outcomes: [ran] })).toEqual({ fixes: [ran] })
  })

  it("names only the builder's commit under a fix commit, whose push holds the outcomes", () => {
    expect(fixDetail({ sha: 'fixed', outcomes: [ran], fixedFrom: 'built' })).toEqual({
      fixedFrom: 'built',
    })
  })
})

describe('runFixes', () => {
  it('runs nothing without fixes', async () => {
    const backend = new FakeBackend(() => ({}))
    expect(await runFixes(backend, '/w/r', [], 1000)).toEqual({ outcomes: [], changed: false })
    expect(backend.commands).toEqual([])
  })

  it('does not run a command it could not take a way back for', async () => {
    const backend = new FakeBackend((c) => (c.includes('write-tree') ? { exitCode: 1 } : {}))
    const { outcomes } = await runFixes(backend, '/w/r', ['fmt'], 1000)
    expect(outcomes[0]?.exitCode).toBe(-1)
    expect(backend.commands.some((c) => c.endsWith('&& fmt'))).toBe(false)
  })

  it('throws every fix away and runs no other when a failing fix could not be undone', async () => {
    const backend = new FakeBackend((c) => {
      if (c.includes('write-tree')) return { stdout: 'tree0\n' }
      if (c.endsWith('&& bad')) return { exitCode: 1 }
      if (c.includes('checkout-index')) return { exitCode: 1 }
      return {}
    })
    const round = await runFixes(backend, '/w/r', ['bad', 'next'], 1000)
    expect(round.changed).toBe(false)
    expect(round.outcomes).toHaveLength(1)
    expect(round.outcomes[0]?.restoreFailed).toBe(true)
    expect(backend.commands.slice(-2)).toEqual([
      'git -C /w/r reset -q --hard HEAD',
      'git -C /w/r clean -fdq',
    ])
    expect(backend.commands.some((c) => c.endsWith('&& next'))).toBe(false)
  })

  it('throws when the checkout goes back neither to the snapshot nor to HEAD', async () => {
    const backend = new FakeBackend((c) => {
      if (c.includes('write-tree')) return { stdout: 'tree0\n' }
      if (c.endsWith('&& bad') || c.includes('checkout-index')) return { exitCode: 1 }
      if (c.endsWith('reset -q --hard HEAD')) return { exitCode: 128, stderr: 'index.lock exists' }
      return {}
    })
    await expect(runFixes(backend, '/w/r', ['bad'], 1000)).rejects.toThrow(/index.lock exists/)
  })

  describe('in a real checkout', () => {
    let dir = ''
    const read = (f: string) => readFileSync(join(dir, f), 'utf8')
    const git = (...args: string[]) => run('git', ['-C', dir, ...args]).then((r) => r.stdout)
    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'fixes-'))
      await git('init', '-q')
      await git('config', 'user.email', 'a@b.c')
      await git('config', 'user.name', 'x')
      writeFileSync(join(dir, 'a.txt'), 'a0\n')
      writeFileSync(join(dir, 'b.txt'), 'b0\n')
      await git('add', '-A')
      await git('commit', '-qm', 'base')
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('keeps what a fix that succeeded changed', async () => {
      const round = await runFixes(new LocalBackend(), dir, ['echo a1 > a.txt'], 5000)
      expect(round.outcomes[0]?.exitCode).toBe(0)
      expect(round.changed).toBe(true)
      expect(read('a.txt')).toBe('a1\n')
    })

    it('reports no change when the fixes left the work as it was', async () => {
      const round = await runFixes(new LocalBackend(), dir, ['echo a0 > a.txt'], 5000)
      expect(round.changed).toBe(false)
    })

    it('puts back what a failing fix staged, wrote, deleted and created, and keeps the fix before it', async () => {
      mkdirSync(join(dir, 'sub'))
      const { outcomes } = await runFixes(
        new LocalBackend(),
        dir,
        [
          'echo a1 > a.txt',
          'echo b1 > b.txt && git add b.txt && echo a2 > a.txt && echo n > new.txt && git add new.txt && echo m > sub/m.txt && exit 3',
        ],
        5000,
      )
      expect(outcomes.map((o) => o.exitCode)).toEqual([0, 3])
      expect(read('a.txt')).toBe('a1\n')
      expect(read('b.txt')).toBe('b0\n')
      expect(existsSync(join(dir, 'new.txt'))).toBe(false)
      expect(existsSync(join(dir, 'sub/m.txt'))).toBe(false)
      expect(await git('diff', '--cached', '--name-only')).toBe('')
      expect(await git('status', '--porcelain')).toBe(' M a.txt\n')
    })

    it('does not bring back a file an earlier fix deleted when a later fix fails', async () => {
      await runFixes(new LocalBackend(), dir, ['rm b.txt', 'echo again > b.txt && exit 1'], 5000)
      expect(existsSync(join(dir, 'b.txt'))).toBe(false)
      expect(await git('status', '--porcelain')).toBe(' D b.txt\n')
    })

    it('keeps a tracked file that matches an ignore rule when a fix fails', async () => {
      writeFileSync(join(dir, '.gitignore'), 'dist/\n')
      mkdirSync(join(dir, 'dist'))
      writeFileSync(join(dir, 'dist/kept.js'), 'k0\n')
      await git('add', '.gitignore')
      await git('add', '-f', 'dist/kept.js')
      await git('commit', '-qm', 'tracked, though ignored')

      await runFixes(new LocalBackend(), dir, ['echo k1 > dist/kept.js && exit 1'], 5000)

      expect(read('dist/kept.js')).toBe('k0\n')
      expect(await git('status', '--porcelain')).toBe('')
    })

    it('restores a file a failing fix deleted', async () => {
      await runFixes(new LocalBackend(), dir, ['rm b.txt && exit 1'], 5000)
      expect(read('b.txt')).toBe('b0\n')
    })

    it('runs no fix after one that failed, so what it left in ignored files reaches no other fix', async () => {
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
      await git('add', '.gitignore')
      await git('commit', '-qm', 'ignore the dependencies')
      mkdirSync(join(dir, 'node_modules'))
      writeFileSync(join(dir, 'node_modules/dep.js'), 'v1\n')

      const { outcomes, changed } = await runFixes(
        new LocalBackend(),
        dir,
        ['echo v2 > node_modules/dep.js && exit 1', 'cp node_modules/dep.js a.txt'],
        5000,
      )

      expect(outcomes.map((o) => [o.command.slice(0, 7), o.exitCode])).toEqual([
        ['echo v2', 1],
        ['cp node', -1],
      ])
      expect(outcomes[1]?.output).toBe('not run: an earlier fix failed')
      expect(read('a.txt')).toBe('a0\n')
      expect(changed).toBe(false)
    })
  })
})
