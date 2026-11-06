import { provisionRepo } from '@theokit/agents/sandbox'
import { eq } from 'drizzle-orm'

import type { Database } from '../db'
import { plan, planItem } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { GithubApi } from '../github/pulls'
import { KnowledgeFeed } from '../knowledge/feed'
import { knowledgeRules } from '../knowledge/prompt'
import type { KnowledgeSource } from '../knowledge/source'

import type { CodingHarness } from './harness'
import { jsonObjects } from './review'
import { ensureBranches, integrationBranch } from './branches'
import { loadRepoConfig, labelsWithRepoChoice } from './repo-config'
import { mergeEgress } from './run-support'
import { createIsolatedSandbox, type IsolatedSandboxProvider } from './sandbox'

/** More than this is not a plan an owner will read, and each item is a run that costs money. */
export const MAX_ITEMS = 10
const TITLE_MAX = 120
const BODY_MAX = 6_000
const SUMMARY_MAX = 600

export type PlanDraft = {
  summary: string
  items: { title: string; body: string }[]
}

/** What the planning agent is told. It reads the repository and writes nothing. */
export function planPrompt(input: { repo: string; goal: string; knowledgeDir?: string }): string {
  return `You are planning work for the repository ${input.repo}. The owner wants this:

${input.goal}

Read the repository first: its layout, its conventions, its tests and what is already there. Do not change anything, and do not run anything that writes.

Break the goal into at most ${MAX_ITEMS} GitHub issues, each one a coding agent will implement on its own, in a branch of its own, from the default branch. So:
- Each issue must stand alone: it must not depend on another issue being merged first.
- Each one must be small enough for one pull request.
- Each body says what to build and where, then lists acceptance criteria as behavior someone can check ("the function returns X for Y", "the test for Z passes"), never as effort or file counts.
- Name the files and the existing code the agent should look at when you know them.
${input.knowledgeDir ? `- Keep each issue within the owner's rules; name the rule when it decides how something is built.\n\n${knowledgeRules(input.knowledgeDir)}\n` : ''}
Finish with one JSON object on its own, and nothing after it:

{"summary":"one or two sentences on how you split the work","issues":[{"title":"short imperative title","body":"markdown body"}]}
`
}

/**
 * Reads the plan the agent ended with. Titles and bodies are cut to a size an issue can take, an item
 * without a title or a body is dropped, and a plan with no usable item is no plan at all.
 */
export function parsePlan(text: string): PlanDraft | undefined {
  for (const candidate of jsonObjects(text).reverse()) {
    let parsed: { summary?: unknown; issues?: unknown }
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!Array.isArray(parsed.issues)) continue
    const items = parsed.issues
      .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
      .map((i) => ({
        title: typeof i.title === 'string' ? i.title.trim().slice(0, TITLE_MAX) : '',
        body: typeof i.body === 'string' ? i.body.trim().slice(0, BODY_MAX) : '',
      }))
      .filter((i) => i.title !== '' && i.body !== '')
      .slice(0, MAX_ITEMS)
    if (items.length === 0) continue
    return {
      summary: String(parsed.summary ?? '')
        .trim()
        .slice(0, SUMMARY_MAX),
      items,
    }
  }
  return undefined
}

export type PlanDeps = {
  db: Database
  github: GithubApp
  /** Used to make sure the repository has its integration branch before it is read. */
  api: Pick<GithubApi, 'defaultBranch' | 'branchHead' | 'createBranch'>
  sandbox: IsolatedSandboxProvider
  harness: (labels: string[]) => CodingHarness
  timeoutMs?: number
  /** Where the knowledge base comes from, the same source the runs read. */
  knowledge?: KnowledgeSource
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Has an agent read the repository and split the goal into issues. It runs in a sandbox like any other
 * agent, with the same firewall, and what it produces is a draft the owner edits: nothing reaches
 * GitHub from here. A failure is recorded on the plan, never thrown, because a plan is not a task and
 * nobody retries it from a queue.
 */
export async function runPlan(deps: PlanDeps, planId: number): Promise<void> {
  const { db } = deps
  const [row] = await db.select().from(plan).where(eq(plan.id, planId))
  if (!row || row.status !== 'planning') return

  const finish = (values: Partial<typeof plan.$inferInsert>) =>
    db
      .update(plan)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(plan.id, planId))

  let stop: (() => Promise<void>) | undefined
  try {
    const config = await loadRepoConfig(db, row.repository)
    const agent = deps.harness(labelsWithRepoChoice([], config))
    const { token } = await deps.github.installationToken(row.repository)
    await ensureBranches(deps.api, row.repository, token, {
      integration: integrationBranch(config),
      release: config.releaseBranch,
    })
    const sandbox = await createIsolatedSandbox(deps.sandbox, {
      cacheKey: row.repository,
      timeoutMs: (deps.timeoutMs ?? 15 * 60_000) + 5 * 60_000,
      egress: [
        {
          domain: 'github.com',
          headers: {
            authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
          },
        },
        ...mergeEgress([await agent.egress()]),
        { domain: 'registry.npmjs.org' },
        ...config.egress.map((domain) => ({ domain })),
      ],
    })
    stop = () => sandbox.stop().catch(() => {})
    const { repoDir } = await provisionRepo(sandbox.backend, {
      repoUrl: `https://github.com/${row.repository}.git`,
      ref: integrationBranch(config),
      instanceId: 'plan',
    })
    await agent.prepare?.(sandbox.backend)
    const feed = await KnowledgeFeed.open(deps.knowledge, sandbox.backend, row.repository, {
      planId,
    })
    // Stopping the sandbox stops the feed first, so no copy goes into a sandbox that is gone.
    stop = () =>
      feed
        .attachTo(sandbox)
        .stop()
        .catch(() => {})
    const result = await agent.run(sandbox.backend, {
      cwd: repoDir,
      timeoutMs: deps.timeoutMs ?? 15 * 60_000,
      prompt: planPrompt({ repo: row.repository, goal: row.goal, knowledgeDir: feed.dir }),
    })
    const cost = result.costUsd ?? 0
    if (result.quota) {
      await finish({
        status: 'failed',
        costUsd: cost,
        error: `the ${agent.name} quota ran out: ${result.quota.message}`,
      })
      return
    }
    const draft = result.ok ? parsePlan(result.summary) : undefined
    if (!draft) {
      const why = result.ok
        ? 'the agent did not end with a usable plan'
        : `the agent did not finish: ${result.summary}`
      await finish({ status: 'failed', costUsd: cost, error: why.slice(0, 600) })
      return
    }
    await db
      .insert(planItem)
      .values(draft.items.map((item, position) => ({ planId, position, ...item })))
    await finish({ status: 'ready', summary: draft.summary, costUsd: cost })
  } catch (error) {
    await finish({ status: 'failed', error: message(error).slice(0, 600) })
  } finally {
    await stop?.()
  }
}
