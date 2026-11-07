import { readdirSync, readFileSync, statSync } from 'node:fs'
import { and, eq, sql } from 'drizzle-orm'
import { join, relative, resolve } from 'node:path'

import type { KnowledgeStatus } from '../../shared/knowledge'
import type { Database } from '../db'
import { repository as repositoryTable } from '../db/schema'
import { validBranch } from '../factory/repo-config'
import type { GithubApp } from '../github/app'
import type { GithubApi } from '../github/pulls'

import {
  assertRepository,
  conformingCopy,
  indexedNote,
  KnowledgeFormatError,
  logDay,
  MEMORY_BRANCH,
  noteLogEntry,
  notePath,
  notesFolder,
  notesLogTitle,
  renderMemoryRoot,
  renderNote,
  renderNotesIndex,
  type IndexedNote,
  type Note,
} from './format'
import { Mirror, mirrorDir } from './mirror'
import { conformance, isReserved, logWith, OKF_VERSION } from './okf'
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

/** The most markdown files of the rules checked against OKF, and the most problems kept to show. */
const MAX_CHECKED_FILES = 2_000
const MAX_PROBLEMS = 50

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

/** The projects that have notes on the memory branch. */
async function projectsOn(c: Context, memorySha: string | undefined): Promise<string[]> {
  if (!memorySha) return []
  const projects = new Set<string>()
  for (const file of await c.mirror.list(memorySha, ['memory/projects/'])) {
    const match = /^memory\/projects\/([^/]+\/[^/]+)\//.exec(file.path)
    if (match) projects.add(match[1])
  }
  return [...projects]
}

/** The notes of one project already on the memory branch, as its index lists them. */
async function notesOn(c: Context, memorySha: string | undefined, repository: string) {
  if (!memorySha) return []
  const folder = notesFolder(repository)
  const listed: IndexedNote[] = []
  for (const file of await c.mirror.list(memorySha, [folder])) {
    if (isReserved(file.path)) continue
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
  for (const [project, kept] of byProject) {
    const folder = notesFolder(project)
    const written = kept.map((note) => ({ path: notePath(note), content: renderNote(note) }))
    files.push(...written)
    const listed = [
      ...(await notesOn(c, memorySha, project)),
      ...written.flatMap((f) => indexedNote(f.path, f.content) ?? []),
    ]
    files.push({ path: `${folder}index.md`, content: renderNotesIndex(project, listed, c.now) })
    const log = memorySha ? await c.mirror.read(memorySha, `${folder}log.md`) : undefined
    files.push({
      path: `${folder}log.md`,
      content: logWith(
        log?.toString('utf8'),
        notesLogTitle(project),
        logDay(c.now),
        kept.map(noteLogEntry),
      ),
    })
  }
  const projects = new Set([...(await projectsOn(c, memorySha)), ...byProject.keys()])
  files.push({ path: 'index.md', content: renderMemoryRoot([...projects]) })
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

/** The markdown files of the rules at a commit, as text, up to the most a check reads. */
async function markdownAt(c: Context, sha: string) {
  const files: { path: string; text: string }[] = []
  const listed = (await c.mirror.list(sha, ['.'])).filter((f) => /\.md$/i.test(f.path))
  for (const file of listed.slice(0, MAX_CHECKED_FILES)) {
    const content = await c.mirror.read(sha, file.path)
    if (content) files.push({ path: file.path, text: content.toString('utf8') })
  }
  return files
}

/** What in the rules does not conform to OKF. */
async function checkRules(c: Context, sha: string): Promise<string[]> {
  const files = await markdownAt(c, sha)
  const root = files.find((f) => f.path === 'index.md')?.text
  const problems = conformance(root, files)
  return problems.length > MAX_PROBLEMS
    ? [...problems.slice(0, MAX_PROBLEMS), `and ${problems.length - MAX_PROBLEMS} more`]
    : problems
}

/**
 * One pass: fetches the rules and the memory branch into the mirror, checks the rules against OKF, writes the pending
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
    const okf =
      kept.okf?.knowledgeSha === knowledgeSha
        ? kept.okf
        : { knowledgeSha, problems: await checkRules(c, knowledgeSha) }
    const memorySha = await writeNotes(c, fetchedMemory)
    const state: SyncState = {
      repository: config.repository,
      branch,
      knowledgeSha,
      memorySha,
      okf,
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
  const [project] = await deps.db
    .select({ fullName: repositoryTable.fullName })
    .from(repositoryTable)
    .where(
      and(
        sql`lower(${repositoryTable.fullName}) = lower(${repository})`,
        eq(repositoryTable.enabled, true),
      ),
    )
  if (project) {
    // The other side of refuseKnowledgeRepository in panel/work.ts: an agent never works on its own rules.
    throw new KnowledgeRefused(
      `${project.fullName} is enabled as a project of the factory; disable it on the Repositories page first`,
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
 * Opens a pull request that makes the knowledge repository an OKF bundle the factory reads: the template's
 * files that are missing, and front matter for each markdown file that has none or no type. A file whose
 * front matter is not YAML is left for the owner and named in the pull request. Nothing reaches the
 * owner's branch unless they merge it.
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
  const present = await markdownAt(c, state.knowledgeSha)
  const presentPaths = new Set((await c.mirror.list(state.knowledgeSha, ['.'])).map((f) => f.path))
  const added = templateFiles(deps.templateDir ?? defaultTemplateDir()).filter(
    (f) => !presentPaths.has(f.path),
  )
  const changed: { path: string; content: string }[] = []
  const byHand: string[] = []
  for (const file of present) {
    const copy = conformingCopy(file.path, file.text)
    if (copy.content !== undefined) changed.push({ path: file.path, content: copy.content })
    if (copy.byHand) byHand.push(`\`${file.path}\` ${copy.byHand}`)
  }
  const files = [...added, ...changed]
  if (files.length === 0) {
    throw new KnowledgeRefused(
      byHand.length > 0
        ? `nothing the factory can fix: ${byHand.join('; ')}`
        : `${config.repository} is already an OKF ${OKF_VERSION} bundle`,
    )
  }
  const commit = await c.mirror.commit({
    parent: state.knowledgeSha,
    files,
    message: `Make this repository an OKF ${OKF_VERSION} bundle for the factory\n\n${[
      ...added.map((f) => `Adds ${f.path}.`),
      ...changed.map((f) => `Adds front matter to ${f.path}.`),
    ].join('\n')}\n`,
    author: deps.author,
    date: c.now,
  })
  await c.mirror.push(c.url, commit, TEMPLATE_BRANCH, { token: c.token, force: true })
  const pull = await deps.api.openPullRequest(config.repository, c.token, {
    head: TEMPLATE_BRANCH,
    base: state.branch,
    title: 'Make this repository the factory knowledge base, in the Open Knowledge Format',
    body: [
      `The aifactory reads this repository as its knowledge base, an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format) ${OKF_VERSION} bundle.`,
      'This pull request adds what is missing and changes no text that is already here:',
      '',
      ...added.map((f) => `- adds \`${f.path}\``),
      ...changed.map((f) => `- adds front matter to \`${f.path}\``),
      ...(byHand.length > 0
        ? [
            '',
            'These need a person, since their front matter is not YAML the factory can read:',
            '',
            ...byHand.map((p) => `- ${p}`),
          ]
        : []),
      '',
      'README.md says how the repository is organized. Rules go under `knowledge/`;',
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
    okfProblems: own?.okf && own.okf.knowledgeSha === own.knowledgeSha ? own.okf.problems : [],
    syncedAt: own?.syncedAt ?? null,
    error: own?.error ?? null,
    errorAt: own?.errorAt ?? null,
    pendingNotes: notes.pending,
    writtenNotes: notes.written,
  }
}
