import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { gitEnv, KnowledgeGitError, runGit } from './git'
import { Mirror, mirrorDir, PushRejected } from './mirror'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-test-'))
  dirs.push(dir)
  return dir
}

const author = { name: 'factory[bot]', email: 'factory@example.com' }
const at = new Date('2026-11-06T12:00:00Z')

/** A remote with one commit on `main`, written through a mirror of its own. */
async function remoteWith(files: { path: string; content: string }[]) {
  const remote = join(scratch(), 'remote.git')
  await runGit(['init', '--bare', '--quiet', remote])
  const writer = new Mirror(join(scratch(), 'writer.git'))
  await writer.ensure()
  const commit = await writer.commit({ files, message: 'first', author, date: at })
  await writer.push(remote, commit, 'main')
  return { remote, commit, writer }
}

describe('the git of the factory host', () => {
  it('gives the token to github.com as a header, and never as an argument', () => {
    const env = gitEnv({ token: 'ghs_secret' })
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_secret').toString('base64')}`,
    )
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
  })

  it('reads none of the configuration of whoever runs the factory', () => {
    const env = gitEnv()
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(env.GIT_CONFIG_COUNT).toBeUndefined()
  })

  it('says which command failed and what git said', async () => {
    const error = await runGit(['-C', scratch(), 'rev-parse', 'HEAD']).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(KnowledgeGitError)
    expect((error as KnowledgeGitError).command).toBe('rev-parse')
    expect((error as Error).message).toMatch(/git rev-parse exited 128: .*not a git repository/i)
  })
})

describe('the mirror of a knowledge repository', () => {
  it('lives in a folder of its own per repository', () => {
    expect(mirrorDir('/state', 'me/kb')).toBe('/state/me/kb.git')
    expect(() => mirrorDir('/state', '../kb')).toThrow(/owner\/name/)
  })

  it('fetches a branch and reads its files at the commit', async () => {
    const { remote, commit } = await remoteWith([
      { path: 'MEMORY.md', content: 'index' },
      { path: 'knowledge/global/a.md', content: 'rule a' },
      { path: 'knowledge/projects/acme/app/b.md', content: 'rule b' },
    ])
    const mirror = new Mirror(join(scratch(), 'm.git'))
    await mirror.ensure()

    expect(await mirror.fetch(remote, 'main')).toBe(commit)
    expect(await mirror.list(commit, ['MEMORY.md', 'knowledge/global/'])).toEqual([
      { path: 'MEMORY.md', size: 5 },
      { path: 'knowledge/global/a.md', size: 6 },
    ])
    expect((await mirror.read(commit, 'knowledge/projects/acme/app/b.md'))?.toString()).toBe(
      'rule b',
    )
    expect(await mirror.read(commit, 'knowledge/projects/acme/web/b.md')).toBeUndefined()
  })

  it('takes a branch that was rewritten on the remote', async () => {
    const { remote, writer } = await remoteWith([{ path: 'a.md', content: '1' }])
    const mirror = new Mirror(join(scratch(), 'm.git'))
    await mirror.ensure()
    await mirror.fetch(remote, 'main')
    const rewritten = await writer.commit({
      files: [{ path: 'b.md', content: '2' }],
      message: 'other',
      author,
      date: at,
    })
    await writer.push(remote, rewritten, 'main', { force: true })

    expect(await mirror.fetch(remote, 'main')).toBe(rewritten)
  })

  it('gives nothing for a branch the remote does not have, and forgets one the remote deleted', async () => {
    const { remote, commit, writer } = await remoteWith([{ path: 'a.md', content: '1' }])
    await writer.push(remote, commit, 'factory-memory')
    const mirror = new Mirror(join(scratch(), 'm.git'))
    await mirror.ensure()
    expect(await mirror.fetch(remote, 'factory-memory')).toBe(commit)
    await runGit(['-C', remote, 'update-ref', '-d', 'refs/heads/factory-memory'])

    expect(await mirror.fetch(remote, 'factory-memory')).toBeUndefined()
    expect(await mirror.head('factory-memory')).toBeUndefined()
    expect(await mirror.fetch(remote, 'nothing-here')).toBeUndefined()
  })

  it('writes a commit over its parent without a working tree', async () => {
    const { remote, commit } = await remoteWith([{ path: 'keep.md', content: 'kept' }])
    const mirror = new Mirror(join(scratch(), 'm.git'))
    await mirror.ensure()
    await mirror.fetch(remote, 'main')

    const next = await mirror.commit({
      parent: commit,
      files: [{ path: 'memory/projects/acme/app/n.md', content: 'note' }],
      message: 'Record a note',
      author,
      date: at,
    })
    await mirror.push(remote, next, 'main')

    expect((await mirror.list(next, ['.'])).map((f) => f.path)).toEqual([
      'keep.md',
      'memory/projects/acme/app/n.md',
    ])
    const log = (await runGit(['-C', remote, 'log', '-1', '--format=%an|%s|%P', 'main']))
      .toString()
      .trim()
    expect(log).toBe(`factory[bot]|Record a note|${commit}`)
  })

  it('refuses to push over a branch that moved, and says so as a rejection', async () => {
    const { remote, commit, writer } = await remoteWith([{ path: 'a.md', content: '1' }])
    const mirror = new Mirror(join(scratch(), 'm.git'))
    await mirror.ensure()
    await mirror.fetch(remote, 'main')
    const theirs = await writer.commit({
      parent: commit,
      files: [{ path: 'b.md', content: 'x' }],
      message: 'theirs',
      author,
      date: at,
    })
    await writer.push(remote, theirs, 'main')
    const ours = await mirror.commit({
      parent: commit,
      files: [{ path: 'c.md', content: 'y' }],
      message: 'ours',
      author,
      date: at,
    })

    await expect(mirror.push(remote, ours, 'main')).rejects.toBeInstanceOf(PushRejected)
    expect((await runGit(['-C', remote, 'rev-parse', 'main'])).toString().trim()).toBe(theirs)
  })

  it('refuses a branch name git would read as an option, and a value that is not a commit', async () => {
    const mirror = new Mirror(join(scratch(), 'm.git'))
    await mirror.ensure()
    await expect(mirror.fetch('x', '--upload-pack=evil')).rejects.toThrow(/not a branch name/)
    await expect(mirror.list('HEAD', ['.'])).rejects.toThrow(/not a commit id/)
  })
})
