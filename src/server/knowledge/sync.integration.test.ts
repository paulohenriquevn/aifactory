import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, knowledgeNote, repository, task } from '../db/schema'

import { MEMORY_BRANCH } from './format'
import { runGit } from './git'
import { Mirror } from './mirror'
import { conformance } from './okf'
import { knowledgePass } from './pass'
import { KnowledgeReader, NO_KNOWLEDGE } from './reader'
import { knowledgeSource } from './source'
import { currentPin, loadKnowledgeConfig, loadSyncState, recordNotes } from './store'
import {
  KnowledgeRefused,
  knowledgeStatus,
  proposeTemplate,
  saveKnowledge,
  syncKnowledge,
  TEMPLATE_BRANCH,
  type KnowledgeDeps,
} from './sync'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table knowledge_note, knowledge_delivery, setting, stage_event, task, ingress restart identity cascade',
  )
})
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})
afterAll(() => getStorageManager().dispose())

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-sync-'))
  dirs.push(dir)
  return dir
}
const author = { name: 'factory[bot]', email: 'factory@example.com' }
const INDEX = '---\nokf_version: "0.2"\n---\n\n# Rules\n'

/** A knowledge repository the factory reaches at a local path, with these files on `main`. */
async function knowledgeRepo(files: { path: string; content: string }[]) {
  const remote = join(scratch(), 'kb.git')
  await runGit(['init', '--bare', '--quiet', remote])
  const writer = new Mirror(join(scratch(), 'writer.git'))
  await writer.ensure()
  const commit = await writer.commit({ files, message: 'first', author, date: new Date() })
  await writer.push(remote, commit, 'main')
  return { remote, commit, writer }
}

/** The clock of every test: the sync is told it, and the notes are dated by it. */
const CLOCK = '2026-11-06T12:00:00Z'

/** Keeps notes as a run does, dated by the test's clock instead of the database's, which would move the day. */
async function keep(notes: Parameters<typeof recordNotes>[1]) {
  const kept = await recordNotes(getDb(), notes)
  await getPool().query('update knowledge_note set created_at = $1', [CLOCK])
  return kept
}

function deps(remote: string, over: Partial<KnowledgeDeps> = {}) {
  const pulls: { head: string; base?: string; title: string; body: string }[] = []
  const d: KnowledgeDeps = {
    db: getDb(),
    github: {
      installationToken: async (repo) => {
        if (repo === 'me/nowhere') throw new Error('the GitHub App is not installed on me/nowhere')
        return { token: 'ghs_test', expiresAt: new Date(Date.now() + 3_600_000) }
      },
    },
    api: {
      defaultBranch: async () => 'main',
      branchHead: async (_repo, _token, branch) =>
        (
          await runGit([
            '-C',
            remote,
            'rev-parse',
            '--verify',
            '--quiet',
            `refs/heads/${branch}`,
          ]).catch(() => Buffer.from(''))
        )
          .toString()
          .trim() || undefined,
      openPullRequest: async (_repo, _token, pull) => {
        pulls.push(pull)
        return { number: 1, url: 'https://github.com/me/kb/pull/1' }
      },
    },
    root: scratch(),
    remote: () => remote,
    author,
    templateDir: 'templates/knowledge',
    now: () => new Date(CLOCK),
    ...over,
  }
  return { d, pulls }
}

let issue = 0
async function aTask(repository = 'acme/app') {
  const [i] = await getDb()
    .insert(ingress)
    .values({
      deliveryId: `k-${++issue}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'test',
    })
    .returning()
  const [t] = await getDb()
    .insert(task)
    .values({ ingressId: i.id, repository, issueNumber: issue, issueTitle: `Issue ${issue}` })
    .returning()
  return t
}

const note = (taskId: number, body: string, repository = 'acme/app') => ({
  repository,
  kind: 'learned' as const,
  body,
  taskId,
  issueNumber: 1,
  baseSha: null,
})

const remoteFile = async (remote: string, ref: string, path: string) =>
  (await runGit(['-C', remote, 'show', `${ref}:${path}`])).toString()

describe('choosing the knowledge repository', () => {
  it('refuses a name GitHub does not take', async () => {
    const { remote } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    await expect(saveKnowledge(deps(remote).d, { repository: 'not a repo' })).rejects.toThrow(
      KnowledgeRefused,
    )
  })

  it("refuses the factory's own branch as the branch of the rules", async () => {
    const { remote } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    await expect(
      saveKnowledge(deps(remote).d, { repository: 'me/kb', branch: MEMORY_BRANCH }),
    ).rejects.toThrow(/branch the factory writes its notes to/)
  })

  it('refuses a repository the factory works on, so an agent never changes the rules it is held to', async () => {
    const { remote } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    await getDb().insert(repository).values({ fullName: 'Me/KB', enabled: true })
    try {
      await expect(saveKnowledge(deps(remote).d, { repository: 'me/kb' })).rejects.toThrow(
        /Me\/KB is enabled as a project of the factory; disable it on the Repositories page first/,
      )
      expect(await loadKnowledgeConfig(getDb())).toBeUndefined()
    } finally {
      await getPool().query('truncate table repository restart identity cascade')
    }
  })

  it('takes a repository the factory knows but does not work on', async () => {
    const { remote } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    await getDb().insert(repository).values({ fullName: 'me/kb', enabled: false })
    try {
      expect((await saveKnowledge(deps(remote).d, { repository: 'me/kb' })).repository).toBe(
        'me/kb',
      )
    } finally {
      await getPool().query('truncate table repository restart identity cascade')
    }
  })

  it('refuses a repository the App does not reach, and says why', async () => {
    const { remote } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    await expect(saveKnowledge(deps(remote).d, { repository: 'me/nowhere' })).rejects.toThrow(
      /cannot reach me\/nowhere: the GitHub App is not installed/,
    )
  })

  it('refuses a branch that does not exist, and an empty repository', async () => {
    const { remote } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    await expect(
      saveKnowledge(deps(remote).d, { repository: 'me/kb', branch: 'rules' }),
    ).rejects.toThrow(/has no branch rules/)
    const empty = join(scratch(), 'empty.git')
    await runGit(['init', '--bare', '--quiet', empty])
    await expect(saveKnowledge(deps(empty).d, { repository: 'me/kb' })).rejects.toThrow(
      /has no commit yet/,
    )
    expect((await knowledgeStatus(getDb())).repository).toBeNull()
  })

  it('syncs at once, so the page shows where the base is', async () => {
    const { remote, commit } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    const status = await saveKnowledge(deps(remote).d, { repository: 'me/kb' })

    expect(status).toMatchObject({
      repository: 'me/kb',
      branch: null,
      readBranch: 'main',
      knowledgeSha: commit,
      memorySha: null,
      okfProblems: [],
      error: null,
      syncedAt: '2026-11-06T12:00:00.000Z',
    })
    expect(await currentPin(getDb())).toEqual({ repository: 'me/kb', knowledgeSha: commit })
  })

  it('clears the choice, and no agent receives a base after that', async () => {
    const { remote } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    await saveKnowledge(deps(remote).d, { repository: 'me/kb' })
    await saveKnowledge(deps(remote).d, { repository: null })

    expect((await knowledgeStatus(getDb())).repository).toBeNull()
    expect(await currentPin(getDb())).toBeUndefined()
  })
})

describe('the sync of every minute', () => {
  it('does nothing while no repository is chosen', async () => {
    const { remote } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    expect(await syncKnowledge(deps(remote).d)).toBeUndefined()
  })

  it('gives agents a repository that does not conform to OKF, and says what does not', async () => {
    const { remote, commit } = await knowledgeRepo([
      { path: 'README.md', content: '# notes' },
      { path: 'knowledge/global/a.md', content: '---\ntype: Rule\n---\nok' },
    ])
    const status = await saveKnowledge(deps(remote).d, { repository: 'me/kb' })

    expect(status.okfProblems).toEqual([
      'index.md is missing at the root',
      'README.md has no front matter',
    ])
    expect(await currentPin(getDb())).toEqual({ repository: 'me/kb', knowledgeSha: commit })
  })

  it('checks the rules once per commit, and again when they move', async () => {
    const { remote, commit, writer } = await knowledgeRepo([{ path: 'a.md', content: 'x' }])
    const { d } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })
    const fixed = await writer.commit({
      parent: commit,
      files: [
        { path: 'index.md', content: INDEX },
        { path: 'a.md', content: '---\ntype: Rule\n---\nx' },
      ],
      message: 'conform',
      author,
      date: new Date(),
    })
    const read = vi.spyOn(Mirror.prototype, 'read')
    await syncKnowledge(d)
    const first = read.mock.calls.length
    await writer.push(remote, fixed, 'main')
    await syncKnowledge(d)

    expect(first).toBe(0)
    expect(read.mock.calls.length).toBeGreaterThan(0)
    expect((await knowledgeStatus(getDb())).okfProblems).toEqual([])
  })

  it('keeps at most fifty problems and says how many more there are', async () => {
    const files = Array.from({ length: 52 }, (_, i) => ({ path: `n${i}.md`, content: 'x' }))
    const { remote } = await knowledgeRepo([{ path: 'index.md', content: INDEX }, ...files])
    const status = await saveKnowledge(deps(remote).d, { repository: 'me/kb' })

    expect(status.okfProblems).toHaveLength(51)
    expect(status.okfProblems[50]).toBe('and 2 more')
  })

  it('follows the rules branch as it moves', async () => {
    const { remote, commit, writer } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    const { d } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })
    const next = await writer.commit({
      parent: commit,
      files: [{ path: 'knowledge/global/tests.md', content: 'write the test first' }],
      message: 'a rule',
      author,
      date: new Date(),
    })
    await writer.push(remote, next, 'main')

    expect((await syncKnowledge(d))?.knowledgeSha).toBe(next)
  })

  it('writes the kept notes to the memory branch with the index of each project, once', async () => {
    const { remote } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    const { d } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })
    const t = await aTask()
    await keep([note(t.id, 'The tests need corepack enable first.')])
    await keep([note(t.id, 'The tests  need corepack enable first.')])

    const state = await syncKnowledge(d)

    const head = (await runGit(['-C', remote, 'rev-parse', MEMORY_BRANCH])).toString().trim()
    expect(state?.memorySha).toBe(head)
    const index = await remoteFile(remote, MEMORY_BRANCH, 'memory/projects/acme/app/index.md')
    expect(index).toBe(
      '# Observations on acme/app\n\n* [Learned on issue #1](2026-11-06-learned-1.md) - The tests need corepack enable first.\n',
    )
    expect(await remoteFile(remote, MEMORY_BRANCH, 'memory/projects/acme/app/log.md')).toBe(
      '# Observations on acme/app: update log\n\n## 2026-11-06\n* **Creation**: [Learned on issue #1](2026-11-06-learned-1.md).\n',
    )
    expect(await remoteFile(remote, MEMORY_BRANCH, 'index.md')).toContain(
      '* [acme/app](memory/projects/acme/app/index.md)',
    )
    const memory = await new Mirror(join(d.root, 'me/kb.git')).list(head, ['.'])
    const texts = await Promise.all(
      memory.map(async (f) => ({
        path: f.path,
        text: await remoteFile(remote, MEMORY_BRANCH, f.path),
      })),
    )
    expect(conformance(texts.find((f) => f.path === 'index.md')?.text, texts)).toEqual([])
    const rows = await getDb().select().from(knowledgeNote)
    expect(rows).toHaveLength(1)
    expect(rows[0].committedSha).toBe(head)
    // The rules branch is never written.
    expect(await remoteFile(remote, 'main', 'index.md')).toBe(INDEX)
  })

  it('keeps the earlier notes in the index when it writes new ones', async () => {
    const { remote } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    const { d } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })
    const t = await aTask()
    await keep([note(t.id, 'The first fact about this repository.')])
    await syncKnowledge(d)
    await keep([note(t.id, 'The second fact about this repository.')])
    await syncKnowledge(d)

    const index = await remoteFile(remote, MEMORY_BRANCH, 'memory/projects/acme/app/index.md')
    expect(index).toContain('The first fact')
    expect(index).toContain('The second fact')
    const log = await remoteFile(remote, MEMORY_BRANCH, 'memory/projects/acme/app/log.md')
    expect(log.match(/\*\*Creation\*\*/g)).toHaveLength(2)
    expect(log.match(/## 2026-11-06/g)).toHaveLength(1)
    expect((await knowledgeStatus(getDb())).writtenNotes).toBe(2)
  })

  it('keeps the notes pending and the last good commits when the remote refuses the write', async () => {
    const { remote, commit } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    const { d } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })
    const hook = join(remote, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/bin/sh\necho "protected" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    const t = await aTask()
    await keep([note(t.id, 'A fact the remote will not take today.')])

    await expect(syncKnowledge(d)).rejects.toThrow(/protected/)

    const status = await knowledgeStatus(getDb())
    expect(status.pendingNotes).toBe(1)
    expect(status.knowledgeSha).toBe(commit)
    expect(status.error).toMatch(/git push exited 1/)
    expect(await currentPin(getDb())).toEqual({ repository: 'me/kb', knowledgeSha: commit })
  })

  it('clears the error once a pass succeeds', async () => {
    const { remote } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    const { d } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })
    await expect(syncKnowledge({ ...d, remote: () => join(remote, 'missing') })).rejects.toThrow()
    expect((await loadSyncState(getDb()))?.error).toBeTruthy()

    await syncKnowledge(d)
    expect((await knowledgeStatus(getDb())).error).toBeNull()
  })
})

describe('the slice an agent receives', () => {
  it('has the global rules and its own project, and nothing of another project', async () => {
    const { remote } = await knowledgeRepo([
      { path: 'index.md', content: INDEX },
      { path: 'knowledge/global/tests.md', content: 'tests first' },
      { path: 'knowledge/projects/acme/app/build.md', content: 'pnpm build' },
      { path: 'knowledge/projects/acme/web/secret.md', content: 'not yours' },
      { path: 'other/top.md', content: 'not in the format' },
    ])
    const { d } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })
    const t = await aTask()
    await keep([
      note(t.id, 'A note about the app project.'),
      note(t.id, 'A note about the web project.', 'acme/web'),
    ])
    await syncKnowledge(d)

    const source = knowledgeSource(getDb(), d.root)
    const pin = await source.pin()
    const slice = await source.slice(pin!, 'acme/app')

    expect(slice.files.map((f) => f.path)).toEqual([
      'knowledge/global/tests.md',
      'knowledge/projects/acme/app/build.md',
      'memory/projects/acme/app/index.md',
      'memory/projects/acme/app/2026-11-06-learned-1.md',
      'memory/projects/acme/app/log.md',
    ])
    expect(slice.left).toEqual([])
  })
})

describe('the base as the assistants read it', () => {
  it('says no base is ready before one is chosen', async () => {
    expect(await new KnowledgeReader(getDb(), scratch()).search('tests')).toBe(NO_KNOWLEDGE)
  })

  it('finds lines in the rules and the notes, saying which is which', async () => {
    const { remote } = await knowledgeRepo([
      { path: 'index.md', content: INDEX },
      { path: 'knowledge/global/tests.md', content: '# Tests\nRun the tests with pnpm test.\n' },
    ])
    const { d } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })
    const t = await aTask()
    await keep([note(t.id, 'The tests of acme/app need a database.')])
    await syncKnowledge(d)
    const reader = new KnowledgeReader(getDb(), d.root)

    const found = await reader.search('THE tests')
    expect(found).toContain('knowledge/global/tests.md:2 (rule): Run the tests with pnpm test.')
    expect(found).toMatch(
      /memory\/projects\/acme\/app\/2026-11-06-learned-1\.md:\d+ \(note, a hint\)/,
    )
    expect(await reader.search('tests', 'acme/web')).not.toContain('memory/projects/acme/app')
    expect(await reader.read('knowledge/global/tests.md')).toContain(
      'knowledge/global/tests.md (rule)',
    )
    expect(await reader.read('memory/projects/acme/app/index.md')).toContain('(note, a hint)')
    expect(await reader.read('../etc/passwd')).toMatch(/^Not a path in the base/)
    expect(await reader.read('knowledge/none.md')).toBe(
      'knowledge/none.md is not in the knowledge base.',
    )
  })
})

describe('proposing the OKF structure', () => {
  it('opens a pull request with the missing files and the missing front matter, changing no line', async () => {
    const { remote } = await knowledgeRepo([
      { path: 'README.md', content: '# My notes\n' },
      { path: 'knowledge/global/tests.md', content: '# Tests\nWrite them first.\n' },
      { path: 'knowledge/global/ok.md', content: '---\ntype: Rule\n---\nfine' },
    ])
    const { d, pulls } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })

    const proposed = await proposeTemplate(d)

    expect(proposed.url).toBe('https://github.com/me/kb/pull/1')
    expect(proposed.files).toEqual([
      'index.md',
      'knowledge/global/index.md',
      'knowledge/projects/index.md',
      'README.md',
      'knowledge/global/tests.md',
    ])
    expect(pulls[0]).toMatchObject({ head: TEMPLATE_BRANCH, base: 'main' })
    expect(await remoteFile(remote, TEMPLATE_BRANCH, 'README.md')).toBe(
      '---\ntype: Reference\n---\n\n# My notes\n',
    )
    expect(await remoteFile(remote, TEMPLATE_BRANCH, 'knowledge/global/tests.md')).toBe(
      '---\ntype: Rule\n---\n\n# Tests\nWrite them first.\n',
    )
    expect(await remoteFile(remote, TEMPLATE_BRANCH, 'index.md')).toContain('okf_version: "0.2"')
    expect(await remoteFile(remote, 'main', 'README.md')).toBe('# My notes\n')
  })

  it("adds the version to the owner's own index instead of replacing it", async () => {
    const { remote } = await knowledgeRepo([{ path: 'index.md', content: '# My index\n' }])
    const { d } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })
    await proposeTemplate(d)

    expect(await remoteFile(remote, TEMPLATE_BRANCH, 'index.md')).toBe(
      '---\nokf_version: "0.2"\n---\n\n# My index\n',
    )
  })

  it('names in the pull request what only a person can fix', async () => {
    const { remote } = await knowledgeRepo([
      { path: 'index.md', content: INDEX },
      { path: 'knowledge/global/broken.md', content: '---\ntitle: [x\n---\n' },
    ])
    const { d, pulls } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })
    await proposeTemplate(d)

    expect(pulls[0].body).toMatch(
      /`knowledge\/global\/broken\.md` has front matter that is not YAML/,
    )
  })

  it('refuses when the repository already conforms', async () => {
    const { remote } = await knowledgeRepo([
      { path: 'index.md', content: INDEX },
      { path: 'README.md', content: '---\ntype: Reference\n---\nx' },
      { path: 'knowledge/global/index.md', content: '# Rules\n' },
      { path: 'knowledge/projects/index.md', content: '# Rules\n' },
    ])
    const { d } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })
    await expect(proposeTemplate(d)).rejects.toThrow(/already an OKF 0\.2 bundle/)
  })

  it('refuses, naming them, when all that is left needs a person', async () => {
    const { remote } = await knowledgeRepo([
      { path: 'index.md', content: '---\nokf_version: "0.1"\n---\n' },
      { path: 'README.md', content: '---\ntype: Reference\n---\nx' },
      { path: 'knowledge/global/index.md', content: '# Rules\n' },
      { path: 'knowledge/projects/index.md', content: '# Rules\n' },
    ])
    const { d } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })
    await expect(proposeTemplate(d)).rejects.toThrow(
      /nothing the factory can fix: `index\.md` says okf_version 0\.1/,
    )
  })
})

describe('one pass of the cron', () => {
  const logs = () => {
    const lines: { level: string; event: Record<string, unknown> }[] = []
    const push = (level: string) => (line: string) =>
      lines.push({ level, event: JSON.parse(line) as Record<string, unknown> })
    return { lines, log: { info: push('info'), error: push('error') } }
  }

  it('says where the base is after a pass', async () => {
    const { remote, commit } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    const { d } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })
    const { lines, log } = logs()

    await knowledgePass(() => d, log)

    expect(lines).toEqual([
      {
        level: 'info',
        event: {
          event: 'knowledge_sync',
          repository: 'me/kb',
          knowledgeSha: commit,
          memorySha: null,
          okfProblems: 0,
        },
      },
    ])
  })

  it('says how many things in the rules do not conform to OKF', async () => {
    const { remote } = await knowledgeRepo([{ path: 'README.md', content: 'x' }])
    const { d } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })
    const { lines, log } = logs()

    await knowledgePass(() => d, log)

    expect(lines[0].event.okfProblems).toBe(2)
  })

  it('logs nothing while no repository is chosen', async () => {
    const { remote } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    const { lines, log } = logs()
    await knowledgePass(() => deps(remote).d, log)
    expect(lines).toEqual([])
  })

  it('logs a pass that failed, without throwing out of the cron', async () => {
    const { remote } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    const { d } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })
    const { lines, log } = logs()

    await knowledgePass(() => ({ ...d, remote: () => join(remote, 'gone') }), log)

    expect(lines[0]).toMatchObject({ level: 'error', event: { event: 'knowledge_sync_failed' } })
  })

  it('skips a pass while the last one is still running, instead of piling them up', async () => {
    const { remote } = await knowledgeRepo([{ path: 'index.md', content: INDEX }])
    const { d } = deps(remote)
    await saveKnowledge(d, { repository: 'me/kb' })
    const { lines, log } = logs()

    await Promise.all([knowledgePass(() => d, log), knowledgePass(() => d, log)])

    expect(lines.map((l) => l.event.event).sort()).toEqual([
      'knowledge_sync',
      'knowledge_sync_skipped',
    ])
  })

  it('says the factory is not configured when its dependencies cannot be built', async () => {
    const { lines, log } = logs()
    await knowledgePass(() => {
      throw new Error('GITHUB_APP_SLUG is not set')
    }, log)
    expect(lines).toEqual([
      {
        level: 'error',
        event: {
          event: 'knowledge_sync_not_configured',
          error: 'Error: GITHUB_APP_SLUG is not set',
        },
      },
    ])
  })
})
