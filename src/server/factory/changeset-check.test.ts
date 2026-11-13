import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { commit } from '../../test/diverged-repository'

import { CHANGESET_CHECK_SCRIPT, uploadChangesetCheck } from './changeset-check'
import { CHANGESET_CHECK_PATH, withChangesetCheck } from './changesets'
import { FakeBackend } from './fake-sandbox'

// Every case makes a real repository and runs the script with node, which is slow on a busy machine.
const SLOW = 60_000

type Files = Record<string, string>

/** A repository like theokit: a private root, a published package, a private app and an ignored one. */
const MONOREPO: Files = {
  'package.json': '{"name":"theokit-monorepo","private":true}',
  '.changeset/config.json': '{"ignore":["@theokit/example-*"]}',
  '.changeset/README.md': 'How changesets work.\n',
  'packages/ui/package.json': '{"name":"@theokit/ui","version":"1.13.0"}',
  'packages/ui/src/index.ts': 'export {}\n',
  'packages/sdk/package.json': '{"name":"@theokit/sdk","version":"5.0.0"}',
  'packages/sdk/src/index.ts': 'export {}\n',
  'apps/theocode/package.json': '{"name":"theocode","private":true}',
  'apps/theocode/src/main.ts': 'export {}\n',
  'examples/chat/package.json': '{"name":"@theokit/example-chat"}',
  'examples/chat/main.ts': 'export {}\n',
  'docs/guide.md': '# Guide\n',
}

const NAMES_UI = '---\n"@theokit/ui": patch\n---\n\nFixes the button.\n'
const EMPTY = '---\n---\n\nA private app changed.\n'

function git(dir: string, ...args: string[]) {
  const run = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
  return run.stdout.trim()
}

/**
 * Runs the check the way a run does: in a clone whose `origin/workspace` is where the work started and
 * whose HEAD is the commit that makes `change`.
 */
function check(change: Files, { start = MONOREPO, since = 'origin/workspace' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'changeset-check-'))
  try {
    git(dir, 'init', '-q', '-b', 'factory/7')
    git(dir, 'update-ref', 'refs/remotes/origin/workspace', commit(dir, start, 'start'))
    commit(dir, change, 'the task')
    const script = join(dir, '..', `${dir.split('/').at(-1)}.mjs`)
    writeFileSync(script, CHANGESET_CHECK_SCRIPT)
    const run = spawnSync('node', [script, since], { cwd: dir, encoding: 'utf8' })
    rmSync(script)
    return { exitCode: run.status, output: `${run.stdout}${run.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the changeset check', () => {
  it(
    'passes a change under a private package with no changeset',
    () => {
      const run = check({ 'apps/theocode/src/main.ts': 'export const a = 1\n' })

      expect(run).toMatchObject({ exitCode: 0 })
      expect(run.output).toContain('no published package changed')
    },
    SLOW,
  )

  it(
    'passes a change under an ignored package, and one in no package, with no changeset',
    () => {
      const run = check({
        'examples/chat/main.ts': 'export const a = 1\n',
        'docs/guide.md': '# Guide\n\nMore.\n',
        'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      })

      expect(run).toMatchObject({ exitCode: 0 })
    },
    SLOW,
  )

  it(
    'fails a change under a published package with no changeset, and names the package and the file',
    () => {
      const run = check({
        'packages/ui/src/index.ts': 'export const a = 1\n',
        'apps/theocode/src/main.ts': 'export const a = 1\n',
      })

      expect(run.exitCode).toBe(1)
      expect(run.output).toContain(
        'error No changeset added since origin/workspace names @theokit/ui, which is published and changed (packages/ui/src/index.ts).',
      )
      expect(run.output).toContain('"@theokit/ui": patch')
      expect(run.output).not.toContain('theocode')
    },
    SLOW,
  )

  it(
    'passes a change under a published package that a changeset added with it names',
    () => {
      const run = check({
        'packages/ui/src/index.ts': 'export const a = 1\n',
        '.changeset/brave-fox.md': NAMES_UI,
      })

      expect(run).toMatchObject({ exitCode: 0 })
      expect(run.output).toContain('@theokit/ui')
    },
    SLOW,
  )

  it(
    'fails a published package no changeset names, though a changeset names another',
    () => {
      const run = check({
        'packages/ui/src/index.ts': 'export const a = 1\n',
        'packages/sdk/src/index.ts': 'export const a = 1\n',
        'packages/sdk/src/more.ts': 'export const b = 1\n',
        'packages/sdk/src/other.ts': 'export const c = 1\n',
        'packages/sdk/src/zeta.ts': 'export const d = 1\n',
        '.changeset/brave-fox.md': NAMES_UI,
      })

      expect(run.exitCode).toBe(1)
      expect(run.output).toContain(
        'names @theokit/sdk, which is published and changed (packages/sdk/src/index.ts, packages/sdk/src/more.ts, packages/sdk/src/other.ts and 1 more).',
      )
      expect(run.output).not.toContain('names @theokit/ui')
    },
    SLOW,
  )

  it(
    'fails a diff that adds an empty changeset, names the file and says to delete it',
    () => {
      const run = check({
        'apps/theocode/src/main.ts': 'export const a = 1\n',
        '.changeset/theocode-fix.md': EMPTY,
      })

      expect(run.exitCode).toBe(1)
      expect(run.output).toContain(
        "error .changeset/theocode-fix.md names no package, so it releases nothing and the release workflow fails on it. Delete it: a change to a private or ignored package needs no changeset, and is recorded in that package's CHANGELOG.md.",
      )
    },
    SLOW,
  )

  it(
    'fails an empty changeset even when another changeset names the published package that changed',
    () => {
      const run = check({
        'packages/ui/src/index.ts': 'export const a = 1\n',
        '.changeset/brave-fox.md': NAMES_UI,
        '.changeset/empty-one.md': '---\n---\n',
      })

      expect(run.exitCode).toBe(1)
      expect(run.output).toContain('error .changeset/empty-one.md names no package')
      expect(run.output).not.toContain('No changeset added')
    },
    SLOW,
  )

  it(
    'reports a published package without a changeset and an empty changeset together',
    () => {
      const run = check({
        'packages/ui/src/index.ts': 'export const a = 1\n',
        '.changeset/empty-one.md': '---\n---\n',
      })

      expect(run.exitCode).toBe(1)
      expect(run.output).toContain('error .changeset/empty-one.md names no package')
      expect(run.output).toContain('names @theokit/ui, which is published and changed')
    },
    SLOW,
  )

  it(
    'judges only what the work added: an empty changeset and a README the integration branch already had pass',
    () => {
      const run = check(
        { 'apps/theocode/src/main.ts': 'export const a = 1\n', '.changeset/README.md': 'New.\n' },
        { start: { ...MONOREPO, '.changeset/old-empty.md': EMPTY } },
      )

      expect(run).toMatchObject({ exitCode: 0 })
    },
    SLOW,
  )

  it(
    'does not take a changeset the integration branch already had as naming what the work changed',
    () => {
      const run = check(
        { 'packages/ui/src/index.ts': 'export const a = 1\n' },
        { start: { ...MONOREPO, '.changeset/earlier.md': NAMES_UI } },
      )

      expect(run.exitCode).toBe(1)
      expect(run.output).toContain('names @theokit/ui')
    },
    SLOW,
  )

  it(
    'does not read a README added to .changeset, or a file below it, as a changeset',
    () => {
      const start = { ...MONOREPO }
      delete start['.changeset/README.md']
      const run = check(
        { '.changeset/README.md': 'How.\n', '.changeset/notes/deep.md': 'Notes.\n' },
        { start },
      )

      expect(run).toMatchObject({ exitCode: 0 })
    },
    SLOW,
  )

  it(
    'counts every file for a repository that is one published package',
    () => {
      const start = {
        'package.json': '{"name":"@theokit/gateways","version":"1.0.0"}',
        '.changeset/config.json': '{}',
        'src/index.ts': 'export {}\n',
      }

      const without = check({ 'README.md': '# Gateways\n' }, { start })
      const named = check(
        {
          'README.md': '# Gateways\n',
          '.changeset/a.md': "---\n'@theokit/gateways': minor\n---\n",
        },
        { start },
      )

      expect(without.exitCode).toBe(1)
      expect(without.output).toContain('names @theokit/gateways')
      expect(named).toMatchObject({ exitCode: 0 })
    },
    SLOW,
  )

  it(
    'takes a file in a fixture as its published package: a changeset naming that package covers it',
    () => {
      const start = {
        ...MONOREPO,
        'packages/ui/fixtures/app/package.json': '{"name":"fixture-app"}',
        'packages/ui/fixtures/app/main.ts': 'export {}\n',
        'packages/ui/fixtures/broken/package.json': '{ not json',
        'packages/ui/fixtures/broken/main.ts': 'export {}\n',
      }
      const change = {
        'packages/ui/fixtures/app/main.ts': 'export const a = 1\n',
        'packages/ui/fixtures/broken/main.ts': 'export const a = 1\n',
      }

      const without = check(change, { start })
      const named = check({ ...change, '.changeset/brave-fox.md': NAMES_UI }, { start })

      expect(without.exitCode).toBe(1)
      expect(without.output).toContain(
        'names @theokit/ui or fixture-app, which is published and changed (packages/ui/fixtures/app/main.ts).',
      )
      expect(without.output).toContain(
        'names @theokit/ui, which is published and changed (packages/ui/fixtures/broken/main.ts).',
      )
      expect(named).toMatchObject({ exitCode: 0 })
    },
    SLOW,
  )

  it(
    'counts a file deleted from a published package',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'changeset-check-'))
      git(dir, 'init', '-q', '-b', 'factory/7')
      git(dir, 'update-ref', 'refs/remotes/origin/workspace', commit(dir, MONOREPO, 'start'))
      rmSync(join(dir, 'packages/sdk/src/index.ts'))
      commit(dir, {}, 'the task')
      const script = `${dir}.mjs`
      writeFileSync(script, CHANGESET_CHECK_SCRIPT)

      const run = spawnSync('node', [script, 'origin/workspace'], { cwd: dir, encoding: 'utf8' })
      rmSync(script)
      rmSync(dir, { recursive: true, force: true })

      expect(run.status).toBe(1)
      expect(run.stderr).toContain('names @theokit/sdk')
    },
    SLOW,
  )

  it(
    'does not pass when it cannot read the range or the config: nothing was verified',
    () => {
      const change = { 'apps/theocode/src/main.ts': 'export const a = 1\n' }

      const noBranch = check(change, { since: 'origin/missing' })
      const noConfig = check(change, {
        start: { ...MONOREPO, '.changeset/config.json': '{ not json' },
      })

      expect(noBranch.exitCode).toBe(2)
      expect(noBranch.output).toContain('error git merge-base origin/missing HEAD failed')
      expect(noBranch.output).toContain('Nothing was verified')
      expect(noConfig.exitCode).toBe(2)
      expect(noConfig.output).toContain('error .changeset/config.json could not be read as JSON')
    },
    SLOW,
  )
})

describe('uploadChangesetCheck', () => {
  const checks = [{ name: 'test', command: 'npm test' }]

  it('writes the script where the check of the factory runs it', async () => {
    const backend = new FakeBackend(() => undefined)

    await uploadChangesetCheck(backend, withChangesetCheck(checks, true, 'workspace'))

    expect([...backend.files]).toEqual([[CHANGESET_CHECK_PATH, CHANGESET_CHECK_SCRIPT]])
  })

  it('writes nothing when no check runs it: no changesets, or a check of the owner', async () => {
    const backend = new FakeBackend(() => undefined)
    const own = [...checks, { name: 'changeset', command: 'pnpm exec changeset status' }]

    await uploadChangesetCheck(backend, checks)
    await uploadChangesetCheck(backend, withChangesetCheck(own, true, 'workspace'))

    expect(backend.files.size).toBe(0)
  })
})
