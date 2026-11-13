import { describe, expect, it } from 'vitest'

import {
  appAccessItem,
  appEventsItem,
  autoMergeItem,
  branchesItem,
  checksParityItem,
  ciSilentItem,
  diagnose,
  DOCTOR_ITEMS,
  issuesItem,
  labelItem,
  manifestVersion,
  providerRefusal,
  publishItem,
  publishMode,
  readOf,
  recipeItem,
  repairRefusal,
  runsOnTag,
  sandboxItem,
  unread,
  type DoctorFacts,
  type PublishFacts,
} from './doctor'

const REPO = 'o/r'
const down = unread('reading o/r', 'GitHub answered 502 reading o/r: ')
const settings = (over: object = {}) =>
  readOf({
    hasIssues: true,
    allowAutoMerge: true,
    allowMergeCommit: true,
    defaultBranch: 'main',
    ...over,
  })

/** What every item says of something that could not be read: never that it is fine. */
const expectUnknown = (item: { status: string; cause: string; canRepair: boolean }) => {
  expect(item.status).toBe('unknown')
  expect(item.cause).toBe(
    'Not known: reading o/r failed (GitHub answered 502 reading o/r: ). Nothing is assumed to be fine.',
  )
  expect(item.canRepair).toBe(false)
}

describe('issues_disabled', () => {
  it('blocks a repository with Issues turned off, and links to its settings', () => {
    expect(issuesItem(REPO, settings({ hasIssues: false }))).toEqual({
      id: 'issues_disabled',
      status: 'blocked',
      cause: 'Issues are turned off on o/r, so nobody can ask the factory for work there.',
      repair:
        'Turn Issues on under Settings, General, Features. A fork starts with Issues off. If you cannot change the settings, ask an administrator of the repository.',
      link: 'https://github.com/o/r/settings',
      canRepair: false,
      say: { code: 'issues_off', values: { repo: 'o/r' } },
    })
  })

  it('is fine with Issues on', () => {
    expect(issuesItem(REPO, settings())).toEqual({
      id: 'issues_disabled',
      status: 'ok',
      cause: 'Issues are on.',
      repair: '',
      canRepair: false,
    })
  })

  it('is unknown when the settings could not be read', () => {
    const item = issuesItem(REPO, down)
    expectUnknown(item)
    expect(item.id).toBe('issues_disabled')
    expect(item.repair).toBe('Check again in a moment.')
    expect(item).not.toHaveProperty('link')
  })
})

describe('app_access', () => {
  const granted = { contents: 'write', issues: 'write', metadata: 'read' }
  const needed = { contents: 'write', issues: 'write' }

  it('is fine when the App reaches the repository with every permission it needs', () => {
    const item = appAccessItem(REPO, readOf({ reachable: true, granted, needed }))
    expect(item).toMatchObject({ id: 'app_access', status: 'ok', canRepair: false })
    expect(item.cause).toBe('The GitHub App reaches o/r with every permission it needs.')
  })

  it('blocks a repository the App does not reach', () => {
    const item = appAccessItem(REPO, readOf({ reachable: false, granted: {}, needed }))
    expect(item).toMatchObject({
      status: 'blocked',
      cause: 'The GitHub App does not reach o/r.',
      link: 'https://github.com/o/r/settings/installations',
      canRepair: false,
    })
    expect(item.repair).toContain('Add the repository to the installation')
  })

  it('blocks and names a permission the installation lacks or holds only for reading', () => {
    const item = appAccessItem(
      REPO,
      readOf({ reachable: true, granted: { contents: 'read' }, needed }),
    )
    expect(item.status).toBe('blocked')
    expect(item.cause).toBe(
      'The installation of the GitHub App on o/r lacks contents: write, issues: write.',
    )
    expect(item.canRepair).toBe(false)
    expect(item.link).toBe('https://github.com/o/r/settings/installations')
  })

  it('takes a write permission for a read one, and an admin one for a write one', () => {
    const item = appAccessItem(
      REPO,
      readOf({
        reachable: true,
        granted: { contents: 'admin', statuses: 'write' },
        needed: { contents: 'write', statuses: 'read' },
      }),
    )
    expect(item.status).toBe('ok')
  })

  it('does not take a read permission for a write one, or nothing for a read one', () => {
    const item = appAccessItem(
      REPO,
      readOf({
        reachable: true,
        granted: { contents: 'read' },
        needed: { contents: 'write', statuses: 'read' },
      }),
    )
    expect(item.cause).toContain('lacks contents: write, statuses: read.')
  })

  it('is unknown when the installation could not be read', () => {
    expectUnknown(appAccessItem(REPO, down))
  })
})

describe('app_events', () => {
  const settingsUrl = 'https://github.com/settings/apps/x/permissions'
  const every = [
    'issues',
    'issue_comment',
    'pull_request_review',
    'pull_request_review_comment',
    'check_suite',
    'check_run',
  ]

  it('is fine when the App subscribes to every event the factory routes', () => {
    expect(appEventsItem(readOf({ events: every, settingsUrl }))).toEqual({
      id: 'app_events',
      status: 'ok',
      cause: 'The App subscribes to every event the factory reads.',
      repair: '',
      canRepair: false,
    })
  })

  it('warns, names the missing events and links to the App settings', () => {
    const item = appEventsItem(
      readOf({ events: every.filter((e) => e !== 'check_run'), settingsUrl }),
    )
    expect(item).toEqual({
      id: 'app_events',
      status: 'warn',
      cause: 'The App does not subscribe to check_run, so GitHub never tells the factory about it.',
      repair: 'Turn the missing events on under "Subscribe to events" in the App settings.',
      link: settingsUrl,
      canRepair: false,
      say: { code: 'app_events', values: { missing: 'check_run' } },
    })
  })

  it('is unknown when the App could not be read', () => {
    expectUnknown(appEventsItem(down))
  })
})

describe('branches', () => {
  it('blocks, names the missing branches and says the factory can create them', () => {
    expect(branchesItem(REPO, readOf({ missing: ['workspace', 'develop'] }))).toEqual({
      id: 'branches',
      status: 'blocked',
      cause: 'o/r has no branch workspace, develop.',
      repair: 'The factory can create what is missing from the head of the release branch.',
      link: 'https://github.com/o/r/branches',
      canRepair: true,
      say: { code: 'branches_missing', values: { repo: 'o/r', missing: 'workspace, develop' } },
    })
  })

  it('is fine, with nothing to repair, when both branches exist', () => {
    expect(branchesItem(REPO, readOf({ missing: [] }))).toMatchObject({
      status: 'ok',
      cause: 'The integration and pre-release branches exist.',
      canRepair: false,
    })
  })

  it('is unknown, and repairs nothing, when the branches could not be read', () => {
    expectUnknown(branchesItem(REPO, down))
  })
})

describe('label', () => {
  it('warns when the factory label does not exist, and can create it', () => {
    expect(labelItem(REPO, readOf(false))).toEqual({
      id: 'label',
      status: 'warn',
      cause: 'o/r has no "factory" label, which is what asks the factory to take an issue.',
      repair: 'The factory can create the label.',
      link: 'https://github.com/o/r/labels',
      canRepair: true,
      say: { code: 'label_missing', values: { repo: 'o/r' } },
    })
  })

  it('is fine when the label exists', () => {
    expect(labelItem(REPO, readOf(true))).toMatchObject({ status: 'ok', canRepair: false })
  })

  it('is unknown when the labels could not be read', () => {
    expectUnknown(labelItem(REPO, down))
  })
})

describe('auto_merge', () => {
  it('is fine when the integration branch requires no check, whatever the settings say', () => {
    const item = autoMergeItem(
      REPO,
      'workspace',
      readOf([]),
      settings({ allowAutoMerge: false, allowMergeCommit: false }),
    )
    expect(item).toMatchObject({ id: 'auto_merge', status: 'ok' })
    expect(item.cause).toBe(
      'workspace requires no status check, so the factory merges its pull requests itself.',
    )
  })

  it('blocks when checks are required and auto-merge is not allowed', () => {
    expect(
      autoMergeItem(REPO, 'workspace', readOf(['ci']), settings({ allowAutoMerge: false })),
    ).toEqual({
      id: 'auto_merge',
      status: 'blocked',
      cause:
        'workspace requires status checks, so the factory waits for them through auto-merge, and o/r has "Allow auto-merge" turned off.',
      repair: 'Turn on "Allow auto-merge" under Settings, General, Pull Requests.',
      link: 'https://github.com/o/r/settings',
      canRepair: false,
      say: {
        code: 'auto_merge_off',
        values: {
          integration: 'workspace',
          repo: 'o/r',
          off: '"Allow auto-merge"',
          turnOn: '"Allow auto-merge"',
        },
      },
    })
  })

  it('blocks when checks are required and merge commits are not allowed, naming both when both are off', () => {
    const one = autoMergeItem(
      REPO,
      'workspace',
      readOf(['ci']),
      settings({ allowMergeCommit: false }),
    )
    expect(one.status).toBe('blocked')
    expect(one.repair).toBe('Turn on "Allow merge commits" under Settings, General, Pull Requests.')
    const both = autoMergeItem(
      REPO,
      'workspace',
      readOf(['ci']),
      settings({ allowAutoMerge: false, allowMergeCommit: false }),
    )
    expect(both.cause).toContain('has "Allow auto-merge", "Allow merge commits" turned off.')
  })

  it('is fine when checks are required and both settings are on', () => {
    const item = autoMergeItem(REPO, 'workspace', readOf(['ci']), settings())
    expect(item.status).toBe('ok')
    expect(item.cause).toBe(
      'workspace requires status checks, and o/r allows auto-merge and merge commits.',
    )
  })

  it('is unknown when GitHub left a merge setting out of its answer and none is known to be off', () => {
    for (const hidden of [{ allowAutoMerge: undefined }, { allowMergeCommit: undefined }]) {
      const item = autoMergeItem(REPO, 'workspace', readOf(['ci']), settings(hidden))
      expect(item.status).toBe('unknown')
      expect(item.cause).toBe(
        'Not known: reading the merge settings of o/r failed (GitHub left them out of its answer). Nothing is assumed to be fine.',
      )
    }
  })

  it('still blocks on the setting known to be off when the other is hidden', () => {
    const item = autoMergeItem(
      REPO,
      'workspace',
      readOf(['ci']),
      settings({ allowAutoMerge: false, allowMergeCommit: undefined }),
    )
    expect(item.status).toBe('blocked')
  })

  it('is unknown when the required checks or the settings could not be read', () => {
    expectUnknown(autoMergeItem(REPO, 'workspace', down, settings()))
    expectUnknown(autoMergeItem(REPO, 'workspace', readOf(['ci']), down))
  })
})

describe('ci_silent', () => {
  const recent = (checks: string[][], pullRequests = 1) =>
    readOf({ commits: checks.map((names, i) => ({ sha: `s${i}`, checks: names })), pullRequests })

  it('is fine when the branch requires nothing but the check of the factory', () => {
    for (const required of [[], ['aifactory/verify']]) {
      const item = ciSilentItem(REPO, 'workspace', readOf(required), recent([[]]))
      expect(item).toMatchObject({ id: 'ci_silent', status: 'ok' })
      expect(item.cause).toBe('workspace requires no check of the repository.')
    }
  })

  it('is fine when every required check reported on one of the recent commits', () => {
    const item = ciSilentItem(
      REPO,
      'workspace',
      readOf(['lint', 'test']),
      recent([['test'], ['lint']]),
    )
    expect(item.status).toBe('ok')
    expect(item.cause).toBe('Every required check of workspace reported on a recent commit.')
  })

  it('blocks and names a required check that reported on none of the recent commits or pull requests', () => {
    expect(
      ciSilentItem(REPO, 'workspace', readOf(['lint', 'test']), recent([['test'], ['test']])),
    ).toEqual({
      id: 'ci_silent',
      status: 'blocked',
      cause:
        'workspace requires lint, which reported on none of its 2 most recent commits and pull requests: a workflow is disabled, or nothing triggers it.',
      repair:
        'Open the Actions tab: enable a workflow GitHub disabled for inactivity, or make the workflow run on pull requests into workspace.',
      link: 'https://github.com/o/r/actions',
      canRepair: false,
      say: {
        code: 'ci_silent',
        values: { integration: 'workspace', silent: 'lint', commits: '2' },
      },
    })
  })

  it('only warns when no pull request into the branch was there to look at', () => {
    const item = ciSilentItem(REPO, 'workspace', readOf(['lint']), recent([[]], 0))
    expect(item.status).toBe('warn')
  })

  it('is unknown when the required checks or the commits could not be read', () => {
    expectUnknown(ciSilentItem(REPO, 'workspace', down, recent([[]])))
    expectUnknown(ciSilentItem(REPO, 'workspace', readOf(['lint']), down))
  })
})

describe('checks_parity', () => {
  it('warns and names a required check with no counterpart among the checks of the factory', () => {
    expect(
      checksParityItem('workspace', readOf(['test', 'static gates']), readOf(['test'])),
    ).toEqual({
      id: 'checks_parity',
      status: 'warn',
      cause:
        'workspace requires static gates, and no check of the factory has that name: the factory would learn of a failure only from CI, after its own checks passed.',
      repair:
        'Add a check that runs the same command to the checks of the repository in the panel, or to .factory/setup.json.',
      link: '/repositories',
      canRepair: false,
      say: { code: 'checks_alone', values: { integration: 'workspace', alone: 'static gates' } },
    })
  })

  it('matches a required check that carries the name of a factory check among its words, in any case', () => {
    const item = checksParityItem(
      'workspace',
      readOf(['CI / Lint (node 22)', 'unit-tests']),
      readOf(['lint', 'unit_tests']),
    )
    expect(item.status).toBe('ok')
    expect(item.cause).toBe('Every required check of workspace has a check of the factory.')
  })

  it('does not match on a part of a word, or on some of the words only', () => {
    const item = checksParityItem(
      'workspace',
      readOf(['linting', 'unit']),
      readOf(['lint', 'unit-tests']),
    )
    expect(item.cause).toContain('requires linting, unit, and')
  })

  it('takes a name with no word in it as the counterpart of nothing', () => {
    expect(checksParityItem('workspace', readOf(['lint']), readOf(['-'])).status).toBe('warn')
  })

  it('never asks for a counterpart of the check the factory itself reports', () => {
    expect(
      checksParityItem('workspace', readOf(['aifactory/verify']), readOf(['test'])).status,
    ).toBe('ok')
  })

  it('is unknown when the required checks or the checks of the factory could not be read', () => {
    expectUnknown(checksParityItem('workspace', down, readOf(['test'])))
    expectUnknown(checksParityItem('workspace', readOf(['test']), down))
  })
})

describe('a workflow that runs on a tag', () => {
  it('is one whose push trigger names tags', () => {
    expect(runsOnTag('on:\n  push:\n    tags: ["v*"]\njobs: {}')).toBe(true)
    expect(runsOnTag('on:\n  push:\n    tags:\n      - v*\n')).toBe(true)
    expect(runsOnTag('on:\n  push:\n    tags: v*\n')).toBe(true)
  })

  it('is not one that runs on branches, on pull requests, or on every push', () => {
    expect(runsOnTag('on:\n  push:\n    branches: [main]\n')).toBe(false)
    expect(runsOnTag('on:\n  push:\n    tags: []\n')).toBe(false)
    expect(runsOnTag('on: [push, pull_request]\n')).toBe(false)
    expect(runsOnTag('on: push\n')).toBe(false)
    expect(runsOnTag('on:\n  pull_request:\n    tags: [x]\n')).toBe(false)
    expect(runsOnTag('on:\n  push:\n')).toBe(false)
    expect(runsOnTag('on:\n  push:\n    tags:\n')).toBe(false)
    expect(runsOnTag('jobs: {}\n')).toBe(false)
    expect(runsOnTag('')).toBe(false)
    expect(runsOnTag('- a\n- b\n')).toBe(false)
  })

  it('is not one that is not YAML', () => {
    expect(runsOnTag('on:\n  push:\n    tags: ["v*"]\n  : : [')).toBe(false)
  })
})

describe('the version of a manifest', () => {
  it('is its version field when that is text', () => {
    expect(manifestVersion('{"name":"x","version":"1.2.3"}')).toBe('1.2.3')
  })

  it('is nothing for a manifest without one, or that is not a JSON object', () => {
    expect(manifestVersion('{"name":"x"}')).toBeUndefined()
    expect(manifestVersion('{"version":3}')).toBeUndefined()
    expect(manifestVersion('not json')).toBeUndefined()
    expect(manifestVersion('null')).toBeUndefined()
  })
})

describe('publish_mode', () => {
  const facts = (over: Partial<PublishFacts> = {}): PublishFacts => ({
    ref: 'develop',
    changesets: false,
    tagWorkflows: [],
    manifestVersion: undefined,
    versionTags: [],
    ...over,
  })

  it('is changesets when the config is there, even with a workflow that runs on a tag', () => {
    const both = facts({ changesets: true, tagWorkflows: ['.github/workflows/release.yml'] })
    expect(publishMode(both)).toBe('changesets')
    expect(publishItem(REPO, readOf(both))).toEqual({
      id: 'publish_mode',
      status: 'ok',
      cause:
        'changesets: .changeset/config.json is on develop, so the release workflow of o/r tags its own releases.',
      repair: '',
      canRepair: false,
    })
  })

  it('is none when nothing publishes: the factory tags the releases', () => {
    expect(publishMode(facts())).toBe('none')
    expect(publishItem(REPO, readOf(facts())).cause).toBe(
      'none: o/r has no .changeset/config.json and no workflow that runs on a tag, so the factory tags its releases and nothing else is published.',
    )
    expect(publishItem(REPO, readOf(facts())).status).toBe('ok')
  })

  const tagged = (over: Partial<PublishFacts> = {}) =>
    facts({ tagWorkflows: ['.github/workflows/release.yml'], versionTags: ['v1.2.3'], ...over })

  it('is tag when a workflow runs on a tag, and fine when the manifest carries a version the next tag may have', () => {
    expect(publishMode(tagged())).toBe('tag')
    for (const version of ['1.2.4', '1.3.0', '2.0.0']) {
      const item = publishItem(REPO, readOf(tagged({ manifestVersion: version })))
      expect(item.status).toBe('ok')
      expect(item.cause).toBe(
        `tag: .github/workflows/release.yml runs on a tag, and package.json on develop is at ${version}, a version the next tag may have.`,
      )
    }
  })

  it('warns when the manifest would not carry the version of the next tag', () => {
    expect(publishItem(REPO, readOf(tagged({ manifestVersion: '1.2.3' })))).toEqual({
      id: 'publish_mode',
      status: 'warn',
      cause:
        'tag: .github/workflows/release.yml runs on a tag, and package.json on develop is at 1.2.3, while the next tag would be v1.2.4, v1.3.0 or v2.0.0: what the workflow publishes would not carry the version of the tag.',
      repair:
        'Set the version in package.json to the one the release will have before promoting, or publish with changesets.',
      link: 'https://github.com/o/r/blob/develop/.github/workflows/release.yml',
      canRepair: false,
      say: {
        code: 'tag_mismatch',
        values: {
          workflow: '.github/workflows/release.yml',
          ref: 'develop',
          version: '1.2.3',
          next: 'v1.2.4, v1.3.0 or v2.0.0',
        },
      },
    })
  })

  it('expects v0.1.0 as the first tag of a repository with none', () => {
    expect(
      publishItem(REPO, readOf(tagged({ versionTags: [], manifestVersion: '0.1.0' }))).status,
    ).toBe('ok')
    expect(
      publishItem(REPO, readOf(tagged({ versionTags: [], manifestVersion: '0.0.1' }))).cause,
    ).toContain('the next tag would be v0.1.0:')
  })

  it('warns when a workflow runs on a tag and the manifest has no version to compare', () => {
    const item = publishItem(REPO, readOf(tagged()))
    expect(item.status).toBe('warn')
    expect(item.cause).toBe(
      'tag: .github/workflows/release.yml runs on a tag, and package.json on develop has no version to compare with the next tag.',
    )
    expect(item.link).toBe('https://github.com/o/r/blob/develop/.github/workflows/release.yml')
  })

  it('is unknown when the repository could not be read', () => {
    expectUnknown(publishItem(REPO, down))
  })
})

describe('recipe', () => {
  const url = 'https://github.com/o/r/blob/main/.factory/setup.json'

  it('blocks on a recipe that cannot be used, with the reason a run would stop with', () => {
    const problem = 'o/r: .factory/setup.json on the default branch cannot be used: it is not JSON'
    expect(recipeItem(readOf({ problem, pending: [], url }))).toEqual({
      id: 'recipe',
      status: 'blocked',
      cause: problem,
      repair: 'Fix .factory/setup.json on the default branch: a run stops with the same reason.',
      link: url,
      canRepair: false,
      say: { code: 'recipe_problem', values: { problem } },
    })
  })

  it('warns and names the domains that wait for approval', () => {
    expect(recipeItem(readOf({ pending: ['a.example.org', 'b.example.org'], url }))).toEqual({
      id: 'recipe',
      status: 'warn',
      cause:
        'The recipe asks for a.example.org, b.example.org, which the sandbox does not reach until you approve them.',
      repair: 'Approve the domains on the page of the repository in the panel.',
      link: '/repositories',
      canRepair: false,
      say: { code: 'recipe_pending', values: { pending: 'a.example.org, b.example.org' } },
    })
  })

  it('is fine with no problem and nothing waiting', () => {
    expect(recipeItem(readOf({ pending: [], url }))).toMatchObject({
      status: 'ok',
      cause: 'The recipe has no problem and no domain waiting for approval.',
    })
  })

  it('is unknown when the recipe could not be read', () => {
    expectUnknown(recipeItem(down))
  })
})

describe('a failure that is the sandbox provider refusing', () => {
  it('is an environment failure about credit or spending', () => {
    expect(providerRefusal({ error: 'the sandbox did not start: Status code 402' })).toBe(true)
    expect(providerRefusal({ error: '403: team is blocked: spend_limit' })).toBe(true)
    expect(providerRefusal({ error: 'usage limit exceeded' })).toBe(true)
  })

  it('is a key the provider does not accept', () => {
    expect(providerRefusal({ error: 'the sandbox did not start: Status code 401' })).toBe(true)
    expect(providerRefusal({ error: '401: Invalid API key' })).toBe(true)
  })

  it('is not another failure of the environment, of the work, or of the agent quota', () => {
    expect(providerRefusal({ error: 'GitHub answered 502 reading the issue' })).toBe(false)
    expect(providerRefusal({ error: 'the checks did not pass' })).toBe(false)
    expect(providerRefusal({ error: 'usage limit exceeded', quota: true })).toBe(false)
    expect(providerRefusal({ quota: true })).toBe(false)
    expect(providerRefusal(null)).toBe(false)
  })
})

describe('sandbox', () => {
  const refusal = { taskId: 7, at: '2026-11-13T10:00:00.000Z', error: 'Status code 402' }

  it('blocks on a refusal with no run started since, and links to the task', () => {
    expect(sandboxItem(readOf({ refusal }))).toEqual({
      id: 'sandbox',
      status: 'blocked',
      cause:
        'The sandbox provider refused the last run of this repository (task 7, 2026-11-13T10:00:00.000Z): Status code 402',
      repair:
        'Add credit to the sandbox provider, or fix its key on the server. The task retries itself once the provider accepts.',
      link: '/tasks/7',
      canRepair: false,
      say: {
        code: 'sandbox_refused',
        values: { taskId: '7', at: '2026-11-13T10:00:00.000Z', error: 'Status code 402' },
      },
    })
    expect(sandboxItem(readOf({ refusal, lastStartedAt: '2026-11-13T09:59:59.000Z' })).status).toBe(
      'blocked',
    )
  })

  it('is fine when a sandbox started after the refusal, or at the same instant', () => {
    for (const lastStartedAt of ['2026-11-13T10:00:01.000Z', refusal.at]) {
      const item = sandboxItem(readOf({ refusal, lastStartedAt }))
      expect(item.status).toBe('ok')
      expect(item.cause).toBe('The sandbox provider has not refused the latest run.')
    }
  })

  it('is fine when the provider never refused', () => {
    expect(sandboxItem(readOf({})).status).toBe('ok')
    expect(sandboxItem(readOf({ lastStartedAt: refusal.at })).status).toBe('ok')
  })

  it('is unknown when the history could not be read', () => {
    expectUnknown(sandboxItem(down))
  })
})

describe('the report', () => {
  const healthy: DoctorFacts = {
    repo: REPO,
    integration: 'workspace',
    settings: settings(),
    access: readOf({
      reachable: true,
      granted: { contents: 'write' },
      needed: { contents: 'write' },
    }),
    events: readOf({
      events: [
        'issues',
        'issue_comment',
        'pull_request_review',
        'pull_request_review_comment',
        'check_suite',
        'check_run',
      ],
      settingsUrl: 'https://github.com/settings/apps/x/permissions',
    }),
    branches: readOf({ missing: [] }),
    label: readOf(true),
    required: readOf([]),
    recent: readOf({ commits: [], pullRequests: 0 }),
    factoryChecks: readOf(['test']),
    publish: readOf({
      ref: 'develop',
      changesets: false,
      tagWorkflows: [],
      manifestVersion: undefined,
      versionTags: [],
    }),
    recipe: readOf({ pending: [], url: 'https://github.com/o/r/blob/main/.factory/setup.json' }),
    sandbox: readOf({}),
  }

  it('has one item for each diagnosis, in the order they are declared, all fine for a healthy repository', () => {
    const items = diagnose(healthy)
    expect(items.map((i) => i.id)).toEqual([...DOCTOR_ITEMS])
    expect(DOCTOR_ITEMS).toEqual([
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
    ])
    expect(items.map((i) => i.status)).toEqual(items.map(() => 'ok'))
  })

  it('gives each item the facts that are its own', () => {
    const items = diagnose({
      ...healthy,
      integration: 'staging',
      settings: settings({ hasIssues: false, allowAutoMerge: false }),
      branches: readOf({ missing: ['staging'] }),
      label: readOf(false),
      required: readOf(['lint']),
      recent: readOf({ commits: [{ sha: 's', checks: [] }], pullRequests: 1 }),
    })
    const status = Object.fromEntries(items.map((i) => [i.id, i.status]))
    expect(status).toEqual({
      issues_disabled: 'blocked',
      app_access: 'ok',
      app_events: 'ok',
      branches: 'blocked',
      label: 'warn',
      auto_merge: 'blocked',
      ci_silent: 'blocked',
      checks_parity: 'warn',
      publish_mode: 'ok',
      recipe: 'ok',
      sandbox: 'ok',
    })
    expect(items.find((i) => i.id === 'auto_merge')?.cause).toContain('staging requires')
    expect(items.find((i) => i.id === 'ci_silent')?.cause).toContain('staging requires lint')
    expect(items.find((i) => i.id === 'checks_parity')?.cause).toContain('staging requires lint')
  })

  it('reports as unknown, never as fine, each item whose facts could not be read', () => {
    const items = diagnose({
      ...healthy,
      settings: down,
      access: down,
      events: down,
      branches: down,
      label: down,
      required: down,
      recent: down,
      factoryChecks: down,
      publish: down,
      recipe: down,
      sandbox: down,
    })
    expect(items.map((i) => i.status)).toEqual(items.map(() => 'unknown'))
  })
})

describe('what the factory can repair itself', () => {
  it('is the missing branches and the missing label', () => {
    expect(repairRefusal('branches')).toBeUndefined()
    expect(repairRefusal('label')).toBeUndefined()
  })

  it('refuses every other item with the reason', () => {
    expect(repairRefusal('issues_disabled')).toBe(
      'the factory cannot repair issues_disabled itself: the GitHub App has no permission to change the settings of a repository',
    )
    for (const id of DOCTOR_ITEMS.filter((i) => i !== 'branches' && i !== 'label')) {
      expect(repairRefusal(id)).toMatch(
        new RegExp(`^the factory cannot repair ${id} itself: \\S.{20,}$`),
      )
    }
  })
})

describe('the sentences of an item that is not fine', () => {
  it('names the owner of the App in the repair of app_events when the owner is known', () => {
    const item = appEventsItem(
      readOf({
        events: [],
        settingsUrl: 'https://github.com/settings/apps/x/permissions',
        owner: 'paulo',
      }),
    )
    expect(item.say?.values.owner).toBe('paulo')
    expect(item.repair).toBe(
      'Turn the missing events on under "Subscribe to events" in the App settings. The page opens only when you are signed in to GitHub as paulo, the owner of the App.',
    )
  })

  it('sends what was tried and what came back with an item it could not read', () => {
    const item = labelItem(REPO, unread('reading the labels of o/r', 'GitHub answered 502'))
    expect(item.say).toEqual({
      code: 'unknown',
      values: { tried: 'reading the labels of o/r', error: 'GitHub answered 502' },
    })
    expect(item.cause).toBe(
      'Not known: reading the labels of o/r failed (GitHub answered 502). Nothing is assumed to be fine.',
    )
  })

  it('says a tag workflow has no version to compare, with the workflow and the branch', () => {
    const item = publishItem(
      REPO,
      readOf({
        ref: 'develop',
        changesets: false,
        tagWorkflows: ['.github/workflows/release.yml'],
        manifestVersion: undefined,
        versionTags: [],
      }),
    )
    expect(item.say).toEqual({
      code: 'tag_no_version',
      values: { workflow: '.github/workflows/release.yml', ref: 'develop' },
    })
    expect(item.cause).toBe(
      'tag: .github/workflows/release.yml runs on a tag, and package.json on develop has no version to compare with the next tag.',
    )
  })

  it('sends no code with an item that is fine', () => {
    expect(labelItem(REPO, readOf(true)).say).toBeUndefined()
  })
})
