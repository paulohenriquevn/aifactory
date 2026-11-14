import { and, desc, eq, inArray, max, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { stageEvent, task } from '../db/schema'
import { APP_PERMISSIONS, type AppAccess, type AppEvents, type GithubApp } from '../github/app'
import type { GithubApi } from '../github/pulls'
import { FACTORY_LABEL } from '../ingest/decide'

import { integrationBranch, PRE_RELEASE_BRANCH } from './branches'
import { usesChangesets, withChangesetCheck } from './changesets'
import type { DoctorTried, RecipeWhy } from '../../shared/doctor-say'
import {
  manifestVersion,
  providerRefusal,
  readOf,
  runsOnTag,
  triedOf,
  triedText,
  unread,
  type AccessFacts,
  type DoctorFacts,
  type PublishFacts,
  type Read,
  type RecentChecks,
  type SandboxFacts,
} from './doctor'
import { DEFAULT_CHECKS } from './evidence'
import {
  parseRecipe,
  pendingEgress,
  RECIPE_PATH,
  RecipeError,
  withRecipe,
  type Recipe,
} from './recipe'
import { loadRepoConfig, type RepoConfig } from './repo-config'

/**
 * Reads what the doctor decides over: the repository on GitHub, the App, and the failed runs in the
 * database. It decides nothing. A read that fails becomes a fact that was not read, with what was being
 * done and what came back, so the item that needs it says `unknown` rather than guessing.
 *
 * It asks GitHub only for what the App may read: the repository, its branches, labels, files, commits,
 * pull requests and their check runs. Whether a workflow is enabled is behind a permission the App does
 * not have, so a silent CI is read from the check runs of recent commits.
 */
export type DoctorSources = {
  db: Database
  github: Pick<GithubApp, 'installationToken'> & AppEvents & AppAccess
  api: Pick<
    GithubApi,
    | 'repositorySettings'
    | 'labelExists'
    | 'recentCommits'
    | 'recentPullRequestHeads'
    | 'requiredChecks'
    | 'checkReports'
    | 'branchHead'
    | 'listDirectory'
    | 'readFile'
    | 'versionTags'
  >
}

/** How many commits of the integration branch, and how many pull requests into it, are looked at. */
const RECENT = 5
const WORKFLOWS = '.github/workflows'
/** The most workflow files read to find one that runs on a tag. */
const MAX_WORKFLOWS = 20

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function attempt<T>(what: DoctorTried, work: () => Promise<T>): Promise<Read<T>> {
  try {
    return readOf(await work())
  } catch (error) {
    return unread(triedText(what), message(error), what)
  }
}

/** A fact that is read from another: when the other was not read, neither is this one, for the same reason. */
const after = async <A, T>(
  needed: Read<A>,
  what: DoctorTried,
  work: (value: A) => Promise<T>,
): Promise<Read<T>> => (needed.read ? attempt(what, () => work(needed.value)) : needed)

/** A fact made of another with no further reading. */
const mapRead = <A, T>(read: Read<A>, map: (value: A) => T): Read<T> =>
  read.read ? readOf(map(read.value)) : read

/** One repository, and the token to read it with. */
type Reader = {
  api: DoctorSources['api']
  name: string
  token: string
  config: RepoConfig
  integration: string
}

async function readAccess(github: AppAccess, name: string): Promise<AccessFacts> {
  const granted = await github.installationPermissions(name)
  return { reachable: granted !== undefined, granted: granted ?? {}, needed: APP_PERMISSIONS }
}

/** The latest run the sandbox provider refused, among the last failures, and when a sandbox last started. */
async function readSandbox(db: Database, name: string): Promise<SandboxFacts> {
  const ofTheRepository = sql`lower(${task.repository}) = lower(${name})`
  const failures = await db
    .select({ taskId: stageEvent.taskId, detail: stageEvent.detail, at: stageEvent.at })
    .from(stageEvent)
    .innerJoin(task, eq(task.id, stageEvent.taskId))
    .where(and(ofTheRepository, eq(stageEvent.stage, 'failed')))
    .orderBy(desc(stageEvent.at))
    .limit(20)
  const refused = failures.find((f) => providerRefusal(f.detail as Record<string, unknown> | null))
  // A run that reached the plan or the build had a sandbox.
  const [started] = await db
    .select({ at: max(stageEvent.at) })
    .from(stageEvent)
    .innerJoin(task, eq(task.id, stageEvent.taskId))
    .where(and(ofTheRepository, inArray(stageEvent.stage, ['plan', 'build'])))
  return {
    refusal: refused && {
      taskId: refused.taskId,
      at: refused.at.toISOString(),
      error: String((refused.detail as { error: unknown }).error),
    },
    lastStartedAt: started?.at?.toISOString(),
  }
}

async function missingBranches({ api, name, token, integration }: Reader): Promise<string[]> {
  const missing: string[] = []
  for (const branch of [integration, PRE_RELEASE_BRANCH]) {
    if ((await api.branchHead(name, token, branch)) === undefined) missing.push(branch)
  }
  return missing
}

async function readRecent({ api, name, token, integration }: Reader): Promise<RecentChecks> {
  const [commits, heads] = await Promise.all([
    api.recentCommits(name, token, integration, RECENT),
    api.recentPullRequestHeads(name, token, integration, RECENT),
  ])
  const shas = [...new Set([...commits, ...heads])].filter((sha) => sha !== '')
  return {
    commits: await Promise.all(
      shas.map(async (sha) => ({
        sha,
        checks: (await api.checkReports(name, token, sha)).map((report) => report.name),
      })),
    ),
    pullRequests: heads.length,
  }
}

async function tagWorkflows({ api, name, token }: Reader, ref: string): Promise<string[]> {
  const files = (await api.listDirectory(name, token, WORKFLOWS, ref)) ?? []
  const found: string[] = []
  for (const file of files.filter((f) => /\.ya?ml$/.test(f)).slice(0, MAX_WORKFLOWS)) {
    const path = `${WORKFLOWS}/${file}`
    const text = await api.readFile(name, token, path, ref)
    if (text !== undefined && runsOnTag(text)) found.push(path)
  }
  return found
}

/** How the repository publishes, read on the pre-release branch, or on the release branch while that is missing. */
async function readPublish(reader: Reader, defaultBranch: string): Promise<PublishFacts> {
  const { api, name, token, config } = reader
  const preRelease = await api.branchHead(name, token, PRE_RELEASE_BRANCH)
  const ref =
    preRelease === undefined ? (config.releaseBranch ?? defaultBranch) : PRE_RELEASE_BRANCH
  const changesets = usesChangesets(await api.listDirectory(name, token, '.changeset', ref))
  const manifest = await api.readFile(name, token, 'package.json', ref)
  return {
    ref,
    changesets,
    // With changesets the mode is decided, and no workflow has to be read.
    tagWorkflows: changesets ? [] : await tagWorkflows(reader, ref),
    manifestVersion: manifest === undefined ? undefined : manifestVersion(manifest),
    versionTags: await api.versionTags(name, token),
  }
}

/** The recipe on the default branch, or why it cannot be used: the reason a run would stop with. */
async function readRecipe(
  { api, name, token }: Reader,
  defaultBranch: string,
): Promise<{ recipe?: Recipe; problem?: string; why?: RecipeWhy }> {
  const text = await api.readFile(name, token, RECIPE_PATH, defaultBranch)
  if (text === undefined) return {}
  try {
    return { recipe: parseRecipe(name, text) }
  } catch (error) {
    if (!(error instanceof RecipeError)) throw error
    return { problem: error.message, why: error.why }
  }
}

/** The names of the checks a run of the repository makes: the owner's, the recipe's or the default. */
function factoryCheckNames(reader: Reader, recipe: Recipe | undefined, changesets: boolean) {
  const checks = withRecipe(reader.config, recipe).checks ?? DEFAULT_CHECKS
  return withChangesetCheck(checks, changesets, reader.integration).map((check) => check.name)
}

type RepositoryFacts = Omit<DoctorFacts, 'repo' | 'integration' | 'access' | 'events' | 'sandbox'>

async function readRepository(reader: Reader): Promise<RepositoryFacts> {
  const { api, name, token, config, integration } = reader
  const settings = await attempt(triedOf('settings', { repo: name }), () =>
    api.repositorySettings(name, token),
  )
  const [branches, label, required, recent, publish, recipe] = await Promise.all([
    attempt(triedOf('branches', { repo: name }), async () => ({
      missing: await missingBranches(reader),
    })),
    attempt(triedOf('labels', { repo: name }), () => api.labelExists(name, token, FACTORY_LABEL)),
    attempt(triedOf('required', { repo: name, integration }), () =>
      api.requiredChecks(name, token, integration),
    ),
    attempt(triedOf('recent', { repo: name, integration }), () => readRecent(reader)),
    after(settings, triedOf('publish', { repo: name }), (s) =>
      readPublish(reader, s.defaultBranch),
    ),
    after(settings, triedOf('recipe', { repo: name, path: RECIPE_PATH }), async (s) => ({
      ...(await readRecipe(reader, s.defaultBranch)),
      url: `https://github.com/${name}/blob/${s.defaultBranch}/${RECIPE_PATH}`,
    })),
  ])
  return {
    settings,
    branches,
    label,
    required,
    recent,
    publish,
    recipe: mapRead(recipe, ({ recipe: read, problem, why, url }) => ({
      problem,
      why,
      pending: pendingEgress(config, read),
      url,
    })),
    factoryChecks: recipe.read
      ? mapRead(publish, (p) => factoryCheckNames(reader, recipe.value.recipe, p.changesets))
      : recipe,
  }
}

/** Everything the doctor decides over for one repository, each fact read or said not to be. */
export async function collectFacts(sources: DoctorSources, name: string): Promise<DoctorFacts> {
  const { db, github, api } = sources
  const config = await loadRepoConfig(db, name)
  const integration = integrationBranch(config)
  const [access, events, sandbox, token] = await Promise.all([
    attempt(triedOf('installation', { repo: name }), () => readAccess(github, name)),
    attempt(triedOf('events'), () => github.subscriptions()),
    attempt(triedOf('runs', { repo: name }), () => readSandbox(db, name)),
    attempt(
      triedOf('token', { repo: name }),
      async () => (await github.installationToken(name)).token,
    ),
  ])
  const local = { repo: name, integration, access, events, sandbox }
  if (!token.read) {
    return {
      ...local,
      settings: token,
      branches: token,
      label: token,
      required: token,
      recent: token,
      factoryChecks: token,
      publish: token,
      recipe: token,
    }
  }
  const reader = { api, name, token: token.value, config, integration }
  return { ...local, ...(await readRepository(reader)) }
}
