import { parseDocument } from 'yaml'

import {
  retryableFailure,
  type DoctorItem,
  type DoctorItemId,
  type PublishMode,
} from '../../shared/panel'
import {
  DOCTOR_SAY_EN,
  DOCTOR_TRIED_EN,
  type DoctorSayCode,
  type DoctorSayValues,
  type DoctorTried,
  type RecipeWhyKind,
} from '../../shared/doctor-say'
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
export type Unread = { read: false; tried: string; error: string; what?: DoctorTried }
/** A fact as the collector hands it over: read, or not. */
export type Read<T> = { read: true; value: T } | Unread

export const readOf = <T>(value: T): Read<T> => ({ read: true, value })
export const unread = (tried: string, error: string, what?: DoctorTried): Unread => ({
  read: false,
  tried,
  error,
  ...(what ? { what } : {}),
})

/** Something to read, named by a code so the panel can say it in the owner's language. */
export const triedOf = (code: DoctorTried['code'], values: DoctorSayValues = {}): DoctorTried => ({
  code,
  values,
})
/** What was tried, in English: what the API says in `cause`. */
export const triedText = (what: DoctorTried) => DOCTOR_TRIED_EN[what.code](what.values)

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

/** What the App subscribes to, where its settings are and, when known, the account that owns it. */
export type EventsFacts = { events: string[]; settingsUrl: string; owner?: string }

export type RecipeFacts = {
  /** Why the recipe cannot be used. */
  problem?: string
  /** The same reason as a kind and its parts, so the panel can say it in the owner's language. */
  why?: { kind: RecipeWhyKind; repo: string; path: string; detail: string }
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
  events: Read<EventsFacts>
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

/**
 * An item that is not fine. Its sentences come from the code, so the panel can say them in the owner's
 * language from the same code and values.
 */
const problem = (
  id: DoctorItemId,
  status: 'warn' | 'blocked' | 'unknown',
  code: DoctorSayCode,
  values: DoctorSayValues,
  extra: { link?: string; canRepair?: boolean } = {},
): DoctorItem => ({
  id,
  status,
  cause: DOCTOR_SAY_EN[code].cause(values),
  repair: DOCTOR_SAY_EN[code].repair(values),
  ...(extra.link === undefined ? {} : { link: extra.link }),
  canRepair: extra.canRepair ?? false,
  say: { code, values },
})

const unknownItem = (id: DoctorItemId, { tried, error, what }: Unread): DoctorItem =>
  problem(id, 'unknown', 'unknown', {
    tried,
    error,
    ...(what ? { what: what.code, ...what.values } : {}),
  })

/** An item that is fine: its sentence has a code too, though the panel shows nothing for it. */
const fine = (id: DoctorItemId, code: DoctorSayCode, values: DoctorSayValues = {}): DoctorItem => ({
  id,
  status: 'ok',
  cause: DOCTOR_SAY_EN[code].cause(values),
  repair: '',
  canRepair: false,
  say: { code, values },
})

export function issuesItem(repo: string, settings: Read<RepositorySettings>): DoctorItem {
  if (!settings.read) return unknownItem('issues_disabled', settings)
  if (settings.value.hasIssues) return fine('issues_disabled', 'ok_issues')
  return problem(
    'issues_disabled',
    'blocked',
    'issues_off',
    { repo },
    {
      link: `https://github.com/${repo}/settings`,
    },
  )
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
    return problem('app_access', 'blocked', 'app_unreachable', { repo }, { link })
  }
  const lacking = Object.entries(needed)
    .filter(([name, level]) => !covers(granted[name], level))
    .map(([name, level]) => `${name}: ${level}`)
  if (lacking.length === 0) {
    return fine('app_access', 'ok_app_access', { repo })
  }
  return problem(
    'app_access',
    'blocked',
    'app_lacks',
    { repo, lacking: lacking.join(', ') },
    { link },
  )
}

export function appEventsItem(events: Read<EventsFacts>): DoctorItem {
  if (!events.read) return unknownItem('app_events', events)
  const missing = missingRoutedEvents(events.value.events)
  if (missing.length === 0) {
    return fine('app_events', 'ok_app_events')
  }
  return problem(
    'app_events',
    'warn',
    'app_events',
    { missing: missing.join(', '), ...(events.value.owner ? { owner: events.value.owner } : {}) },
    { link: events.value.settingsUrl },
  )
}

export function branchesItem(repo: string, branches: Read<{ missing: string[] }>): DoctorItem {
  if (!branches.read) return unknownItem('branches', branches)
  const { missing } = branches.value
  if (missing.length === 0) {
    return fine('branches', 'ok_branches')
  }
  return problem(
    'branches',
    'blocked',
    'branches_missing',
    { repo, missing: missing.join(', ') },
    { link: `https://github.com/${repo}/branches`, canRepair: true },
  )
}

export function labelItem(repo: string, label: Read<boolean>): DoctorItem {
  if (!label.read) return unknownItem('label', label)
  if (label.value) return fine('label', 'ok_label')
  return problem(
    'label',
    'warn',
    'label_missing',
    { repo },
    {
      link: `https://github.com/${repo}/labels`,
      canRepair: true,
    },
  )
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
    return fine('auto_merge', 'ok_auto_merge_free', { integration })
  }
  const { allowAutoMerge, allowMergeCommit } = settings.value
  const off = [
    ...(allowAutoMerge === false ? ['"Allow auto-merge"'] : []),
    ...(allowMergeCommit === false ? ['"Allow merge commits"'] : []),
  ]
  if (off.length > 0) {
    return problem(
      'auto_merge',
      'blocked',
      'auto_merge_off',
      { integration, repo, off: off.join(', '), turnOn: off.join(' and ') },
      { link: `https://github.com/${repo}/settings` },
    )
  }
  if (allowAutoMerge === undefined || allowMergeCommit === undefined) {
    const what = triedOf('merge_settings', { repo })
    return problem('auto_merge', 'unknown', 'unknown_unanswered', {
      tried: triedText(what),
      what: what.code,
      ...what.values,
    })
  }
  return fine('auto_merge', 'ok_auto_merge_allowed', { integration, repo })
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
    return fine('ci_silent', 'ok_ci_free', { integration })
  }
  const { commits, pullRequests } = recent.value
  const silent = wanted.filter((name) => !commits.some((commit) => commit.checks.includes(name)))
  if (silent.length === 0) {
    return fine('ci_silent', 'ok_ci_reported', { integration })
  }
  // With no pull request to look at, a workflow that runs only on pull requests looks silent too.
  return problem(
    'ci_silent',
    pullRequests > 0 ? 'blocked' : 'warn',
    'ci_silent',
    { integration, silent: silent.join(', '), commits: String(commits.length) },
    { link: `https://github.com/${repo}/actions` },
  )
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
    return fine('checks_parity', 'ok_checks_parity', { integration })
  }
  return problem(
    'checks_parity',
    'warn',
    'checks_alone',
    { integration, alone: alone.join(', ') },
    { link: '/repositories' },
  )
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
  const link = `https://github.com/${repo}/blob/${publish.ref}/${workflow}`
  const version = publish.manifestVersion
  if (version === undefined) {
    return problem(
      'publish_mode',
      'warn',
      'tag_no_version',
      { workflow, ref: publish.ref },
      { link },
    )
  }
  const next = nextTags(publish.versionTags)
  if (next.includes(`v${version}`)) {
    return fine('publish_mode', 'ok_tag', { workflow, ref: publish.ref, version })
  }
  return problem(
    'publish_mode',
    'warn',
    'tag_mismatch',
    { workflow, ref: publish.ref, version, next: oneOf(next) },
    { link },
  )
}

export function publishItem(repo: string, publish: Read<PublishFacts>): DoctorItem {
  if (!publish.read) return unknownItem('publish_mode', publish)
  const mode = publishMode(publish.value)
  if (mode === 'changesets') {
    return fine('publish_mode', 'ok_changesets', { ref: publish.value.ref, repo })
  }
  if (mode === 'tag') return tagItem(repo, publish.value)
  return fine('publish_mode', 'ok_none', { repo })
}

export function recipeItem(recipe: Read<RecipeFacts>): DoctorItem {
  if (!recipe.read) return unknownItem('recipe', recipe)
  const { problem: reason, why, pending, url } = recipe.value
  if (reason !== undefined) {
    return problem(
      'recipe',
      'blocked',
      'recipe_problem',
      { problem: reason, ...why },
      { link: url },
    )
  }
  if (pending.length === 0) {
    return fine('recipe', 'ok_recipe')
  }
  return problem(
    'recipe',
    'warn',
    'recipe_pending',
    { pending: pending.join(', ') },
    { link: '/repositories' },
  )
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
    return fine('sandbox', 'ok_sandbox')
  }
  return problem(
    'sandbox',
    'blocked',
    'sandbox_refused',
    { taskId: String(refusal.taskId), at: refusal.at, error: refusal.error },
    { link: `/tasks/${refusal.taskId}` },
  )
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
