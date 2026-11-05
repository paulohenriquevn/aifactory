import { and, asc, desc, eq, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { plan, planItem, repository } from '../db/schema'
import { ensureBranches, integrationBranch } from '../factory/branches'
import { DOMAIN, validBranch } from '../factory/repo-config'
import type { AppRepos, GithubApp, ReachableRepository } from '../github/app'
import type { IssuesApi } from '../github/issues-api'
import type { GithubApi } from '../github/pulls'
import type { PlanItemView, PlanView, RepositoriesView, RepositoryView } from '../../shared/panel'

import { ActionRefused } from './actions'

/** The label that asks the factory to take an issue. */
export const FACTORY_LABEL = 'factory'

export type WorkDeps = {
  db: Database
  github: GithubApp & AppRepos
  issues: IssuesApi
  /** What it takes to make sure a repository has its integration and pre-release branches. */
  api: Pick<GithubApi, 'defaultBranch' | 'branchHead' | 'createBranch'>
  /** Where GitHub lets the owner pick the repositories the App reaches. */
  installUrl?: string
  /** The agents the owner may pick for a repository. */
  agents: string[]
  /** Runs `work` in a transaction, with `plan-run` queued through that transaction. */
  inTransaction: <T>(
    work: (tx: Database, enqueuePlan: (planId: number) => Promise<void>) => Promise<T>,
  ) => Promise<T>
}

const iso = (date: Date) => date.toISOString()

/* ------------------------------------------------------------------ repositories */

export type RepositoryPatch = {
  enabled?: boolean
  /** `null` clears the owner's checks, so the default (`npm test`) applies. */
  checks?: { name: string; command: string }[] | null
  egress?: string[]
  /** `null` clears it, so the default branch applies. */
  baseBranch?: string | null
  harness?: string | null
  reviewer?: string | null
  releaseMode?: 'manual' | 'trial' | 'auto' | null
}

const CHECK_NAME = /^[a-z0-9][a-z0-9_-]{0,30}$/
const MAX_CHECKS = 8
const MAX_DOMAINS = 20

/** Why a patch cannot be saved, or nothing when it can. The panel shows the message as it is. */
export function patchProblem(patch: RepositoryPatch, agents: string[]): string | undefined {
  if (patch.checks) {
    if (patch.checks.length > MAX_CHECKS) return `at most ${MAX_CHECKS} checks`
    const names = new Set<string>()
    for (const check of patch.checks) {
      if (!CHECK_NAME.test(check.name)) {
        return `"${check.name}" is not a check name: use lowercase letters, digits, - and _`
      }
      if (names.has(check.name)) return `two checks are named "${check.name}"`
      names.add(check.name)
      const command = check.command.trim()
      if (command === '' || command.length > 500 || command.includes('\n')) {
        return `the command of "${check.name}" must be one line of at most 500 characters`
      }
    }
  }
  if (patch.baseBranch && !validBranch(patch.baseBranch)) {
    return `"${patch.baseBranch}" is not a branch name`
  }
  if (patch.egress) {
    if (patch.egress.length > MAX_DOMAINS) return `at most ${MAX_DOMAINS} domains`
    for (const domain of patch.egress) {
      if (!DOMAIN.test(domain.toLowerCase())) return `"${domain}" is not a domain name`
    }
  }
  for (const [kind, name] of [
    ['agent', patch.harness],
    ['reviewer', patch.reviewer],
  ] as const) {
    if (name && !agents.includes(name)) {
      return `unknown ${kind} "${name}" (known: ${agents.join(', ')})`
    }
  }
  return undefined
}

async function reachable(deps: WorkDeps): Promise<ReachableRepository[] | Error> {
  try {
    return await deps.github.installationRepositories()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

/** The repositories the App reaches, merged with what the owner saved about each. */
export async function listRepositories(deps: WorkDeps): Promise<RepositoriesView> {
  const [found, saved, installations, owner] = await Promise.all([
    reachable(deps),
    deps.db.select().from(repository).orderBy(asc(repository.fullName)),
    deps.github.installations().catch(() => []),
    deps.github.owner().catch(() => null),
  ])
  const byName = new Map(saved.map((r) => [r.fullName.toLowerCase(), r]))
  const view = (
    fullName: string,
    github: Pick<ReachableRepository, 'private' | 'defaultBranch'> | undefined,
  ): RepositoryView => {
    const row = byName.get(fullName.toLowerCase())
    return {
      fullName,
      private: github?.private ?? true,
      defaultBranch: github?.defaultBranch ?? '',
      reachable: github !== undefined,
      enabled: row?.enabled ?? false,
      checks: row?.checks ?? null,
      egress: row?.egress ?? [],
      baseBranch: row?.baseBranch ?? null,
      harness: row?.harness ?? null,
      reviewer: row?.reviewer ?? null,
      releaseMode: row?.releaseMode ?? null,
    }
  }
  const repositories =
    found instanceof Error
      ? saved.map((r) => view(r.fullName, undefined))
      : [
          ...found.map((r) => view(r.fullName, r)),
          ...saved
            .filter(
              (r) => !found.some((f) => f.fullName.toLowerCase() === r.fullName.toLowerCase()),
            )
            .map((r) => view(r.fullName, undefined)),
        ]
  return {
    repositories,
    agents: deps.agents,
    installUrl: deps.installUrl ?? null,
    installations: installations.map(({ account, selection, url }) => ({
      account,
      selection,
      url,
    })),
    owner,
    error: found instanceof Error ? found.message : null,
  }
}

/**
 * Saves what the owner set for a repository. A repository the App does not reach cannot be created or
 * enabled, so the list is also the limit of what the factory can be pointed at.
 */
export async function saveRepository(
  deps: WorkDeps,
  fullName: string,
  patch: RepositoryPatch,
): Promise<{ fullName: string }> {
  const problem = patchProblem(patch, deps.agents)
  if (problem) throw new ActionRefused(problem)

  const [existing] = await deps.db
    .select()
    .from(repository)
    .where(sql`lower(${repository.fullName}) = lower(${fullName})`)
  let canonical = existing?.fullName
  if (!existing || patch.enabled) {
    const found = await reachable(deps)
    if (found instanceof Error)
      throw new ActionRefused(`GitHub could not be asked: ${found.message}`)
    const match = found.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase())
    if (!match) {
      throw new ActionRefused(
        `${fullName} is not one of the repositories the GitHub App can reach: give the App access to it first`,
      )
    }
    canonical = match.fullName
  }
  const enabledAfter = patch.enabled ?? existing?.enabled ?? false
  if (enabledAfter) {
    const base = patch.baseBranch === undefined ? existing?.baseBranch : patch.baseBranch
    try {
      const { token } = await deps.github.installationToken(canonical!)
      await ensureBranches(deps.api, canonical!, token, integrationBranch({ baseBranch: base }))
    } catch (error) {
      throw new ActionRefused(
        `${canonical} could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const values = {
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.checks === undefined
      ? {}
      : {
          checks: patch.checks
            ? patch.checks.map((c) => ({ ...c, command: c.command.trim() }))
            : null,
        }),
    ...(patch.egress === undefined
      ? {}
      : { egress: [...new Set(patch.egress.map((d) => d.toLowerCase()))] }),
    ...(patch.baseBranch === undefined ? {} : { baseBranch: patch.baseBranch }),
    ...(patch.harness === undefined ? {} : { harness: patch.harness }),
    ...(patch.reviewer === undefined ? {} : { reviewer: patch.reviewer }),
    ...(patch.releaseMode === undefined ? {} : { releaseMode: patch.releaseMode }),
    updatedAt: new Date(),
  }
  await deps.db
    .insert(repository)
    .values({ fullName: canonical!, ...values })
    .onConflictDoUpdate({ target: repository.fullName, set: values })
  return { fullName: canonical! }
}

/** The repository's row when it is enabled, or the reason the owner has to fix first. */
async function enabledRepository(deps: WorkDeps, fullName: string) {
  const [row] = await deps.db
    .select()
    .from(repository)
    .where(sql`lower(${repository.fullName}) = lower(${fullName})`)
  if (!row?.enabled) {
    throw new ActionRefused(`${fullName} is not enabled: enable it under Repositories first`)
  }
  return row
}

const FOOTER = (what: string) => `\n\n---\n_${what} from the aifactory panel._`

async function readyFactoryLabel(deps: WorkDeps, repo: string, token: string) {
  await deps.issues.ensureLabel(repo, token, {
    name: FACTORY_LABEL,
    color: '5319e7',
    description: 'The factory builds this issue',
  })
}

/* ------------------------------------------------------------------ one job */

export type NewJob = {
  repository: string
  title: string
  body: string
  /** Put the `factory` label on at once, which is what starts the work. */
  start: boolean
  harness?: string
  reviewer?: string
}

/** Opens one issue from the panel. The task comes from the issue's webhook, like any other. */
export async function createJob(deps: WorkDeps, job: NewJob) {
  const row = await enabledRepository(deps, job.repository)
  const problem = patchProblem({ harness: job.harness, reviewer: job.reviewer }, deps.agents)
  if (problem) throw new ActionRefused(problem)
  const title = job.title.trim()
  if (title === '' || title.length > 200)
    throw new ActionRefused('the title must be 1 to 200 characters')
  if (job.body.length > 10_000)
    throw new ActionRefused('the description is longer than 10,000 characters')

  const { token } = await deps.github.installationToken(row.fullName)
  if (job.start) await readyFactoryLabel(deps, row.fullName, token)
  const created = await deps.issues.createIssue(row.fullName, token, {
    title,
    body: `${job.body.trim()}${FOOTER('Opened')}`,
    labels: [
      ...(job.start ? [FACTORY_LABEL] : []),
      ...(job.harness ? [`harness:${job.harness}`] : []),
      ...(job.reviewer ? [`reviewer:${job.reviewer}`] : []),
    ],
  })
  return { repository: row.fullName, ...created, started: job.start }
}

/* ------------------------------------------------------------------ plans */

const GOAL_MIN = 10
const GOAL_MAX = 4_000

/** Starts a plan: the row and the job that has an agent read the repository commit together. */
export async function createPlan(deps: WorkDeps, input: { repository: string; goal: string }) {
  const row = await enabledRepository(deps, input.repository)
  const goal = input.goal.trim()
  if (goal.length < GOAL_MIN)
    throw new ActionRefused(`describe the goal in at least ${GOAL_MIN} characters`)
  if (goal.length > GOAL_MAX)
    throw new ActionRefused(`the goal is longer than ${GOAL_MAX} characters`)
  return deps.inTransaction(async (tx, enqueuePlan) => {
    const [created] = await tx
      .insert(plan)
      .values({ repository: row.fullName, goal })
      .returning({ id: plan.id })
    await enqueuePlan(created.id)
    return { planId: created.id }
  })
}

function itemView(i: typeof planItem.$inferSelect): PlanItemView {
  return {
    id: i.id,
    position: i.position,
    title: i.title,
    body: i.body,
    selected: i.selected,
    issueNumber: i.issueNumber,
    issueUrl: i.issueUrl,
    started: i.started,
  }
}

const planView = (
  p: typeof plan.$inferSelect,
  items: (typeof planItem.$inferSelect)[],
): PlanView => ({
  id: p.id,
  repository: p.repository,
  goal: p.goal,
  status: p.status,
  summary: p.summary,
  error: p.error,
  costUsd: p.costUsd,
  milestoneNumber: p.milestoneNumber,
  createdAt: iso(p.createdAt),
  items: items.map(itemView),
})

export async function listPlans(db: Database): Promise<PlanView[]> {
  const plans = await db.select().from(plan).orderBy(desc(plan.id)).limit(50)
  return plans.map((p) => planView(p, []))
}

export async function getPlan(db: Database, id: number): Promise<PlanView | undefined> {
  const [p] = await db.select().from(plan).where(eq(plan.id, id))
  if (!p) return undefined
  const items = await db
    .select()
    .from(planItem)
    .where(eq(planItem.planId, id))
    .orderBy(asc(planItem.position))
  return planView(p, items)
}

export type PlanItemEdit = { id?: number; title: string; body: string; selected: boolean }

/**
 * Saves the owner's edits to a plan that is ready: titles, bodies, which items are in, and their order.
 * An item that already became an issue stays as it is; the others are replaced by what was sent, so an
 * item left out is removed and one without an id is added.
 */
export async function savePlanItems(db: Database, planId: number, edits: PlanItemEdit[]) {
  const current = await getPlan(db, planId)
  if (!current) throw new ActionRefused('this plan does not exist')
  if (current.status !== 'ready' && current.status !== 'created') {
    throw new ActionRefused('a plan can be edited once the agent has finished it')
  }
  for (const edit of edits) {
    if (edit.title.trim() === '' || edit.title.length > 200) {
      throw new ActionRefused('each title must be 1 to 200 characters')
    }
    if (edit.body.length > 10_000)
      throw new ActionRefused('a description is longer than 10,000 characters')
  }
  await db.transaction(async (tx) => {
    const issued = new Set(current.items.filter((i) => i.issueNumber !== null).map((i) => i.id))
    const keep = new Set(edits.flatMap((e) => (e.id !== undefined ? [e.id] : [])))
    for (const item of current.items) {
      if (!issued.has(item.id) && !keep.has(item.id)) {
        await tx.delete(planItem).where(eq(planItem.id, item.id))
      }
    }
    for (const [position, edit] of edits.entries()) {
      if (edit.id !== undefined && issued.has(edit.id)) continue
      const values = {
        title: edit.title.trim(),
        body: edit.body.trim(),
        selected: edit.selected,
        position,
      }
      if (edit.id !== undefined) {
        await tx
          .update(planItem)
          .set(values)
          .where(and(eq(planItem.id, edit.id), eq(planItem.planId, planId)))
      } else {
        await tx.insert(planItem).values({ planId, ...values })
      }
    }
  })
}

/**
 * Turns the selected items into issues, gathered under one milestone. With `start` the `factory` label
 * goes on at creation, so the work begins at once; without it the issues wait and each is started
 * from the plan. An item that fails stops the run there: the ones already created keep their issue, and
 * the next call carries on with the rest.
 */
export async function createPlanIssues(
  deps: WorkDeps,
  planId: number,
  options: { start: boolean },
) {
  const current = await getPlan(deps.db, planId)
  if (!current) throw new ActionRefused('this plan does not exist')
  if (current.status !== 'ready' && current.status !== 'created') {
    throw new ActionRefused('the plan is not ready yet')
  }
  await enabledRepository(deps, current.repository)
  const todo = current.items.filter((i) => i.selected && i.issueNumber === null)
  if (todo.length === 0) throw new ActionRefused('no selected item is waiting to become an issue')

  const { token } = await deps.github.installationToken(current.repository)
  if (options.start) await readyFactoryLabel(deps, current.repository, token)
  let milestone = current.milestoneNumber
  if (milestone === null) {
    milestone = await deps.issues.createMilestone(current.repository, token, {
      title: `Plan ${planId}: ${current.goal.replace(/\s+/g, ' ').slice(0, 60)}`,
      description: current.goal.slice(0, 1_000),
    })
    await deps.db.update(plan).set({ milestoneNumber: milestone }).where(eq(plan.id, planId))
  }

  const created: number[] = []
  let failure: string | undefined
  for (const item of todo) {
    try {
      const issue = await deps.issues.createIssue(current.repository, token, {
        title: item.title,
        body: `${item.body}${FOOTER(`Planned (plan ${planId})`)}`,
        labels: options.start ? [FACTORY_LABEL] : [],
        milestone,
      })
      await deps.db
        .update(planItem)
        .set({ issueNumber: issue.number, issueUrl: issue.url, started: options.start })
        .where(eq(planItem.id, item.id))
      created.push(issue.number)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      break
    }
  }
  const after = await getPlan(deps.db, planId)
  const done = after!.items.filter((i) => i.selected).every((i) => i.issueNumber !== null)
  await deps.db
    .update(plan)
    .set({ status: done ? 'created' : 'ready', updatedAt: new Date() })
    .where(eq(plan.id, planId))
  return { created, failure: failure ?? null }
}

/** Puts the `factory` label on an issue the plan created without starting it. */
export async function startPlanItem(deps: WorkDeps, planId: number, itemId: number) {
  const current = await getPlan(deps.db, planId)
  const item = current?.items.find((i) => i.id === itemId)
  if (!current || !item) throw new ActionRefused('this item does not exist')
  if (item.issueNumber === null) throw new ActionRefused('this item is not an issue yet')
  if (item.started) throw new ActionRefused('this issue was already started')
  await enabledRepository(deps, current.repository)
  const { token } = await deps.github.installationToken(current.repository)
  await readyFactoryLabel(deps, current.repository, token)
  await deps.issues.addLabels(current.repository, token, item.issueNumber, [FACTORY_LABEL])
  await deps.db.update(planItem).set({ started: true }).where(eq(planItem.id, itemId))
}
