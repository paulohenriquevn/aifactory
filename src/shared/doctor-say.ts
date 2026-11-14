/**
 * The sentences of the repository doctor for an item that is not fine. The doctor sends the code and the
 * values with each item, so the panel can say the same thing in the owner's language; the English here is
 * also what the API answers with in `cause` and `repair`.
 */
export const DOCTOR_SAY_CODES = [
  'unknown',
  'unknown_unanswered',
  'issues_off',
  'app_unreachable',
  'app_lacks',
  'app_events',
  'branches_missing',
  'label_missing',
  'auto_merge_off',
  'ci_silent',
  'checks_alone',
  'tag_no_version',
  'tag_mismatch',
  'recipe_problem',
  'recipe_pending',
  'sandbox_refused',
  'ok_issues',
  'ok_app_access',
  'ok_app_events',
  'ok_branches',
  'ok_label',
  'ok_auto_merge_free',
  'ok_auto_merge_allowed',
  'ok_ci_free',
  'ok_ci_reported',
  'ok_checks_parity',
  'ok_tag',
  'ok_changesets',
  'ok_none',
  'ok_recipe',
  'ok_sandbox',
] as const

/** Every thing the doctor tries to read; an item it could not read says which, so the panel can name it. */
export const DOCTOR_TRIED_CODES = [
  'settings',
  'branches',
  'labels',
  'required',
  'recent',
  'publish',
  'recipe',
  'installation',
  'events',
  'runs',
  'token',
  'merge_settings',
] as const

export type DoctorTriedCode = (typeof DOCTOR_TRIED_CODES)[number]

export type DoctorTried = { code: DoctorTriedCode; values: DoctorSayValues }

/** What was tried, as a phrase that follows "Not known:", for each code. */
export type DoctorTriedSentences = Record<DoctorTriedCode, (v: DoctorSayValues) => string>

export const DOCTOR_TRIED_EN: DoctorTriedSentences = {
  settings: (v) => `reading the settings of ${v.repo}`,
  branches: (v) => `reading the branches of ${v.repo}`,
  labels: (v) => `reading the labels of ${v.repo}`,
  required: (v) => `reading the checks ${v.integration} requires on ${v.repo}`,
  recent: (v) => `reading the checks of the recent commits of ${v.integration} on ${v.repo}`,
  publish: (v) => `reading how ${v.repo} publishes`,
  recipe: (v) => `reading ${v.path} of ${v.repo}`,
  installation: (v) => `reading the installation of the GitHub App on ${v.repo}`,
  events: () => 'reading the events the GitHub App subscribes to',
  runs: (v) => `reading the failed runs of ${v.repo}`,
  token: (v) => `minting a token for ${v.repo}`,
  merge_settings: (v) => `reading the merge settings of ${v.repo}`,
}

/** Why a recipe cannot be used, as the three ways `RecipeError` has of saying it. */
export const RECIPE_WHY_KINDS = ['not_json', 'invalid', 'status'] as const
export type RecipeWhyKind = (typeof RECIPE_WHY_KINDS)[number]

export type DoctorSayCode = (typeof DOCTOR_SAY_CODES)[number]

/** The values a sentence is built from, already joined into text. */
export type DoctorSayValues = Record<string, string>

export type DoctorSay = { code: DoctorSayCode; values: DoctorSayValues }

/** One code in one language: what is wrong, and the exact repair. */
export type DoctorSentence = {
  cause: (v: DoctorSayValues) => string
  repair: (v: DoctorSayValues) => string
}

export type DoctorSentences = Record<DoctorSayCode, DoctorSentence>

export const DOCTOR_SAY_EN: DoctorSentences = {
  unknown: {
    cause: (v) => `Not known: ${v.tried} failed (${v.error}). Nothing is assumed to be fine.`,
    repair: () => 'Check again in a moment.',
  },
  unknown_unanswered: {
    cause: (v) =>
      `Not known: ${v.tried} failed (GitHub left them out of its answer). Nothing is assumed to be fine.`,
    repair: () => 'Check again in a moment.',
  },
  issues_off: {
    cause: (v) =>
      `Issues are turned off on ${v.repo}, so nobody can ask the factory for work there.`,
    repair: () =>
      'Turn Issues on under Settings, General, Features. A fork starts with Issues off. If you cannot change the settings, ask an administrator of the repository.',
  },
  app_unreachable: {
    cause: (v) => `The GitHub App does not reach ${v.repo}.`,
    repair: () =>
      'Add the repository to the installation of the App, on the page of the account that owns it.',
  },
  app_lacks: {
    cause: (v) => `The installation of the GitHub App on ${v.repo} lacks ${v.lacking}.`,
    repair: () =>
      'Accept the permissions the App asks for on its installation page; GitHub shows the request there.',
  },
  app_events: {
    cause: (v) =>
      `The App does not subscribe to ${v.missing}, so GitHub never tells the factory about it.`,
    repair: (v) =>
      v.owner
        ? `Turn the missing events on under "Subscribe to events" in the App settings. The page opens only when you are signed in to GitHub as ${v.owner}, the owner of the App.`
        : 'Turn the missing events on under "Subscribe to events" in the App settings.',
  },
  branches_missing: {
    cause: (v) => `${v.repo} has no branch ${v.missing}.`,
    repair: () => 'The factory can create what is missing from the head of the release branch.',
  },
  label_missing: {
    cause: (v) =>
      `${v.repo} has no "factory" label, which is what asks the factory to take an issue.`,
    repair: () => 'The factory can create the label.',
  },
  auto_merge_off: {
    cause: (v) =>
      `${v.integration} requires status checks, so the factory waits for them through auto-merge, and ${v.repo} has ${v.off} turned off.`,
    repair: (v) => `Turn on ${v.turnOn} under Settings, General, Pull Requests.`,
  },
  ci_silent: {
    cause: (v) =>
      `${v.integration} requires ${v.silent}, which reported on none of its ${v.commits} most recent commits and pull requests: a workflow is disabled, or nothing triggers it.`,
    repair: (v) =>
      `Open the Actions tab: enable a workflow GitHub disabled for inactivity, or make the workflow run on pull requests into ${v.integration}.`,
  },
  checks_alone: {
    cause: (v) =>
      `${v.integration} requires ${v.alone}, and no check of the factory has that name: the factory would learn of a failure only from CI, after its own checks passed.`,
    repair: () =>
      'Add a check that runs the same command to the checks of the repository in the panel, or to .factory/setup.json.',
  },
  tag_no_version: {
    cause: (v) =>
      `tag: ${v.workflow} runs on a tag, and package.json on ${v.ref} has no version to compare with the next tag.`,
    repair: () =>
      'Set the version in package.json to the one the release will have before promoting, or publish with changesets.',
  },
  tag_mismatch: {
    cause: (v) =>
      `tag: ${v.workflow} runs on a tag, and package.json on ${v.ref} is at ${v.version}, while the next tag would be ${v.next}: what the workflow publishes would not carry the version of the tag.`,
    repair: () =>
      'Set the version in package.json to the one the release will have before promoting, or publish with changesets.',
  },
  recipe_problem: {
    cause: (v) => v.problem,
    repair: () =>
      'Fix .factory/setup.json on the default branch: a run stops with the same reason.',
  },
  recipe_pending: {
    cause: (v) =>
      `The recipe asks for ${v.pending}, which the sandbox does not reach until you approve them.`,
    repair: () => 'Approve the domains on the page of the repository in the panel.',
  },
  sandbox_refused: {
    cause: (v) =>
      `The sandbox provider refused the last run of this repository (task ${v.taskId}, ${v.at}): ${v.error}`,
    repair: () =>
      'Add credit to the sandbox provider, or fix its key on the server. The task retries itself once the provider accepts.',
  },
  ok_issues: { cause: () => 'Issues are on.', repair: () => '' },
  ok_app_access: {
    cause: (v) => `The GitHub App reaches ${v.repo} with every permission it needs.`,
    repair: () => '',
  },
  ok_app_events: {
    cause: () => 'The App subscribes to every event the factory reads.',
    repair: () => '',
  },
  ok_branches: {
    cause: () => 'The integration and pre-release branches exist.',
    repair: () => '',
  },
  ok_label: { cause: () => 'The "factory" label exists.', repair: () => '' },
  ok_auto_merge_free: {
    cause: (v) =>
      `${v.integration} requires no status check, so the factory merges its pull requests itself.`,
    repair: () => '',
  },
  ok_auto_merge_allowed: {
    cause: (v) =>
      `${v.integration} requires status checks, and ${v.repo} allows auto-merge and merge commits.`,
    repair: () => '',
  },
  ok_ci_free: {
    cause: (v) => `${v.integration} requires no check of the repository.`,
    repair: () => '',
  },
  ok_ci_reported: {
    cause: (v) => `Every required check of ${v.integration} reported on a recent commit.`,
    repair: () => '',
  },
  ok_checks_parity: {
    cause: (v) => `Every required check of ${v.integration} has a check of the factory.`,
    repair: () => '',
  },
  ok_tag: {
    cause: (v) =>
      `tag: ${v.workflow} runs on a tag, and package.json on ${v.ref} is at ${v.version}, a version the next tag may have.`,
    repair: () => '',
  },
  ok_changesets: {
    cause: (v) =>
      `changesets: .changeset/config.json is on ${v.ref}, so the release workflow of ${v.repo} tags its own releases.`,
    repair: () => '',
  },
  ok_none: {
    cause: (v) =>
      `none: ${v.repo} has no .changeset/config.json and no workflow that runs on a tag, so the factory tags its releases and nothing else is published.`,
    repair: () => '',
  },
  ok_recipe: {
    cause: () => 'The recipe has no problem and no domain waiting for approval.',
    repair: () => '',
  },
  ok_sandbox: {
    cause: () => 'The sandbox provider has not refused the latest run.',
    repair: () => '',
  },
}
