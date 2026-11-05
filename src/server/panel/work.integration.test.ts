import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { plan, planItem, repository } from '../db/schema'
import type { ReachableRepository } from '../github/app'
import type { IssuesApi, NewIssue } from '../github/issues-api'

import { FakeBranches } from '../../test/fake-branches'

import { ActionRefused } from './actions'
import {
  createJob,
  createPlan,
  createPlanIssues,
  getPlan,
  listPlans,
  listRepositories,
  saveRepository,
  savePlanItems,
  startPlanItem,
  type WorkDeps,
} from './work'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  branches = new FakeBranches()
  await getPool().query('truncate table plan_item, plan, repository restart identity cascade')
  world.reachable = [
    { fullName: 'Paulo/App', private: true, defaultBranch: 'main' },
    { fullName: 'paulo/other', private: false, defaultBranch: 'trunk' },
  ]
  world.listing = undefined
  world.created = []
  world.labels = []
  world.milestones = []
  world.added = []
  world.failOn = undefined
  world.queued = []
  world.ownerFails = false
})
afterAll(() => getStorageManager().dispose())

const world = {
  reachable: [] as ReachableRepository[],
  listing: undefined as Error | undefined,
  created: [] as { repo: string; issue: NewIssue }[],
  labels: [] as string[],
  milestones: [] as string[],
  added: [] as { issue: number; labels: string[] }[],
  installations: [
    {
      id: 9,
      account: 'paulo',
      type: 'User' as const,
      selection: 'all' as const,
      url: 'https://github.com/settings/installations/9',
    },
  ],
  owner: 'paulo' as string,
  ownerFails: false,
  failOn: undefined as number | undefined,
  queued: [] as number[],
  tokens: [] as string[],
}

const issues: IssuesApi = {
  async createIssue(repo, _token, issue) {
    if (world.failOn !== undefined && world.created.length === world.failOn) {
      throw new Error('GitHub answered 502 creating an issue')
    }
    world.created.push({ repo, issue })
    const number = 100 + world.created.length
    return { number, url: `https://github.com/${repo}/issues/${number}` }
  },
  async ensureLabel(_r, _t, label) {
    world.labels.push(label.name)
  },
  async createMilestone(_r, _t, m) {
    world.milestones.push(m.title)
    return 7
  },
  async addLabels(_r, _t, issue, labels) {
    world.added.push({ issue, labels })
  },
}

let branches = new FakeBranches()

const deps = (): WorkDeps => ({
  db: getDb(),
  api: branches.api,
  github: {
    async installationToken(repo) {
      world.tokens.push(repo)
      return { token: 't', expiresAt: new Date(Date.now() + 3_600_000) }
    },
    async installationRepositories() {
      if (world.listing) throw world.listing
      return world.reachable
    },
    async installations() {
      return world.installations
    },
    async owner() {
      if (world.ownerFails) throw new Error('no')
      return world.owner
    },
  },
  issues,
  installUrl: 'https://github.com/apps/x/installations/new',
  agents: ['claude-code', 'codex'],
  inTransaction: (work) =>
    getDb().transaction((tx) =>
      work(tx as never, async (planId) => void world.queued.push(planId)),
    ),
})

const enable = async () => {
  await saveRepository(deps(), 'paulo/app', { enabled: true })
}

describe('the repositories page', () => {
  it('lists what the App reaches with what is saved about each, and none is enabled by default', async () => {
    const view = await listRepositories(deps())
    expect(view.installUrl).toBe('https://github.com/apps/x/installations/new')
    expect(view.agents).toEqual(['claude-code', 'codex'])
    expect(view.repositories.map((r) => [r.fullName, r.enabled, r.reachable])).toEqual([
      ['Paulo/App', false, true],
      ['paulo/other', false, true],
    ])
    expect(view.repositories[1]).toMatchObject({ private: false, defaultBranch: 'trunk' })
  })

  it('says where the App is installed and who owns it, so a private App is opened by its owner', async () => {
    const view = await listRepositories(deps())
    expect(view.installations).toEqual([
      { account: 'paulo', selection: 'all', url: 'https://github.com/settings/installations/9' },
    ])
    expect(view.owner).toBe('paulo')
  })

  it('still lists the repositories when the owner cannot be read', async () => {
    world.ownerFails = true
    const view = await listRepositories(deps())
    expect(view.owner).toBeNull()
    expect(view.repositories).toHaveLength(2)
  })

  it('enables a repository under the name GitHub gives it, whatever case was asked for', async () => {
    expect(await saveRepository(deps(), 'paulo/app', { enabled: true })).toEqual({
      fullName: 'Paulo/App',
    })
    const view = await listRepositories(deps())
    expect(view.repositories.find((r) => r.fullName === 'Paulo/App')?.enabled).toBe(true)
    expect(await getDb().select().from(repository)).toMatchObject([
      { fullName: 'Paulo/App', enabled: true },
    ])
  })

  it('refuses to enable a repository the App does not reach', async () => {
    await expect(saveRepository(deps(), 'paulo/secret', { enabled: true })).rejects.toThrow(
      /not one of the repositories the GitHub App can reach/,
    )
    expect(await getDb().select().from(repository)).toEqual([])
  })

  it('refuses when GitHub cannot be asked, instead of saving blind', async () => {
    world.listing = new Error('GitHub answered 401 listing installations')
    await expect(saveRepository(deps(), 'paulo/app', { enabled: true })).rejects.toThrow(
      /could not be asked/,
    )
  })

  it('still shows what is saved when GitHub cannot be asked, and says why', async () => {
    await enable()
    world.listing = new Error('GitHub answered 502 listing repositories')
    const view = await listRepositories(deps())
    expect(view.error).toBe('GitHub answered 502 listing repositories')
    expect(view.repositories).toMatchObject([
      { fullName: 'Paulo/App', enabled: true, reachable: false },
    ])
  })

  it('keeps an enabled repository the App stopped reaching, marked as unreachable', async () => {
    await enable()
    world.reachable = [world.reachable[1]]
    const view = await listRepositories(deps())
    expect(view.repositories.map((r) => [r.fullName, r.reachable])).toEqual([
      ['paulo/other', true],
      ['Paulo/App', false],
    ])
  })

  it('saves the checks, domains, agents and release mode, and clears checks with null', async () => {
    await enable()
    await saveRepository(deps(), 'paulo/app', {
      checks: [{ name: 'unit', command: '  pnpm test  ' }],
      egress: ['PyPI.org', 'pypi.org', 'files.pythonhosted.org'],
      harness: 'codex',
      reviewer: 'claude-code',
      releaseMode: 'trial',
    })
    let [row] = await getDb().select().from(repository)
    expect(row).toMatchObject({
      checks: [{ name: 'unit', command: 'pnpm test' }],
      egress: ['pypi.org', 'files.pythonhosted.org'],
      harness: 'codex',
      reviewer: 'claude-code',
      releaseMode: 'trial',
      enabled: true,
    })

    await saveRepository(deps(), 'paulo/app', { checks: null, harness: null, releaseMode: null })
    ;[row] = await getDb().select().from(repository)
    expect(row).toMatchObject({
      checks: null,
      harness: null,
      releaseMode: null,
      reviewer: 'claude-code',
    })
  })

  it('creates the integration and pre-release branches when a repository is enabled, and touches none that exist', async () => {
    await enable()
    expect(branches.created).toEqual(['workspace', 'develop'])

    branches = FakeBranches.prepared()
    await saveRepository(deps(), 'paulo/app', { harness: 'codex' })
    expect(branches.created).toEqual([])
  })

  it('does not prepare a repository that stays disabled', async () => {
    await saveRepository(deps(), 'paulo/app', { checks: [{ name: 'unit', command: 'pnpm test' }] })
    expect(branches.created).toEqual([])
  })

  it('refuses to enable a repository whose branches cannot be prepared, and saves nothing', async () => {
    await expect(
      saveRepository(deps(), 'paulo/app', { enabled: true, baseBranch: 'main' }),
    ).rejects.toThrow(/could not be prepared.*only a release reaches/)
    expect(await getDb().select().from(repository)).toEqual([])
    expect(branches.created).toEqual([])
  })

  it('saves the branch the work starts from, shows it, and goes back to the default with null', async () => {
    await enable()
    await saveRepository(deps(), 'paulo/app', { baseBranch: 'develop' })
    let [row] = await getDb().select().from(repository)
    expect(row.baseBranch).toBe('develop')
    const view = await listRepositories(deps())
    expect(view.repositories.find((r) => r.fullName === 'Paulo/App')?.baseBranch).toBe('develop')

    await saveRepository(deps(), 'paulo/app', { baseBranch: null })
    ;[row] = await getDb().select().from(repository)
    expect(row.baseBranch).toBeNull()
  })

  it('leaves the branch alone when a patch does not mention it', async () => {
    await enable()
    await saveRepository(deps(), 'paulo/app', { baseBranch: 'develop' })
    await saveRepository(deps(), 'paulo/app', { harness: 'codex' })
    const [row] = await getDb().select().from(repository)
    expect(row.baseBranch).toBe('develop')
  })

  it('saves the release branch, prepares the repository from it, and clears it with null', async () => {
    branches.defaultName = 'develop'
    branches.heads.set('develop', 'd'.repeat(40))
    branches.heads.set('main', 'e'.repeat(40))
    await expect(saveRepository(deps(), 'paulo/app', { enabled: true })).rejects.toThrow(
      /default branch is develop.*name another release branch/,
    )

    await saveRepository(deps(), 'paulo/app', { enabled: true, releaseBranch: 'main' })
    const [row] = await getDb().select().from(repository)
    expect(row.releaseBranch).toBe('main')
    expect(branches.heads.get('workspace')).toBe('e'.repeat(40))
    const view = await listRepositories(deps())
    expect(view.repositories.find((r) => r.fullName === 'Paulo/App')?.releaseBranch).toBe('main')

    // Going back to the default branch is refused while the default branch is develop, and nothing changes.
    await expect(saveRepository(deps(), 'paulo/app', { releaseBranch: null })).rejects.toThrow(
      /name another release branch/,
    )
    expect((await getDb().select().from(repository))[0].releaseBranch).toBe('main')
  })

  it('refuses a branch name git would not take', async () => {
    await enable()
    await expect(saveRepository(deps(), 'paulo/app', { baseBranch: '-x' })).rejects.toThrow(
      '"-x" is not a branch name',
    )
  })

  it('refuses what the factory could not use', async () => {
    await enable()
    const bad = (patch: Parameters<typeof saveRepository>[2]) =>
      saveRepository(deps(), 'paulo/app', patch)
    await expect(bad({ egress: ['not a domain'] })).rejects.toThrow(
      '"not a domain" is not a domain name',
    )
    await expect(bad({ egress: ['localhost'] })).rejects.toThrow(/not a domain name/)
    await expect(bad({ harness: 'gpt' })).rejects.toThrow(
      'unknown agent "gpt" (known: claude-code, codex)',
    )
    await expect(bad({ checks: [{ name: 'Bad Name', command: 'x' }] })).rejects.toThrow(
      /not a check name/,
    )
    await expect(bad({ checks: [{ name: 'a', command: '' }] })).rejects.toThrow(/one line/)
    await expect(bad({ checks: [{ name: 'a', command: 'x\ny' }] })).rejects.toThrow(/one line/)
    await expect(
      bad({
        checks: [
          { name: 'a', command: 'x' },
          { name: 'a', command: 'y' },
        ],
      }),
    ).rejects.toThrow('two checks are named "a"')
    await expect(
      bad({ checks: Array.from({ length: 9 }, (_, i) => ({ name: `c${i}`, command: 'x' })) }),
    ).rejects.toThrow('at most 8 checks')
    await expect(
      bad({ egress: Array.from({ length: 21 }, (_, i) => `a${i}.com`) }),
    ).rejects.toThrow('at most 20 domains')
  })
})

describe('a job from the panel', () => {
  it('opens a labelled issue that the webhook turns into a task, and says it came from the panel', async () => {
    await enable()
    const created = await createJob(deps(), {
      repository: 'paulo/app',
      title: '  Add truncate  ',
      body: 'Write it.',
      start: true,
      harness: 'codex',
    })

    expect(created).toEqual({
      repository: 'Paulo/App',
      number: 101,
      url: 'https://github.com/Paulo/App/issues/101',
      started: true,
    })
    expect(world.labels).toEqual(['factory'])
    expect(world.created[0].issue).toMatchObject({
      title: 'Add truncate',
      labels: ['factory', 'harness:codex'],
    })
    expect(world.created[0].issue.body).toContain('Write it.')
    expect(world.created[0].issue.body).toContain('Opened from the aifactory panel')
    expect(world.tokens.at(-1)).toBe('Paulo/App')
  })

  it('opens an issue without the label when it should wait, and creates no label for it', async () => {
    await enable()
    await createJob(deps(), { repository: 'paulo/app', title: 'Later', body: '', start: false })
    expect(world.created[0].issue.labels).toEqual([])
    expect(world.labels).toEqual([])
  })

  it('refuses a repository that is not enabled, a bad title, a huge description and an unknown agent', async () => {
    const job = (over: object) => ({
      repository: 'paulo/app',
      title: 't',
      body: '',
      start: true,
      ...over,
    })
    await expect(createJob(deps(), job({}))).rejects.toThrow(/is not enabled/)
    await enable()
    await expect(createJob(deps(), job({ title: '   ' }))).rejects.toThrow('1 to 200 characters')
    await expect(createJob(deps(), job({ title: 'x'.repeat(201) }))).rejects.toThrow(
      '1 to 200 characters',
    )
    await expect(createJob(deps(), job({ body: 'x'.repeat(10_001) }))).rejects.toThrow('10,000')
    await expect(createJob(deps(), job({ reviewer: 'nope' }))).rejects.toThrow(/unknown reviewer/)
    expect(world.created).toEqual([])
  })
})

describe('plans', () => {
  const ready = async (items = 3) => {
    await enable()
    const { planId } = await createPlan(deps(), {
      repository: 'paulo/app',
      goal: 'Add a command line',
    })
    await getDb().update(plan).set({ status: 'ready' }).where(eq(plan.id, planId))
    await getDb()
      .insert(planItem)
      .values(
        Array.from({ length: items }, (_, i) => ({
          planId,
          position: i,
          title: `Item ${i}`,
          body: `Body ${i}`,
        })),
      )
    return planId
  }

  it('starts a plan in the same transaction that queues its job', async () => {
    await enable()
    const { planId } = await createPlan(deps(), {
      repository: 'paulo/app',
      goal: '  Add a command line  ',
    })
    expect(world.queued).toEqual([planId])
    expect(await getPlan(getDb(), planId)).toMatchObject({
      repository: 'Paulo/App',
      goal: 'Add a command line',
      status: 'planning',
      items: [],
    })
  })

  it('queues nothing when the plan cannot be saved', async () => {
    await enable()
    const broken = {
      ...deps(),
      inTransaction: async () => {
        throw new Error('queue is down')
      },
    }
    await expect(
      createPlan(broken, { repository: 'paulo/app', goal: 'Add a command line' }),
    ).rejects.toThrow('queue is down')
    expect(await getDb().select().from(plan)).toEqual([])
  })

  it('refuses a repository that is not enabled, a short goal and a long one', async () => {
    await expect(
      createPlan(deps(), { repository: 'paulo/app', goal: 'Add a command line' }),
    ).rejects.toThrow(/is not enabled/)
    await enable()
    await expect(
      createPlan(deps(), { repository: 'paulo/app', goal: 'too short' }),
    ).rejects.toThrow('at least 10')
    await expect(
      createPlan(deps(), { repository: 'paulo/app', goal: 'x'.repeat(4_001) }),
    ).rejects.toThrow('4000')
  })

  it('lists plans newest first without their items, and finds one with them in order', async () => {
    const first = await ready(2)
    const second = await ready(1)
    expect((await listPlans(getDb())).map((p) => p.id)).toEqual([second, first])
    expect((await listPlans(getDb()))[0].items).toEqual([])
    expect((await getPlan(getDb(), first))?.items.map((i) => i.title)).toEqual(['Item 0', 'Item 1'])
    expect(await getPlan(getDb(), 9_999)).toBeUndefined()
  })

  it('saves edits: titles, bodies, selection, order, new items, and removes the ones left out', async () => {
    const id = await ready(3)
    const before = (await getPlan(getDb(), id))!.items

    await savePlanItems(getDb(), id, [
      { id: before[2].id, title: 'Third, first now', body: 'b', selected: true },
      { id: before[0].id, title: 'First, edited', body: 'new body', selected: false },
      { title: 'Brand new', body: 'added', selected: true },
    ])

    const items = (await getPlan(getDb(), id))!.items
    expect(items.map((i) => [i.title, i.selected])).toEqual([
      ['Third, first now', true],
      ['First, edited', false],
      ['Brand new', true],
    ])
    expect(items.map((i) => i.position)).toEqual([0, 1, 2])
  })

  it('refuses edits to a plan still being made, to one that is missing, and to bad text', async () => {
    await enable()
    const { planId } = await createPlan(deps(), {
      repository: 'paulo/app',
      goal: 'Add a command line',
    })
    await expect(savePlanItems(getDb(), planId, [])).rejects.toThrow(/once the agent has finished/)
    await expect(savePlanItems(getDb(), 999, [])).rejects.toThrow('does not exist')
    const id = await ready(1)
    await expect(
      savePlanItems(getDb(), id, [{ title: ' ', body: '', selected: true }]),
    ).rejects.toThrow('1 to 200')
    await expect(
      savePlanItems(getDb(), id, [{ title: 't', body: 'x'.repeat(10_001), selected: true }]),
    ).rejects.toThrow('10,000')
  })

  it('creates one issue per selected item under one milestone, labelled to start at once', async () => {
    const id = await ready(3)
    const items = (await getPlan(getDb(), id))!.items
    await getDb().update(planItem).set({ selected: false }).where(eq(planItem.id, items[1].id))

    const result = await createPlanIssues(deps(), id, { start: true })

    expect(result).toEqual({ created: [101, 102], failure: null })
    expect(world.milestones).toEqual(['Plan ' + id + ': Add a command line'])
    expect(world.created.map((c) => [c.issue.title, c.issue.labels, c.issue.milestone])).toEqual([
      ['Item 0', ['factory'], 7],
      ['Item 2', ['factory'], 7],
    ])
    expect(world.created[0].issue.body).toContain(`Planned (plan ${id})`)
    const after = (await getPlan(getDb(), id))!
    expect(after.status).toBe('created')
    expect(after.milestoneNumber).toBe(7)
    expect(after.items.map((i) => [i.issueNumber, i.started])).toEqual([
      [101, true],
      [null, false],
      [102, true],
    ])
  })

  it('creates the issues without the label when asked to wait, and starts one later', async () => {
    const id = await ready(2)
    await createPlanIssues(deps(), id, { start: false })
    expect(world.created.map((c) => c.issue.labels)).toEqual([[], []])
    expect(world.labels).toEqual([])
    const [first] = (await getPlan(getDb(), id))!.items

    await startPlanItem(deps(), id, first.id)

    expect(world.added).toEqual([{ issue: 101, labels: ['factory'] }])
    expect((await getPlan(getDb(), id))!.items[0].started).toBe(true)
    await expect(startPlanItem(deps(), id, first.id)).rejects.toThrow('already started')
  })

  it('stops at an item GitHub refuses, keeps the issues already made, and carries on next time', async () => {
    const id = await ready(3)
    world.failOn = 1

    const first = await createPlanIssues(deps(), id, { start: true })

    expect(first).toEqual({ created: [101], failure: 'GitHub answered 502 creating an issue' })
    expect((await getPlan(getDb(), id))!.status).toBe('ready')
    world.failOn = undefined

    const second = await createPlanIssues(deps(), id, { start: true })

    expect(second.created).toEqual([102, 103])
    expect((await getPlan(getDb(), id))!.status).toBe('created')
    expect(world.milestones).toHaveLength(1)
  })

  it('refuses when nothing is waiting, the plan is not ready, or the item cannot be started', async () => {
    const id = await ready(1)
    await createPlanIssues(deps(), id, { start: true })
    await expect(createPlanIssues(deps(), id, { start: true })).rejects.toThrow(
      'no selected item is waiting',
    )
    await expect(createPlanIssues(deps(), 999, { start: true })).rejects.toThrow('does not exist')
    await expect(startPlanItem(deps(), id, 9_999)).rejects.toThrow('does not exist')

    const waiting = (
      await createPlan(deps(), { repository: 'paulo/app', goal: 'Another goal here' })
    ).planId
    await expect(createPlanIssues(deps(), waiting, { start: true })).rejects.toThrow(
      'not ready yet',
    )

    const other = await ready(1)
    const [item] = (await getPlan(getDb(), other))!.items
    await expect(startPlanItem(deps(), other, item.id)).rejects.toThrow('not an issue yet')
  })

  it('does not touch GitHub for a repository that was switched off after the plan was made', async () => {
    const id = await ready(1)
    await saveRepository(deps(), 'paulo/app', { enabled: false })
    await expect(createPlanIssues(deps(), id, { start: true })).rejects.toThrow(/is not enabled/)
    expect(world.created).toEqual([])
    expect(ActionRefused).toBeDefined()
  })
})
