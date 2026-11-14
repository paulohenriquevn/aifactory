/**
 * The sentences of the repository doctor for an item that is not fine. The doctor sends the code and the
 * values with each item, so the panel can say the same thing in the owner's language; the English here is
 * also what the API answers with in `cause` and `repair`.
 */
export const DOCTOR_SAY_CODES = [
  'unknown',
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
] as const

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
}
