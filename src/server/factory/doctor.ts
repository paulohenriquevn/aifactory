import { parseDocument } from 'yaml'

import {
  retryableFailure,
  type DoctorItem,
  type DoctorItemId,
  type PublishMode,
} from '../../shared/panel'
import type { RepositorySettings } from '../github/pulls'
import { missingRoutedEvents } from '../ingest/decide'

import { highestVersion, nextVersion } from './release'

/**
 * The repository doctor: what stands between a repository and a delivered pull request, found before a
 * task fails on it. Everything here decides over facts somebody else read (`doctor-facts.ts`), one small
 * function for each diagnosis. A fact that could not be read makes its item `unknown`, with what was
 * tried: the doctor never calls fine what it did not see.
 */

/** Something the collector tried to read and could not, with what was being done and what came back. */
export type Unread = { read: false; tried: string; error: string }
/** A fact as the collector hands it over: read, or not. */
export type Read<T> = { read: true; value: T } | Unread

export const readOf = <T>(value: T): Read<T> => ({ read: true, value })
export const unread = (tried: string, error: string): Unread => ({ read: false, tried, error })

/** The check run the factory reports on a commit it verified. */
export const FACTORY_CHECK_RUN = 'aifactory/verify'

/** Every diagnosis, in the order the report lists them. */
export const DOCTOR_ITEMS = [
  'issues_disabled',
  'app_access',
  'app_events',
  'branches',
  'label',
  'auto_merge',
  'ci_silent',
  'checks_parity',
  'publish_mode',
  'recipe',
  'sandbox',
] as const satisfies readonly DoctorItemId[]

/** Whether the App reaches the repository, what its installation was granted and what the factory asks for. */
export type AccessFacts = {
  reachable: boolean
  granted: Record<string, string>
  needed: Record<string, string>
}

/** The recent commits the checks of the integration branch report on, each with the names that reported. */
export type RecentChecks = {
  commits: { sha: string; checks: string[] }[]
  /** How many of those commits are heads of pull requests into the branch. */
  pullRequests: number
}

/** What says how a repository publishes, read on `ref`. */
export type PublishFacts = {
  ref: string
  /** `.changeset/config.json` is there. */
  changesets: boolean
  /** The workflows a pushed tag starts, by path. */
  tagWorkflows: string[]
  /** The version in the root package.json, when there is one. */
  manifestVersion: string | undefined
  /** The `v` tags of the repository, which the factory's next tag follows. */
  versionTags: string[]
}

export type RecipeFacts = {
  /** Why the recipe cannot be used. */
  problem?: string
  /** Domains the recipe asks for that the owner has not approved. */
  pending: string[]
  /** The recipe file on GitHub. */
  url: string
}

export type SandboxFacts = {
  /** The latest failure of a run of the repository that was the sandbox provider refusing. */
  refusal?: { taskId: number; at: string; error: string }
  /** When a sandbox last started for the repository. */
  lastStartedAt?: string
}

export type DoctorFacts = {
  repo: string
  /** The branch the factory integrates into. */
  integration: string
  settings: Read<RepositorySettings>
  access: Read<AccessFacts>
  events: Read<{ events: string[]; settingsUrl: string }>
  /** The integration and pre-release branches that do not exist. */
  branches: Read<{ missing: string[] }>
  /** Whether the `factory` label exists. */
  label: Read<boolean>
  /** The status checks the integration branch requires. */
  required: Read<string[]>
  recent: Read<RecentChecks>
  /** The names of the checks the factory runs for the repository. */
  factoryChecks: Read<string[]>
  publish: Read<PublishFacts>
  recipe: Read<RecipeFacts>
  sandbox: Read<SandboxFacts>
}

const unknownItem = (id: DoctorItemId, { tried, error }: Unread): DoctorItem => ({
  id,
  status: 'unknown',
  cause: `Not known: ${tried} failed (${error}). Nothing is assumed to be fine.`,
  repair: 'Check again in a moment.',
  canRepair: false,
})

const fine = (id: DoctorItemId, cause: string): DoctorItem => ({
  id,
  status: 'ok',
  cause,
  repair: '',
  canRepair: false,
})

export function issuesItem(repo: string, settings: Read<RepositorySettings>): DoctorItem {
  if (!settings.read) return unknownItem('issues_disabled', settings)
  if (settings.value.hasIssues) return fine('issues_disabled', 'Issues are on.')
  return {
    id: 'issues_disabled',
    status: 'blocked',
    cause: `Issues are turned off on ${repo}, so nobody can ask the factory for work there.`,
    repair:
      'Turn Issues on under Settings, General, Features. A fork starts with Issues off. If you cannot change the settings, ask an administrator of the repository.',
    link: `https://github.com/${repo}/settings`,
    canRepair: false,
  }
}

const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 }
/** Whether what an installation was granted covers what is needed: `write` covers `read`. */
const covers = (granted: string | undefined, needed: string) =>
  (LEVEL[String(granted)] ?? 0) >= LEVEL[needed]

export function appAccessItem(repo: string, access: Read<AccessFacts>): DoctorItem {
  if (!access.read) return unknownItem('app_access', access)
  const { reachable, granted, needed } = access.value
  const link = `https://github.com/${repo}/settings/installations`
  if (!reachable) {
    return {
      id: 'app_access',
      status: 'blocked',
      cause: `The GitHub App does not reach ${repo}.`,
      repair:
        'Add the repository to the installation of the App, on the page of the account that owns it.',
      link,
      canRepair: false,
    }
  }
  const lacking = Object.entries(needed)
    .filter(([name, level]) => !covers(granted[name], level))
    .map(([name, level]) => `${name}: ${level}`)
  if (lacking.length === 0) {
    return fine('app_access', `The GitHub App reaches ${repo} with every permission it needs.`)
  }
  return {
    id: 'app_access',
    status: 'blocked',
    cause: `The installation of the GitHub App on ${repo} lacks ${lacking.join(', ')}.`,
    repair:
      'Accept the permissions the App asks for on its installation page; GitHub shows the request there.',
    link,
    canRepair: false,
  }
}

export function appEventsItem(events: Read<{ events: string[]; settingsUrl: string }>): DoctorItem {
  if (!events.read) return unknownItem('app_events', events)
  const missing = missingRoutedEvents(events.value.events)
  if (missing.length === 0) {
    return fine('app_events', 'The App subscribes to every event the factory reads.')
  }
  return {
    id: 'app_events',
    status: 'warn',
    cause: `The App does not subscribe to ${missing.join(', ')}, so GitHub never tells the factory about it.`,
    repair: 'Turn the missing events on under "Subscribe to events" in the App settings.',
    link: events.value.settingsUrl,
    canRepair: false,
  }
}

export function branchesItem(repo: string, branches: Read<{ missing: string[] }>): DoctorItem {
  if (!branches.read) return unknownItem('branches', branches)
  const { missing } = branches.value
  if (missing.length === 0) {
    return fine('branches', 'The integration and pre-release branches exist.')
  }
  return {
    id: 'branches',
    status: 'blocked',
    cause: `${repo} has no branch ${missing.join(', ')}.`,
    repair: 'The factory can create what is missing from the head of the release branch.',
    link: `https://github.com/${repo}/branches`,
    canRepair: true,
  }
}

export function labelItem(repo: string, label: Read<boolean>): DoctorItem {
  if (!label.read) return unknownItem('label', label)
  if (label.value) return fine('label', 'The "factory" label exists.')
  return {
    id: 'label',
    status: 'warn',
    cause: `${repo} has no "factory" label, which is what asks the factory to take an issue.`,
    repair: 'The factory can create the label.',
    link: `https://github.com/${repo}/labels`,
    canRepair: true,
  }
}

/**
 * When the integration branch requires status checks the factory merges nothing itself: it turns on
 * auto-merge with a merge commit, and GitHub refuses that unless the repository allows both.
 */
export function autoMergeItem(
  repo: string,
  integration: string,
  required: Read<string[]>,
  settings: Read<RepositorySettings>,
): DoctorItem {
  if (!required.read) return unknownItem('auto_merge', required)
  if (!settings.read) return unknownItem('auto_merge', settings)
  if (required.value.length === 0) {
    return fine(
      'auto_merge',
      `${integration} requires no status check, so the factory merges its pull requests itself.`,
    )
  }
  const { allowAutoMerge, allowMergeCommit } = settings.value
  const off = [
    ...(allowAutoMerge === false ? ['"Allow auto-merge"'] : []),
    ...(allowMergeCommit === false ? ['"Allow merge commits"'] : []),
  ]
  if (off.length > 0) {
    return {
      id: 'auto_merge',
      status: 'blocked',
      cause: `${integration} requires status checks, so the factory waits for them through auto-merge, and ${repo} has ${off.join(', ')} turned off.`,
      repair: `Turn on ${off.join(' and ')} under Settings, General, Pull Requests.`,
      link: `https://github.com/${repo}/settings`,
      canRepair: false,
    }
  }
  if (allowAutoMerge === undefined || allowMergeCommit === undefined) {
    return unknownItem(
      'auto_merge',
      unread(`reading the merge settings of ${repo}`, 'GitHub left them out of its answer'),
    )
  }
  return fine(
    'auto_merge',
    `${integration} requires status checks, and ${repo} allows auto-merge and merge commits.`,
  )
}

/** The required checks that are the repository's own: the factory reports its own check itself. */
const ofTheRepository = (required: string[]) =>
  required.filter((name) => name !== FACTORY_CHECK_RUN)

/**
 * A required check that reports on no recent commit never will on the next one either: its workflow was
 * disabled (GitHub does that to a repository left alone for 60 days) or nothing triggers it, and a pull
 * request that waits for it waits forever. It is read from the check runs and statuses of recent commits,
 * which the App may read; the state of a workflow would take a permission it does not have.
 */
export function ciSilentItem(
  repo: string,
  integration: string,
  required: Read<string[]>,
  recent: Read<RecentChecks>,
): DoctorItem {
  if (!required.read) return unknownItem('ci_silent', required)
  if (!recent.read) return unknownItem('ci_silent', recent)
  const wanted = ofTheRepository(required.value)
  if (wanted.length === 0) {
    return fine('ci_silent', `${integration} requires no check of the repository.`)
  }
  const { commits, pullRequests } = recent.value
  const silent = wanted.filter((name) => !commits.some((commit) => commit.checks.includes(name)))
  if (silent.length === 0) {
    return fine('ci_silent', `Every required check of ${integration} reported on a recent commit.`)
  }
  return {
    id: 'ci_silent',
    // With no pull request to look at, a workflow that runs only on pull requests looks silent too.
    status: pullRequests > 0 ? 'blocked' : 'warn',
    cause: `${integration} requires ${silent.join(', ')}, which reported on none of its ${commits.length} most recent commits and pull requests: a workflow is disabled, or nothing triggers it.`,
    repair: `Open the Actions tab: enable a workflow GitHub disabled for inactivity, or make the workflow run on pull requests into ${integration}.`,
    link: `https://github.com/${repo}/actions`,
    canRepair: false,
  }
}

const words = (name: string) => name.toLowerCase().match(/[a-z0-9]+/g) ?? []

/**
 * Whether a required check is the same thing as a check of the factory, by name: every word of the
 * factory's name is a word of the required one, so `lint` answers for `CI / Lint (node 22)`.
 */
function counterpart(required: string, check: string): boolean {
  const have = new Set(words(required))
  const named = words(check)
  return named.length > 0 && named.every((word) => have.has(word))
}

/**
 * A check the integration branch requires and the factory does not run is a failure the factory learns of
 * from CI, after its own checks passed and the review approved.
 */
export function checksParityItem(
  integration: string,
  required: Read<string[]>,
  factoryChecks: Read<string[]>,
): DoctorItem {
  if (!required.read) return unknownItem('checks_parity', required)
  if (!factoryChecks.read) return unknownItem('checks_parity', factoryChecks)
  const alone = ofTheRepository(required.value).filter(
    (name) => !factoryChecks.value.some((check) => counterpart(name, check)),
  )
  if (alone.length === 0) {
    return fine(
      'checks_parity',
      `Every required check of ${integration} has a check of the factory.`,
    )
  }
  return {
    id: 'checks_parity',
    status: 'warn',
    cause: `${integration} requires ${alone.join(', ')}, and no check of the factory has that name: the factory would learn of a failure only from CI, after its own checks passed.`,
    repair:
      'Add a check that runs the same command to the checks of the repository in the panel, or to .factory/setup.json.',
    link: '/repositories',
    canRepair: false,
  }
}

/** Whether a workflow file is started by a pushed tag: its `push` trigger names tags. */
export function runsOnTag(workflow: string): boolean {
  const document = parseDocument(workflow)
  if (document.errors.length > 0) return false
  const parsed = document.toJS() as { on?: { push?: { tags?: unknown } | null } } | null
  const tags = parsed?.on?.push?.tags
  return tags !== undefined && tags !== null && [tags].flat().length > 0
}

/** The version a package.json carries, when it is JSON and has one. */
export function manifestVersion(text: string): string | undefined {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // A manifest that is not JSON carries no version, which is what the item then says.
    return undefined
  }
  const version = (json as { version?: unknown } | null)?.version
  return typeof version === 'string' ? version : undefined
}

export const publishMode = (publish: PublishFacts): PublishMode => {
  if (publish.changesets) return 'changesets'
  return publish.tagWorkflows.length > 0 ? 'tag' : 'none'
}

const BUMPS = ['patch', 'minor', 'major'] as const

/** The tags the factory may give the next release: one for each bump after the highest `v` tag. */
const nextTags = (versionTags: string[]) => {
  const latest = highestVersion(versionTags)
  return [...new Set(BUMPS.map((bump) => nextVersion(latest, bump)))]
}

const oneOf = (names: string[]) =>
  names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`

/**
 * A workflow that publishes on a tag publishes what the manifest says, not what the tag says: when the two
 * differ, the release carries one version and the package another.
 */
function tagItem(repo: string, publish: PublishFacts): DoctorItem {
  const [workflow] = publish.tagWorkflows
  const where = `tag: ${workflow} runs on a tag, and package.json on ${publish.ref}`
  const warning = {
    id: 'publish_mode',
    status: 'warn',
    repair:
      'Set the version in package.json to the one the release will have before promoting, or publish with changesets.',
    link: `https://github.com/${repo}/blob/${publish.ref}/${workflow}`,
    canRepair: false,
  } as const
  const version = publish.manifestVersion
  if (version === undefined) {
    return { ...warning, cause: `${where} has no version to compare with the next tag.` }
  }
  const next = nextTags(publish.versionTags)
  if (next.includes(`v${version}`)) {
    return fine('publish_mode', `${where} is at ${version}, a version the next tag may have.`)
  }
  return {
    ...warning,
    cause: `${where} is at ${version}, while the next tag would be ${oneOf(next)}: what the workflow publishes would not carry the version of the tag.`,
  }
}

export function publishItem(repo: string, publish: Read<PublishFacts>): DoctorItem {
  if (!publish.read) return unknownItem('publish_mode', publish)
  const mode = publishMode(publish.value)
  if (mode === 'changesets') {
    return fine(
      'publish_mode',
      `changesets: .changeset/config.json is on ${publish.value.ref}, so the release workflow of ${repo} tags its own releases.`,
    )
  }
  if (mode === 'tag') return tagItem(repo, publish.value)
  return fine(
    'publish_mode',
    `none: ${repo} has no .changeset/config.json and no workflow that runs on a tag, so the factory tags its releases and nothing else is published.`,
  )
}

export function recipeItem(recipe: Read<RecipeFacts>): DoctorItem {
  if (!recipe.read) return unknownItem('recipe', recipe)
  const { problem, pending, url } = recipe.value
  if (problem !== undefined) {
    return {
      id: 'recipe',
      status: 'blocked',
      cause: problem,
      repair: 'Fix .factory/setup.json on the default branch: a run stops with the same reason.',
      link: url,
      canRepair: false,
    }
  }
  if (pending.length === 0) {
    return fine('recipe', 'The recipe has no problem and no domain waiting for approval.')
  }
  return {
    id: 'recipe',
    status: 'warn',
    cause: `The recipe asks for ${pending.join(', ')}, which the sandbox does not reach until you approve them.`,
    repair: 'Approve the domains on the page of the repository in the panel.',
    link: '/repositories',
    canRepair: false,
  }
}

const NO_CREDIT = /Status code 402|spend_limit|usage limit exceeded/i
const BAD_KEY = /Status code 401|invalid api key/i

/**
 * Whether the detail of a failed run is the sandbox provider refusing: an environment failure about credit
 * or spending, or a key the provider does not accept. Other environment failures pass on their own.
 */
export function providerRefusal(detail: Record<string, unknown> | null | undefined): boolean {
  const error = String(detail?.error ?? '')
  if (BAD_KEY.test(error)) return true
  return retryableFailure(detail) === 'environment' && NO_CREDIT.test(error)
}

export function sandboxItem(sandbox: Read<SandboxFacts>): DoctorItem {
  if (!sandbox.read) return unknownItem('sandbox', sandbox)
  const { refusal, lastStartedAt } = sandbox.value
  // With no start to compare, the date is not a number and nothing is at or after the refusal.
  if (!refusal || Date.parse(lastStartedAt ?? '') >= Date.parse(refusal.at)) {
    return fine('sandbox', 'The sandbox provider has not refused the latest run.')
  }
  return {
    id: 'sandbox',
    status: 'blocked',
    cause: `The sandbox provider refused the last run of this repository (task ${refusal.taskId}, ${refusal.at}): ${refusal.error}`,
    repair:
      'Add credit to the sandbox provider, or fix its key on the server. The task retries itself once the provider accepts.',
    link: `/tasks/${refusal.taskId}`,
    canRepair: false,
  }
}

/** The report: one item for each diagnosis, in the order of `DOCTOR_ITEMS`. */
export function diagnose(facts: DoctorFacts): DoctorItem[] {
  const { repo, integration, required, settings } = facts
  return [
    issuesItem(repo, settings),
    appAccessItem(repo, facts.access),
    appEventsItem(facts.events),
    branchesItem(repo, facts.branches),
    labelItem(repo, facts.label),
    autoMergeItem(repo, integration, required, settings),
    ciSilentItem(repo, integration, required, facts.recent),
    checksParityItem(integration, required, facts.factoryChecks),
    publishItem(repo, facts.publish),
    recipeItem(facts.recipe),
    sandboxItem(facts.sandbox),
  ]
}

/** The items the factory repairs itself, with what the App may do: create a branch, create a label. */
export type Repairable = 'branches' | 'label'

/** Why the factory cannot make a repair itself, for every item but the two it can. */
const NOT_ITS_TO_REPAIR: Record<Exclude<DoctorItemId, Repairable>, string> = {
  issues_disabled: 'the GitHub App has no permission to change the settings of a repository',
  app_access: 'only the owner of the account can change what the GitHub App reaches and may do',
  app_events: 'only the owner of the GitHub App can change the events it subscribes to',
  auto_merge: 'the GitHub App has no permission to change the settings of a repository',
  ci_silent: 'the GitHub App has no permission to enable a workflow or to see why it is silent',
  checks_parity: 'which command stands for a check of the repository is for its owner to say',
  publish_mode: 'the version a release carries is decided in the repository, by a commit',
  recipe: 'the recipe changes by a commit on the default branch, and a domain by your approval',
  sandbox: 'the credit and the key of the sandbox provider are outside the factory',
}

/** Why an item cannot be repaired by the factory, or nothing for the ones it repairs. */
export function repairRefusal(id: DoctorItemId): string | undefined {
  const why = (NOT_ITS_TO_REPAIR as Record<string, string | undefined>)[id]
  return why === undefined ? undefined : `the factory cannot repair ${id} itself: ${why}`
}
