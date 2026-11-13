import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { plan, planItem } from '../db/schema'

import { FakeGithub } from '../../test/fake-github'

import { FakeSandbox } from './fake-sandbox'
import type { CodingHarness, HarnessResult } from './harness'
import { runPlan, type PlanDeps } from './plan'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query('truncate table plan_item, plan, repository restart identity cascade')
})
afterAll(() => getStorageManager().dispose())

const asked: string[] = []
const github = {
  async installationToken(repo: string) {
    asked.push(repo)
    return { token: 'ghs_plan', expiresAt: new Date(Date.now() + 3_600_000) }
  },
}

const answer = (summary: string, over: Partial<HarnessResult> = {}) => ({
  ok: true,
  summary,
  costUsd: 0.07,
  ...over,
})

function agent(result: HarnessResult | (() => never)) {
  const prompts: string[] = []
  const harness: CodingHarness & { prompts: string[]; labels: string[][] } = {
    name: 'planner-agent',
    egress: async () => [{ domain: 'api.anthropic.com', headers: { 'x-api-key': 'k' } }],
    prompts,
    labels: [],
    run: async (_b, input) => {
      prompts.push(input.prompt)
      if (typeof result === 'function') return result()
      return result
    },
  }
  return harness
}

/** A GitHub where the repository already has the integration and pre-release branches. */
const prepared = () => {
  const api = new FakeGithub()
  api.repo('paulo/app').prepare()
  return api
}

const deps = (
  harness: CodingHarness & { labels: string[][] },
  sandbox = new FakeSandbox(),
  api = prepared(),
): PlanDeps => ({
  db: getDb(),
  github,
  api,
  sandbox,
  harness: (labels) => {
    harness.labels.push(labels)
    return harness
  },
})

async function newPlan(goal = 'Add a CLI', repository = 'paulo/app') {
  const [row] = await getDb().insert(plan).values({ repository, goal }).returning({ id: plan.id })
  return row.id
}

const planned = JSON.stringify({
  summary: 'Two steps.',
  issues: [
    { title: 'Parse arguments', body: 'Read argv.\n\n- returns the flags' },
    { title: 'Print help', body: 'Print usage.' },
  ],
})

describe('runPlan', () => {
  it('turns the agent answer into a ready plan with its items, in order, and the cost', async () => {
    const id = await newPlan()
    const harness = agent(answer(`I read it.\n${planned}`))
    const sandbox = new FakeSandbox()

    await runPlan(deps(harness, sandbox), id)

    const [row] = await getDb().select().from(plan).where(eq(plan.id, id))
    expect(row).toMatchObject({ status: 'ready', summary: 'Two steps.', error: null })
    expect(row.costUsd).toBeCloseTo(0.07)
    const items = await getDb()
      .select()
      .from(planItem)
      .where(eq(planItem.planId, id))
      .orderBy(planItem.position)
    expect(items.map((i) => [i.position, i.title, i.selected, i.issueNumber])).toEqual([
      [0, 'Parse arguments', true, null],
      [1, 'Print help', true, null],
    ])
    expect(harness.prompts[0]).toContain('Add a CLI')
    expect(harness.prompts[0]).toContain('paulo/app')
    expect(asked).toContain('paulo/app')
    expect(sandbox.stopped).toBe(1)
  })

  it('reads the integration branch, creating it and the pre-release branch when the repository has none', async () => {
    const id = await newPlan()
    const sandbox = new FakeSandbox()
    const api = new FakeGithub()

    await runPlan(deps(agent(answer(planned)), sandbox, api), id)

    expect(api.answered('createBranch').map(([branch]) => branch)).toEqual(['workspace', 'develop'])
    expect(sandbox.backend.commands.some((c) => /checkout .*workspace/.test(c))).toBe(true)
    const [row] = await getDb().select().from(plan).where(eq(plan.id, id))
    expect(row.status).toBe('ready')
  })

  it('reads the branch the owner chose for the repository', async () => {
    await getPool().query(
      `insert into repository (full_name, enabled, base_branch) values ('Paulo/App', true, 'staging')`,
    )
    const id = await newPlan()
    const sandbox = new FakeSandbox()

    await runPlan(deps(agent(answer(planned)), sandbox), id)

    expect(sandbox.backend.commands.some((c) => /checkout .*staging/.test(c))).toBe(true)
  })

  it('fails the plan, without a sandbox, when the repository cannot be prepared', async () => {
    await getPool().query(
      `insert into repository (full_name, enabled, base_branch) values ('Paulo/App', true, 'main')`,
    )
    const id = await newPlan()
    const sandbox = new FakeSandbox()

    await runPlan(deps(agent(answer(planned)), sandbox), id)

    const [row] = await getDb().select().from(plan).where(eq(plan.id, id))
    expect(row.status).toBe('failed')
    expect(row.error).toContain('only a release reaches')
    expect(sandbox.specs).toEqual([])
  })

  it('opens the sandbox to GitHub with the token, the agent, npm and what the owner added', async () => {
    await getPool().query(
      `insert into repository (full_name, enabled, egress) values ('Paulo/App', true, '["pypi.org"]')`,
    )
    const id = await newPlan()
    const sandbox = new FakeSandbox()

    await runPlan(deps(agent(answer(planned)), sandbox), id)

    const byDomain = Object.fromEntries(
      sandbox.specs[0].egress.map((r) => [r.domain, r.headers ?? {}]),
    )
    expect(Object.keys(byDomain).sort()).toEqual(
      ['api.anthropic.com', 'github.com', 'pypi.org', 'registry.npmjs.org'].sort(),
    )
    expect(byDomain['github.com'].authorization).toMatch(/^Basic /)
  })

  it('asks for the agent the owner set for the repository', async () => {
    await getPool().query(
      `insert into repository (full_name, enabled, harness) values ('paulo/app', true, 'codex')`,
    )
    const harness = agent(answer(planned))
    await runPlan(deps(harness), await newPlan())
    expect(harness.labels[0]).toContain('harness:codex')
  })

  it('fails the plan, with the reason, when the agent ends without a usable plan', async () => {
    const id = await newPlan()
    await runPlan(deps(agent(answer('I could not decide.'))), id)
    const [row] = await getDb().select().from(plan).where(eq(plan.id, id))
    expect(row).toMatchObject({
      status: 'failed',
      error: 'the agent did not end with a usable plan',
    })
    expect(await getDb().select().from(planItem)).toEqual([])
  })

  it('fails the plan when the agent did not finish, and when its quota ran out', async () => {
    const a = await newPlan()
    await runPlan(deps(agent({ ok: false, summary: 'it crashed' })), a)
    expect((await getDb().select().from(plan).where(eq(plan.id, a)))[0].error).toBe(
      'the agent did not finish: it crashed',
    )

    const b = await newPlan()
    await runPlan(
      deps(
        agent({
          ok: false,
          summary: 'limit',
          costUsd: 0.02,
          quota: { message: 'usage limit', resetsAt: 'tomorrow' },
        }),
      ),
      b,
    )
    const [row] = await getDb().select().from(plan).where(eq(plan.id, b))
    expect(row).toMatchObject({
      status: 'failed',
      error: 'the planner-agent quota ran out: usage limit',
    })
    expect(row.costUsd).toBeCloseTo(0.02)
  })

  it('records a crash on the plan instead of throwing, and still stops the sandbox', async () => {
    const id = await newPlan()
    const sandbox = new FakeSandbox()
    const harness = agent(() => {
      throw new Error('the sandbox died')
    })

    await expect(runPlan(deps(harness, sandbox), id)).resolves.toBeUndefined()

    const [row] = await getDb().select().from(plan).where(eq(plan.id, id))
    expect(row).toMatchObject({ status: 'failed', error: 'the sandbox died' })
    expect(sandbox.stopped).toBe(1)
  })

  it('leaves a plan alone that is not waiting to be planned, and one that is not there', async () => {
    const id = await newPlan()
    await getDb().update(plan).set({ status: 'created' }).where(eq(plan.id, id))
    const harness = agent(answer(planned))

    await runPlan(deps(harness), id)
    await runPlan(deps(harness), 999)

    expect(harness.prompts).toEqual([])
    expect((await getDb().select().from(plan).where(eq(plan.id, id)))[0].status).toBe('created')
  })
})
