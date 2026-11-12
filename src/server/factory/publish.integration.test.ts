import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { delivery, ingress, publication, repository, stageEvent, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import type {
  CommitChecks,
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
  commitChecks: async () => gh.checks,
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
} as unknown as GithubApi
const github: GithubApp = { installationToken: async () => ({ token: 't', expiresAt: new Date() }) }
const deps = () => ({ db: getDb(), github, api })

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
