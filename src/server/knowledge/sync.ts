import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import type { KnowledgeStatus } from '../../shared/knowledge'
import type { Database } from '../db'
import { validBranch } from '../factory/repo-config'
import type { GithubApp } from '../github/app'
import type { GithubApi } from '../github/pulls'

import {
  assertRepository,
  checkIndex,
  FORMAT,
  frontMatter,
  indexedNote,
  KnowledgeFormatError,
  MEMORY_BRANCH,
  MEMORY_README,
  notePath,
  renderIndex,
  renderNote,
  type IndexedNote,
  type Note,
} from './format'
import { Mirror, mirrorDir } from './mirror'
import {
  loadKnowledgeConfig,
  loadSyncState,
  markCommitted,
  noteCounts,
  pendingNotes,
  saveSyncState,
  writeKnowledgeConfig,
  type KnowledgeConfig,
  type SyncState,
} from './store'

/** The branch the factory proposes the template from. It is the factory's own, so it may be replaced. */
export const TEMPLATE_BRANCH = 'factory-knowledge-setup'

/** The most notes one pass writes, so a backlog of notes cannot make one pass run for long. */
const NOTES_PER_PASS = 100

/** What the owner has to change before the factory accepts the setting. */
export class KnowledgeRefused extends Error {}

export type KnowledgeDeps = {
  db: Database
  github: Pick<GithubApp, 'installationToken'>
  api: Pick<GithubApi, 'defaultBranch' | 'branchHead' | 'openPullRequest'>
  /** Where the mirrors are kept. */
  root: string
  /** Where the factory reaches a repository; GitHub, but a local path in the tests. */
  remote?: (repository: string) => string
  /** Who the factory's commits are by. */
  author: { name: string; email: string }
  templateDir?: string
  now?: () => Date
}

const githubUrl = (repository: string) => `https://github.com/${repository}.git`
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Where the template ships: `templates/knowledge` beside the factory's code. */
export const defaultTemplateDir = () => resolve(process.cwd(), 'templates/knowledge')

type Context = {
  deps: KnowledgeDeps
  config: KnowledgeConfig
  token: string
  url: string
  mirror: Mirror
  now: Date
}

async function context(deps: KnowledgeDeps, config: KnowledgeConfig): Promise<Context> {
  const { token } = await deps.github.installationToken(config.repository)
  const mirror = new Mirror(mirrorDir(deps.root, config.repository))
  await mirror.ensure()
  return {
    deps,
    config,
    token,
    url: (deps.remote ?? githubUrl)(config.repository),
    mirror,
    now: (deps.now ?? (() => new Date()))(),
  }
}

/** The notes of each project already on the memory branch, as its index lists them. */
async function notesOn(c: Context, memorySha: string | undefined, repository: string) {
  if (!memorySha) return []
  const folder = `memory/projects/${repository}/`
  const listed: IndexedNote[] = []
  for (const file of await c.mirror.list(memorySha, [folder])) {
    if (file.path === `${folder}INDEX.md`) continue
    const text = await c.mirror.read(memorySha, file.path)
    const note = text ? indexedNote(file.path, text.toString('utf8')) : undefined
    if (note) listed.push(note)
  }
  return listed
}

/**
 * Writes the pending notes to the memory branch as one commit with each project's index regenerated, and
 * pushes it as a fast-forward. Returns where the branch is afterwards. A push the remote refused leaves the
 * notes pending for the next pass, which starts from what it fetched.
 */
async function writeNotes(c: Context, memorySha: string | undefined): Promise<string | undefined> {
  const notes = await pendingNotes(c.deps.db, NOTES_PER_PASS)
  if (notes.length === 0) return memorySha
  const byProject = new Map<string, Note[]>()
  for (const note of notes)
    byProject.set(note.repository, [...(byProject.get(note.repository) ?? []), note])

  const files: { path: string; content: string }[] = []
  if (!memorySha) files.push({ path: 'README.md', content: MEMORY_README })
  for (const [project, kept] of byProject) {
    const written = kept.map((note) => ({ path: notePath(note), content: renderNote(note) }))
    files.push(...written)
    const listed = [
      ...(await notesOn(c, memorySha, project)),
      ...written.flatMap((f) => indexedNote(f.path, f.content) ?? []),
    ]
    files.push({
      path: `memory/projects/${project}/INDEX.md`,
      content: renderIndex(project, listed, c.now),
    })
  }
  const commit = await c.mirror.commit({
    parent: memorySha,
    files,
    message: `Record ${notes.length} note(s) from the factory's runs\n\nProjects: ${[...byProject.keys()].join(', ')}\n`,
    author: c.deps.author,
    date: c.now,
  })
  await c.mirror.push(c.url, commit, MEMORY_BRANCH, { token: c.token })
  await c.mirror.setHead(MEMORY_BRANCH, commit)
  await markCommitted(
    c.deps.db,
    notes.map((n) => n.id),
    commit,
    c.now,
  )
  return commit
}

/**
 * One pass: fetches the rules and the memory branch into the mirror, checks the index, writes the pending
 * notes, and records where everything is. A pass that fails records why, keeps the last good commits (the
 * agents go on reading them) and throws.
 */
export async function syncKnowledge(deps: KnowledgeDeps): Promise<SyncState | undefined> {
  const config = await loadKnowledgeConfig(deps.db)
  if (!config) return undefined
  const before = await loadSyncState(deps.db)
  const kept: SyncState =
    before?.repository === config.repository
      ? before
      : { repository: config.repository, branch: config.branch ?? '' }
  try {
    const c = await context(deps, config)
    const branch = config.branch ?? (await deps.api.defaultBranch(config.repository, c.token))
    const knowledgeSha = await c.mirror.fetch(c.url, branch, c.token)
    if (!knowledgeSha) {
      throw new KnowledgeRefused(
        `${config.repository} has no branch ${branch} to read the rules from`,
      )
    }
    const fetchedMemory = await c.mirror.fetch(c.url, MEMORY_BRANCH, c.token)
    const index = await c.mirror.read(knowledgeSha, 'MEMORY.md')
    const format = checkIndex(index?.toString('utf8'))
    const memorySha = await writeNotes(c, fetchedMemory)
    const state: SyncState = {
      repository: config.repository,
      branch,
      knowledgeSha,
      memorySha,
      format,
      syncedAt: c.now.toISOString(),
    }
    await saveSyncState(deps.db, state)
    return state
  } catch (error) {
    await saveSyncState(deps.db, {
      ...kept,
      error: message(error).slice(0, 600),
      errorAt: (deps.now ?? (() => new Date()))().toISOString(),
    })
    throw error
  }
}

let chain: Promise<unknown> = Promise.resolve()

/**
 * The passes of this process one after another: the cron and a save from the panel never fetch or push the
 * same mirror at the same time. Only the main process runs them, so this is the only writer.
 */
export function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work)
  chain = next.catch(() => undefined)
  return next
}

/**
 * Saves the knowledge repository the owner chose, after checking the factory can read it: a name GitHub
 * takes, the App installed there, and a branch with commits that is not the factory's own. Null clears it.
 * The first pass runs at once, so the page shows the result instead of waiting for the next minute.
 */
export async function saveKnowledge(
  deps: KnowledgeDeps,
  choice: { repository: string | null; branch?: string | null },
): Promise<KnowledgeStatus> {
  if (choice.repository === null) {
    await writeKnowledgeConfig(deps.db, null)
    return knowledgeStatus(deps.db)
  }
  const repository = choice.repository.trim()
  const branch = choice.branch?.trim() || null
  try {
    assertRepository(repository)
  } catch (error) {
    if (error instanceof KnowledgeFormatError) throw new KnowledgeRefused(error.message)
    throw error
  }
  if (branch !== null && !validBranch(branch)) {
    throw new KnowledgeRefused(`"${branch}" is not a branch name git can take`)
  }
  if (branch === MEMORY_BRANCH) {
    throw new KnowledgeRefused(
      `${MEMORY_BRANCH} is the branch the factory writes its notes to; choose the branch of the rules`,
    )
  }
  let token: string
  try {
    token = (await deps.github.installationToken(repository)).token
  } catch (error) {
    throw new KnowledgeRefused(`the factory cannot reach ${repository}: ${message(error)}`)
  }
  const effective = branch ?? (await deps.api.defaultBranch(repository, token))
  if (!(await deps.api.branchHead(repository, token, effective))) {
    throw new KnowledgeRefused(
      branch
        ? `${repository} has no branch ${branch}`
        : `${repository} has no commit yet; push a first commit and save again`,
    )
  }
  await writeKnowledgeConfig(deps.db, { repository, branch })
  await serialized(() => syncKnowledge(deps)).catch((error: unknown) => {
    // The pass recorded what went wrong in the sync state, and the status below shows it on the page.
    console.error(
      JSON.stringify({ event: 'knowledge_sync_failed', repository, error: message(error) }),
    )
  })
  return knowledgeStatus(deps.db)
}

/** The files of the template, as paths relative to it. */
export function templateFiles(dir: string): { path: string; content: string }[] {
  const found: { path: string; content: string }[] = []
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const full = join(at, name)
      if (statSync(full).isDirectory()) walk(full)
      else
        found.push({
          path: relative(dir, full).split('\\').join('/'),
          content: readFileSync(full, 'utf8'),
        })
    }
  }
  walk(dir)
  return found
}

/**
 * The MEMORY.md the pull request proposes: the template's when there is none, the owner's own with the
 * format added when it has no front matter. One in another format is refused, since rewriting it is not
 * the factory's call.
 */
export function proposedIndex(existing: string | undefined, template: string): string | undefined {
  if (existing === undefined) return template
  if (checkIndex(existing).ok) return undefined
  const format = frontMatter(existing).format
  if (format) {
    throw new KnowledgeRefused(`MEMORY.md says format ${format}; change it to ${FORMAT} by hand`)
  }
  if (/^---\r?\n/.test(existing)) {
    return existing.replace(/^---\r?\n/, `---\nformat: ${FORMAT}\n`)
  }
  return `---\nformat: ${FORMAT}\n---\n\n${existing}`
}

/**
 * Opens a pull request that turns the knowledge repository into this format: the template's files that are
 * missing, and the format in MEMORY.md. Nothing reaches the owner's branch unless they merge it.
 */
export async function proposeTemplate(
  deps: KnowledgeDeps,
): Promise<{ url: string; files: string[] }> {
  const config = await loadKnowledgeConfig(deps.db)
  if (!config) throw new KnowledgeRefused('choose a knowledge repository first')
  const state = await serialized(() => syncKnowledge(deps)).catch((error: unknown) => {
    throw new KnowledgeRefused(`the factory could not read ${config.repository}: ${message(error)}`)
  })
  if (!state?.knowledgeSha) throw new KnowledgeRefused(`${config.repository} could not be read`)
  const c = await context(deps, config)
  const present = new Set((await c.mirror.list(state.knowledgeSha, ['.'])).map((f) => f.path))
  const template = templateFiles(deps.templateDir ?? defaultTemplateDir())
  const files = template.filter((f) => f.path !== 'MEMORY.md' && !present.has(f.path))
  const index = proposedIndex(
    (await c.mirror.read(state.knowledgeSha, 'MEMORY.md'))?.toString('utf8'),
    template.find((f) => f.path === 'MEMORY.md')?.content ?? `---\nformat: ${FORMAT}\n---\n`,
  )
  if (index !== undefined) files.unshift({ path: 'MEMORY.md', content: index })
  if (files.length === 0) {
    throw new KnowledgeRefused(`${config.repository} already has every file of the template`)
  }
  const commit = await c.mirror.commit({
    parent: state.knowledgeSha,
    files,
    message: `Set up the factory's knowledge base format\n\nAdds ${files.map((f) => f.path).join(', ')}.\n`,
    author: deps.author,
    date: c.now,
  })
  await c.mirror.push(c.url, commit, TEMPLATE_BRANCH, { token: c.token, force: true })
  const pull = await deps.api.openPullRequest(config.repository, c.token, {
    head: TEMPLATE_BRANCH,
    base: state.branch,
    title: 'Set up this repository as the factory knowledge base',
    body: [
      `The aifactory reads this repository as its knowledge base, in the format \`${FORMAT}\`.`,
      'This pull request adds what the format needs and changes nothing that is already here:',
      '',
      ...files.map((f) => `- \`${f.path}\``),
      '',
      'README.md in this pull request says how the repository is organized. Rules go under `knowledge/`;',
      `the factory writes its own notes to the \`${MEMORY_BRANCH}\` branch and never to this one.`,
    ].join('\n'),
  })
  return { url: pull.url, files: files.map((f) => f.path) }
}

/** What the setup page shows about the knowledge base. */
export async function knowledgeStatus(db: Database): Promise<KnowledgeStatus> {
  const [config, state, notes] = await Promise.all([
    loadKnowledgeConfig(db),
    loadSyncState(db),
    noteCounts(db),
  ])
  const own = state && config && state.repository === config.repository ? state : undefined
  return {
    repository: config?.repository ?? null,
    branch: config?.branch ?? null,
    readBranch: own?.branch || null,
    memoryBranch: MEMORY_BRANCH,
    knowledgeSha: own?.knowledgeSha ?? null,
    memorySha: own?.memorySha ?? null,
    formatProblem: own?.format && !own.format.ok ? own.format.reason : null,
    syncedAt: own?.syncedAt ?? null,
    error: own?.error ?? null,
    errorAt: own?.errorAt ?? null,
    pendingNotes: notes.pending,
    writtenNotes: notes.written,
  }
}
