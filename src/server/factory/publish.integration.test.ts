import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { delivery, ingress, publication, repository, stageEvent, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import type {
  ChangedFile,
  CommitChecks,
  ReleaseInput,
  GithubApi,
  OpenPullRequest,
  PublishedRelease,
  PullRequestMerge,
  PullRequestState,
} from '../github/pulls'

import { pollPublications } from './publish'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
afterAll(() => getStorageManager().dispose())

const STARTED = new Date('2026-11-11T12:00:00Z')
const green: CommitChecks = {
  checkRuns: [{ name: 'CI', status: 'completed', conclusion: 'success' }],
  statuses: 'none',
}

/** GitHub as the publication step sees it, scripted per test. */
const gh = {
  versionPr: undefined as PullRequestState | undefined,
  /** The open pull requests GitHub answers for a head and a base. */
  open: [] as OpenPullRequest[],
  checks: green,
  published: [] as PublishedRelease[],
  /** Commits that are not in the promoted history. */
  outside: new Set<string>(),
  merges: [] as { number: number; sha: string; merge: PullRequestMerge }[],
  asked: [] as string[],
  comments: [] as { issue: number; body: string }[],
  closed: [] as number[],
  /** What the promotion brought to the release branch, as the comparison with its first parent lists it. */
  changed: [] as ChangedFile[],
  /** The files on the promoted commit, with what each holds. */
  tree: {} as Record<string, string>,
  /** The `v` tags the repository has. */
  versionTags: [] as string[],
  /** The releases the factory created. */
  created: [] as ReleaseInput[],
  /** The comparisons asked for, as `base...head`. */
  compared: [] as string[],
  /** The commits whose checks were read. */
  checksRead: [] as string[],
  /** The version branch changesets pushes, as its comparison with the release branch reads. */
  versionBranch: undefined as { sha: string; aheadBy: number; committedAt: Date } | undefined,
  /** The branch comparisons asked for, as `base...head`. */
  branchesRead: [] as string[],
  /** The pull requests the factory opened. */
  opened: [] as { head: string; base?: string; title: string; body: string }[],
}
beforeEach(async () => {
  await getPool().query(
    'truncate table repository, publication, watch, delivery, decision, question, review, evidence, stage_event, task, ingress restart identity cascade',
  )
  Object.assign(gh, {
    versionPr: undefined,
    open: [],
    checks: green,
    published: [],
    outside: new Set<string>(),
    merges: [],
    asked: [],
    comments: [],
    closed: [],
    changed: [],
    tree: {},
    versionTags: [],
    created: [],
    compared: [],
    checksRead: [],
    versionBranch: undefined,
    branchesRead: [],
    opened: [],
  })
})

const api = {
  findPullRequest: async (_repo: string, _token: string, head: string) => {
    gh.asked.push(head)
    return gh.versionPr
  },
  openPullRequestsBetween: async (_repo: string, _token: string, head: string, base: string) => {
    gh.asked.push(`${head} -> ${base}`)
    return gh.open
  },
  commitChecks: async (_repo: string, _token: string, sha: string) => {
    gh.checksRead.push(sha)
    return gh.checks
  },
  changedFiles: async (_repo: string, _token: string, base: string, head: string) => {
    gh.compared.push(`${base}...${head}`)
    return gh.changed
  },
  filePaths: async () => Object.keys(gh.tree),
  readFile: async (_repo: string, _token: string, path: string) => gh.tree[path],
  versionTags: async () => gh.versionTags,
  createRelease: async (_repo: string, _token: string, release: ReleaseInput) => {
    gh.created.push(release)
    return {
      id: gh.created.length,
      tag: release.tag,
      url: `https://github.com/usetheokit/ui/releases/tag/${release.tag}`,
    }
  },
  mergePullRequest: async (
    _repo: string,
    _token: string,
    number: number,
    sha: string,
    merge: PullRequestMerge,
  ) => {
    gh.merges.push({ number, sha, merge })
    return { sha: 'version-merge' }
  },
  releasesSince: async (_repo: string, _token: string, since: Date) =>
    gh.published.filter((r) => r.publishedAt >= since),
  contains: async (_repo: string, _token: string, _descendant: string, ancestor: string) =>
    !gh.outside.has(ancestor),
  commentOnIssue: async (_repo: string, _token: string, issue: number, body: string) => {
    gh.comments.push({ issue, body })
    return 'c'
  },
  closeIssue: async (_repo: string, _token: string, issue: number) => {
    gh.closed.push(issue)
  },
  branchAhead: async (_repo: string, _token: string, base: string, head: string) => {
    gh.branchesRead.push(`${base}...${head}`)
    return gh.versionBranch
  },
  openPullRequest: async (
    _repo: string,
    _token: string,
    pull: { head: string; base?: string; title: string; body: string },
  ) => {
    gh.opened.push(pull)
    return { number: 1975, url: 'https://github.com/usetheokit/ui/pull/1975' }
  },
} as unknown as GithubApi
const github: GithubApp = { installationToken: async () => ({ token: 't', expiresAt: new Date() }) }
/** A minute after the promotion: the release workflow has had no time to run. */
const SOON = new Date(STARTED.getTime() + 60_000)
const deps = (now = SOON) => ({ db: getDb(), github, api, now: () => now })

let seeded = 0
async function seedTask(stage: 'done' | 'released', mergedSha: string | null = `m${seeded + 1}`) {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `p-${++seeded}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'c',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await db
    .insert(task)
    .values({
      ingressId: i.id,
      repository: 'usetheokit/ui',
      issueNumber: 100 + seeded,
      issueTitle: `issue ${seeded}`,
      stage,
      mergedSha,
    })
    .returning({ id: task.id })
  return t.id
}

async function waitingPublication() {
  const released = await seedTask('released')
  await getDb().insert(delivery).values({
    taskId: released,
    kind: 'prerelease',
    tag: 'pre/101-abc1234',
    url: 'https://github.com/usetheokit/ui/releases/tag/pre/101-abc1234',
    sha: 'abc1234',
    actor: 'factory',
  })
  await getDb().insert(publication).values({
    taskId: released,
    repository: 'usetheokit/ui',
    releaseBranch: 'main',
    promotedSha: 'promoted1',
    actor: 'human',
    startedAt: STARTED,
  })
  return released
}

const versionPr = (fields: Partial<PullRequestState> = {}): PullRequestState => ({
  number: 180,
  url: 'https://github.com/usetheokit/ui/pull/180',
  headSha: 'version-head',
  draft: false,
  state: 'open',
  merged: false,
  ...fields,
})
const published = (tag: string): PublishedRelease => ({
  tag,
  url: `https://github.com/usetheokit/ui/releases/tag/${encodeURIComponent(tag)}`,
  publishedAt: new Date('2026-11-11T12:30:00Z'),
})
const row = async () => (await getDb().select().from(publication))[0]

describe('publishing a changesets release', () => {
  it('waits, saying so, while the release workflow has not opened the Version Packages pull request', async () => {
    await waitingPublication()

    const result = await pollPublications(deps())

    expect(result).toMatchObject({ merged: [], published: [], waiting: 1 })
    expect(gh.asked).toEqual(['changeset-release/main'])
    expect(await row()).toMatchObject({ status: 'waiting', versionPullRequest: null })
    expect((await row()).detail).toMatch(/no Version Packages pull request yet/)
  })

  it('merges the Version Packages pull request once its checks are green, pinned to the head it saw', async () => {
    await waitingPublication()
    gh.versionPr = versionPr()

    const result = await pollPublications(deps())

    expect(result.merged).toHaveLength(1)
    expect(gh.merges).toEqual([{ number: 180, sha: 'version-head', merge: { method: 'merge' } }])
    expect(await row()).toMatchObject({ status: 'waiting', versionPullRequest: 180 })
    expect((await row()).detail).toMatch(
      /merged .*#180 for human.*waiting for the release workflow/,
    )
  })

  it('does not merge while the checks are red, pending or missing, or the pull request is a draft', async () => {
    await waitingPublication()
    const cases: [PullRequestState, CommitChecks, RegExp][] = [
      [
        versionPr(),
        {
          checkRuns: [{ name: 'CI', status: 'completed', conclusion: 'failure' }],
          statuses: 'none',
        },
        /checks failed on .*#180: CI/,
      ],
      [
        versionPr(),
        { checkRuns: [{ name: 'CI', status: 'in_progress', conclusion: null }], statuses: 'none' },
        /not green yet/,
      ],
      [versionPr(), { checkRuns: [], statuses: 'none' }, /not green yet/],
      [versionPr({ draft: true }), green, /draft/],
      [versionPr({ state: 'closed' }), green, /closed without being merged/],
    ]
    for (const [pr, checks, why] of cases) {
      gh.versionPr = pr
      gh.checks = checks
      expect((await pollPublications(deps())).waiting).toBe(1)
      expect((await row()).detail).toMatch(why)
    }
    expect(gh.merges).toEqual([])
  })

  it('takes a Version Packages pull request a person merged after the promotion, and ignores an older one', async () => {
    await waitingPublication()
    gh.versionPr = versionPr({
      state: 'closed',
      merged: true,
      mergedAt: new Date('2026-09-25T21:12:10Z'),
    })
    await pollPublications(deps())
    expect((await row()).versionPullRequest).toBeNull()

    gh.versionPr = versionPr({
      state: 'closed',
      merged: true,
      mergedAt: new Date('2026-11-11T12:10:00Z'),
    })
    await pollPublications(deps())
    expect((await row()).versionPullRequest).toBe(180)
    expect(gh.merges).toEqual([])
  })

  it('names the published versions, releases every task whose work was promoted, and closes their issues', async () => {
    const released = await waitingPublication()
    const alsoShipped = await seedTask('done', 'shipped1')
    const notYet = await seedTask('done', 'later1')
    const notIntegrated = await seedTask('done', null)
    gh.outside.add('later1')
    gh.versionPr = versionPr()
    gh.published = [published('@theokit/ui@1.13.0'), published('pre/7-abc'), published('v9.9.9')]

    const result = await pollPublications(deps())

    expect(result.published).toHaveLength(1)
    expect(await row()).toMatchObject({ status: 'published', tags: ['@theokit/ui@1.13.0'] })
    const stageOf = async (id: number) =>
      (await getDb().select().from(task).where(eq(task.id, id)))[0].stage
    expect(await stageOf(released)).toBe('released')
    expect(await stageOf(alsoShipped)).toBe('released')
    expect(await stageOf(notYet)).toBe('done')
    expect(await stageOf(notIntegrated)).toBe('done')
    const releases = await getDb().select().from(delivery).where(eq(delivery.kind, 'release'))
    expect(releases.map((d) => [d.taskId, d.tag, d.actor]).sort()).toEqual(
      [
        [released, '@theokit/ui@1.13.0', 'human'],
        [alsoShipped, '@theokit/ui@1.13.0', 'human'],
      ].sort(),
    )
    const issueOf = async (id: number) =>
      (await getDb().select().from(task).where(eq(task.id, id)))[0].issueNumber
    const shippedIssues = [await issueOf(released), await issueOf(alsoShipped)].sort()
    expect(gh.closed.sort()).toEqual(shippedIssues)
    expect(gh.comments.map((c) => c.issue).sort()).toEqual(shippedIssues)
    expect(gh.comments[0].body).toContain('Available in `@theokit/ui@1.13.0`')
    const events = await getDb().select().from(stageEvent).where(eq(stageEvent.taskId, alsoShipped))
    expect(events.at(-1)?.detail).toMatchObject({ tag: '@theokit/ui@1.13.0', actor: 'human' })
  })

  it('waits for the release workflow after the merge, and does not release anything before it publishes', async () => {
    await waitingPublication()
    const other = await seedTask('done', 'shipped1')
    gh.versionPr = versionPr()
    gh.published = [{ ...published('@theokit/ui@1.12.2'), publishedAt: new Date('2026-09-25') }]

    expect((await pollPublications(deps())).waiting).toBe(1)
    expect((await row()).status).toBe('waiting')
    expect((await getDb().select().from(task).where(eq(task.id, other)))[0].stage).toBe('done')
    expect(gh.closed).toEqual([])
  })

  it('releases each task once, when a pass that already published runs again', async () => {
    await waitingPublication()
    await seedTask('done', 'shipped1')
    gh.versionPr = versionPr()
    gh.published = [published('@theokit/ui@1.13.0')]
    await pollPublications(deps())
    await getDb().update(publication).set({ status: 'waiting' })

    await pollPublications(deps())

    expect(await getDb().select().from(delivery).where(eq(delivery.kind, 'release'))).toHaveLength(
      2,
    )
    expect(gh.closed).toHaveLength(2)
  })

  it('publishes and releases every task when one issue cannot be closed, and records why on that task', async () => {
    const released = await waitingPublication()
    const refusing = await seedTask('done', 'shipped1')
    const refusedIssue = (await getDb().select().from(task).where(eq(task.id, refusing)))[0]
      .issueNumber
    gh.versionPr = versionPr()
    gh.published = [published('@theokit/ui@1.13.0')]
    const failing = {
      ...api,
      closeIssue: async (_repo: string, _token: string, issue: number) => {
        if (issue === refusedIssue) throw new Error(`GitHub answered 403 closing #${issue}`)
        gh.closed.push(issue)
      },
    } as unknown as GithubApi

    const result = await pollPublications({ ...deps(), api: failing })

    expect(result.published).toHaveLength(1)
    expect(result.errors).toEqual([])
    expect(await row()).toMatchObject({ status: 'published' })
    expect((await row()).detail).toContain(`#${refusedIssue}: GitHub answered 403`)
    const stageOf = async (id: number) =>
      (await getDb().select().from(task).where(eq(task.id, id)))[0].stage
    expect(await stageOf(released)).toBe('released')
    expect(await stageOf(refusing)).toBe('released')
    const events = await getDb().select().from(stageEvent).where(eq(stageEvent.taskId, refusing))
    expect(events.at(-1)?.detail).toMatchObject({
      issueError: expect.stringContaining('403'),
    })
  })

  it('records why a publication cannot go on, and keeps looking at the others', async () => {
    await waitingPublication()
    const broken = {
      ...api,
      findPullRequest: async () => {
        throw new Error('GitHub answered 502 listing pull requests of usetheokit/ui')
      },
    } as unknown as GithubApi

    const result = await pollPublications({ ...deps(), api: broken })

    expect(result.errors).toEqual([expect.stringMatching(/502/)])
    expect((await row()).detail).toMatch(/502/)
    expect((await row()).status).toBe('waiting')
  })
})

describe('a publication whose release run finished without a Version Packages pull request', () => {
  /** An hour after the promotion: the release run on the promoted commit has long finished. */
  const LATER = new Date(STARTED.getTime() + 60 * 60_000)
  const modified = (path: string): ChangedFile => ({ path, status: 'modified' })
  /** theokit-plugins after #269: the promotion changed CI and the changelog, no package. */
  function promotionOutsidePackages() {
    gh.changed = [modified('.github/workflows/ci.yml'), modified('CHANGELOG.md')]
    gh.tree = {
      'package.json': '{"name":"theokit-plugins","private":true}',
      '.changeset/config.json': '{"ignore":[]}',
      'packages/voice/package.json': '{"name":"@theokit/plugin-voice"}',
    }
    gh.versionTags = ['v0.2.0', 'v0.3.0']
  }
  const stageOf = async (id: number) =>
    (await getDb().select().from(task).where(eq(task.id, id)))[0].stage
  const lastEvent = async (id: number) =>
    (await getDb().select().from(stageEvent).where(eq(stageEvent.taskId, id))).at(-1)

  it('ends as the factory release of the promoted commit when the promotion changes no package changesets publishes', async () => {
    const asked = await waitingPublication()
    const contained = await seedTask('done', 'shipped1')
    promotionOutsidePackages()
    // Version Packages #250 merged before this promotion: it belongs to the earlier release.
    gh.versionPr = versionPr({
      number: 250,
      state: 'closed',
      merged: true,
      mergedAt: new Date('2026-11-11T11:11:04Z'),
    })

    const result = await pollPublications(deps(LATER))

    expect(result).toMatchObject({ published: [expect.any(Number)], waiting: 0, errors: [] })
    expect(gh.checksRead).toEqual(['promoted1'])
    expect(gh.compared).toEqual(['promoted1^...promoted1'])
    expect(gh.created).toEqual([
      expect.objectContaining({ tag: 'v0.3.1', sha: 'promoted1', prerelease: false }),
    ])
    expect(await row()).toMatchObject({ status: 'published', tags: ['v0.3.1'] })
    expect((await row()).detail).toMatch(
      /release workflow finished on promote without a Version Packages pull request.*v0\.3\.1/,
    )
    expect(await stageOf(asked)).toBe('released')
    expect(await stageOf(contained)).toBe('released')
    expect((await lastEvent(asked))?.detail).toMatchObject({ tag: 'v0.3.1', actor: 'human' })
    expect(gh.closed).toHaveLength(2)
    expect(gh.comments[0].body).toContain('Available in `v0.3.1`')
    expect(gh.merges).toEqual([])
  })

  it('makes one tag: a pass that runs again after the tag was made takes the same version', async () => {
    await waitingPublication()
    promotionOutsidePackages()
    await getDb()
      .update(publication)
      .set({ tags: ['v0.3.1'] })
    gh.versionTags = ['v0.3.0', 'v0.3.1']

    await pollPublications(deps(LATER))

    expect(gh.created.map((r) => r.tag)).toEqual(['v0.3.1'])
    expect(await row()).toMatchObject({ status: 'published', tags: ['v0.3.1'] })
  })

  it('keeps waiting before the grace window, while the run still goes, and while no check reported', async () => {
    await waitingPublication()
    promotionOutsidePackages()

    expect((await pollPublications(deps())).waiting).toBe(1)
    expect(gh.checksRead).toEqual([])
    expect((await row()).detail).toMatch(/no Version Packages pull request yet/)

    gh.checks = {
      checkRuns: [{ name: 'Release via Changesets', status: 'in_progress', conclusion: null }],
      statuses: 'none',
    }
    expect((await pollPublications(deps(LATER))).waiting).toBe(1)
    expect((await row()).detail).toMatch(/the checks on promote still run/)

    gh.checks = { checkRuns: [], statuses: 'none' }
    expect((await pollPublications(deps(LATER))).waiting).toBe(1)
    expect((await row()).detail).toMatch(/no check has reported on promote\b/)

    expect(await row()).toMatchObject({ status: 'waiting', tags: null })
    expect(gh.created).toEqual([])
  })

  it('fails, visibly on its task, when the run on the promoted commit failed', async () => {
    const asked = await waitingPublication()
    promotionOutsidePackages()
    gh.checks = {
      checkRuns: [
        { name: 'Release via Changesets', status: 'completed', conclusion: 'failure' },
        { name: 'CI', status: 'completed', conclusion: 'success' },
      ],
      statuses: 'none',
    }

    const result = await pollPublications(deps(LATER))

    expect(result).toMatchObject({ failed: [expect.any(Number)], published: [], waiting: 0 })
    expect(await row()).toMatchObject({ status: 'failed' })
    expect((await row()).detail).toMatch(/Release via Changesets failed on promote\b/)
    expect(gh.created).toEqual([])
    expect(gh.closed).toEqual([])
    expect(await stageOf(asked)).toBe('released')
    expect((await lastEvent(asked))?.detail).toMatchObject({
      actor: 'human',
      mergeSha: 'promoted1',
      releaseError: expect.stringMatching(/Release via Changesets failed/),
    })
  })

  it('fails, naming the package, when the promotion changed a package changesets publishes and nothing was published', async () => {
    const asked = await waitingPublication()
    promotionOutsidePackages()
    gh.changed.push(modified('packages/voice/src/index.ts'))

    const result = await pollPublications(deps(LATER))

    expect(result.failed).toHaveLength(1)
    expect(await row()).toMatchObject({ status: 'failed' })
    expect((await row()).detail).toMatch(/changes @theokit\/plugin-voice/)
    expect(gh.created).toEqual([])
    expect((await lastEvent(asked))?.detail).toMatchObject({
      releaseError: expect.stringMatching(/@theokit\/plugin-voice/),
    })
    expect((await pollPublications(deps(LATER))).failed).toEqual([])
  })
})

describe('a version branch the release workflow pushed without a pull request', () => {
  const LATER = new Date(STARTED.getTime() + 60 * 60_000)
  /** A promotion whose package changed: with nothing published, the publication would fail. */
  function promotionOfAPackage() {
    gh.changed = [{ path: 'packages/ui/src/index.ts', status: 'modified' }]
    gh.tree = {
      'package.json': '{"name":"ui-repo","private":true}',
      '.changeset/config.json': '{"ignore":[]}',
      'packages/ui/package.json': '{"name":"@theokit/ui"}',
    }
  }
  const pushed = (committedAt: Date, aheadBy = 1) => {
    gh.versionBranch = { sha: 'version1', aheadBy, committedAt }
  }
  const afterPromotion = new Date(STARTED.getTime() + 4 * 60_000)

  it('opens the Version Packages pull request from it, and the publication keeps waiting', async () => {
    await waitingPublication()
    promotionOfAPackage()
    pushed(afterPromotion)
    // Version Packages #250 merged before this promotion: it belongs to the earlier release.
    gh.versionPr = versionPr({
      number: 250,
      state: 'closed',
      merged: true,
      mergedAt: new Date('2026-11-11T11:11:04Z'),
    })

    const result = await pollPublications(deps(LATER))

    expect(result).toMatchObject({ failed: [], published: [], waiting: 1, errors: [] })
    expect(gh.branchesRead).toEqual(['main...changeset-release/main'])
    expect(gh.opened).toEqual([
      expect.objectContaining({
        head: 'changeset-release/main',
        base: 'main',
        title: 'Version Packages',
        body: expect.stringContaining('promoted1'),
      }),
    ])
    expect(await row()).toMatchObject({ status: 'waiting', versionPullRequest: null })
    expect((await row()).detail).toMatch(
      /opened Version Packages #1975 from changeset-release\/main/,
    )
    expect(gh.created).toEqual([])
    expect(gh.merges).toEqual([])
  })

  it('opens it as soon as the branch is there, before the grace window ends', async () => {
    await waitingPublication()
    pushed(afterPromotion)

    const result = await pollPublications(deps())

    expect(result.waiting).toBe(1)
    expect(gh.opened).toHaveLength(1)
  })

  it('ends the publication as before when there is no version branch and no pull request', async () => {
    await waitingPublication()
    promotionOfAPackage()

    const result = await pollPublications(deps(LATER))

    expect(result.failed).toHaveLength(1)
    expect(gh.opened).toEqual([])
    expect(await row()).toMatchObject({ status: 'failed' })
    expect((await row()).detail).toMatch(/changes @theokit\/ui/)
  })

  it('ignores a version branch committed before the promotion', async () => {
    await waitingPublication()
    promotionOfAPackage()
    pushed(new Date(STARTED.getTime() - 60_000))

    const result = await pollPublications(deps(LATER))

    expect(result.failed).toHaveLength(1)
    expect(gh.branchesRead).toEqual(['main...changeset-release/main'])
    expect(gh.opened).toEqual([])
    expect(await row()).toMatchObject({ status: 'failed' })
  })

  it('ignores a version branch the release branch already holds', async () => {
    await waitingPublication()
    promotionOfAPackage()
    pushed(afterPromotion, 0)

    const result = await pollPublications(deps(LATER))

    expect(result.failed).toHaveLength(1)
    expect(gh.branchesRead).toEqual(['main...changeset-release/main'])
    expect(gh.opened).toEqual([])
  })
})

describe('merging the back-merge after a changesets release', () => {
  const backMerge = (fields: Partial<OpenPullRequest> = {}): OpenPullRequest => ({
    number: 1738,
    url: 'https://github.com/usetheokit/ui/pull/1738',
    headSha: 'main-head',
    headRef: 'main',
    headRepo: 'usetheokit/ui',
    baseRef: 'workspace',
    draft: false,
    ...fields,
  })
  async function publishedRelease() {
    await getDb().insert(repository).values({ fullName: 'usetheokit/ui', enabled: true })
    await waitingPublication()
    await getDb().update(publication).set({ status: 'published', versionPullRequest: 180 })
  }

  it('merges the open pull request from the release branch into the integration branch, with a merge commit pinned to its head', async () => {
    await publishedRelease()
    gh.open = [backMerge()]

    const result = await pollPublications(deps())

    expect(gh.asked).toContain('main -> workspace')
    expect(gh.merges).toEqual([{ number: 1738, sha: 'main-head', merge: { method: 'merge' } }])
    expect(result.backMerged).toEqual(['usetheokit/ui#1738'])
  })

  it('looks for it in the integration branch the owner chose', async () => {
    await publishedRelease()
    await getDb().update(repository).set({ baseBranch: 'next' })
    gh.open = [backMerge({ baseRef: 'next' })]

    await pollPublications(deps())

    expect(gh.asked).toContain('main -> next')
    expect(gh.merges).toEqual([{ number: 1738, sha: 'main-head', merge: { method: 'merge' } }])
  })

  it('leaves it open while its checks fail or run, and merges it on a later pass once they pass', async () => {
    await publishedRelease()
    gh.open = [backMerge()]
    const failing: CommitChecks = {
      checkRuns: [{ name: 'CI', status: 'completed', conclusion: 'failure' }],
      statuses: 'none',
    }
    const running: CommitChecks = {
      checkRuns: [{ name: 'CI', status: 'in_progress', conclusion: null }],
      statuses: 'none',
    }
    for (const checks of [failing, running, { checkRuns: [], statuses: 'none' } as CommitChecks]) {
      gh.checks = checks
      expect((await pollPublications(deps())).backMerged).toEqual([])
    }
    expect(gh.merges).toEqual([])

    gh.checks = green
    expect((await pollPublications(deps())).backMerged).toEqual(['usetheokit/ui#1738'])
  })

  it('never merges a draft, a pull request from another head, or one from a fork', async () => {
    await publishedRelease()
    gh.open = [
      backMerge({ draft: true }),
      backMerge({ number: 7, headRef: 'factory/7' }),
      backMerge({ number: 8, headRepo: 'someone/ui' }),
    ]

    const result = await pollPublications(deps())

    expect(gh.merges).toEqual([])
    expect(result.backMerged).toEqual([])
  })

  it('does not look in a repository that was disabled after its release', async () => {
    await publishedRelease()
    await getDb().update(repository).set({ enabled: false })
    gh.open = [backMerge()]

    await pollPublications(deps())

    expect(gh.asked).not.toContain('main -> workspace')
    expect(gh.merges).toEqual([])
  })

  it('records why the back-merge could not be looked at, and goes on', async () => {
    await publishedRelease()
    const broken = {
      ...api,
      openPullRequestsBetween: async () => {
        throw new Error('GitHub answered 502 listing pull requests of usetheokit/ui')
      },
    } as unknown as GithubApi

    const result = await pollPublications({ ...deps(), api: broken })

    expect(result.errors).toEqual([expect.stringMatching(/usetheokit\/ui: .*502/)])
  })
})
