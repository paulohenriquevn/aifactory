// The evaluation suite against real agents, a real sandbox and the factory's own database (ADR 0008). It costs
// money and runs only through `npm run evals`, `npm run evals:cases` or `npm run evals:check`, never with the
// unit or integration tests. What each mode does is in docs/como-funciona.md.
//
//   EVALS_MODE      cases | run | check (default run)
//   EVALS_SET       quick | all (run; default quick)
//   EVALS_CASES     comma-separated case ids, instead of a set
//   EVALS_BUDGET_USD    no case starts once this is spent (default 15)
//   EVALS_CONCURRENCY   cases at a time (default 2)
//   EVALS_BASELINE=1    write the run as evals/baseline.json
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getDb, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { integrationBranch } from '../factory/branches'
import { factoryDeps, githubAppFromEnv } from '../factory/deps'
import { optionsFor } from '../factory/engine-models'
import { labelsWithRepoChoice, loadRepoConfig } from '../factory/repo-config'
import { effectiveEnv } from '../factory/settings'
import { fetchIssue } from '../github/issues'
import type { KnowledgeSource } from '../knowledge/source'

import { markQuick, selectCandidates, type EvalCase } from './cases'
import { compareWithBaseline, summarize, type Baseline } from './compare'
import { deliveredCandidates, toCase } from './extract'
import { runCase } from './run-case'
import { E2B_USD_PER_MS, agentSetup, checkBeforeDeploy, runSuite, spentOn } from './suite'

const CASES = 'evals/cases.json'
const BASELINE = 'evals/baseline.json'
const env = process.env
const mode = env.EVALS_MODE ?? 'run'
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T
const writeJson = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

beforeAll(() => getStorageManager().configure(storageFromUrl(readDatabaseUrl())))
afterAll(() => getStorageManager().dispose())

/** The factory's agents and sandbox, with a knowledge base that records no delivery in the database. */
async function evalDeps(repository: string, issueLabels: string[]) {
  // The environment a task's run reads (job-deps.ts): the agents and models the owner chose in the panel win.
  const deps = factoryDeps(await effectiveEnv(getDb(), env))
  // The agents a task of this repository gets: the issue's labels, then the owner's choice for the repository.
  const labels = labelsWithRepoChoice(issueLabels, await loadRepoConfig(getDb(), repository))
  const builder = typeof deps.harness === 'function' ? deps.harness(labels) : deps.harness
  const chosen = typeof deps.reviewer === 'function' ? deps.reviewer(labels) : deps.reviewer
  const knowledge: KnowledgeSource | undefined = deps.knowledge && {
    ...deps.knowledge,
    delivered: async () => {},
  }
  return {
    sandbox: deps.sandbox,
    builder,
    reviewer: chosen ?? builder,
    author: deps.author,
    knowledge,
  }
}

/** The agents each repository of the cases gets, with their models, keyed by repository. */
async function currentSetup(cases: EvalCase[]) {
  const setup: Record<string, string> = {}
  for (const repository of [...new Set(cases.map((c) => c.repository))].sort()) {
    const { builder, reviewer } = await evalDeps(repository, [])
    const one = agentSetup(await effectiveEnv(getDb(), env), builder.name, reviewer.name, optionsFor)
    for (const [key, value] of Object.entries(one)) setup[`${repository} ${key}`] = value
  }
  return setup
}

async function runCases(cases: EvalCase[]) {
  const byId = new Map(cases.map((c) => [c.id, c]))
  const ran = await runSuite(
    cases.map((c) => c.id),
    async (id) => {
      const c = byId.get(id)!
      const result = await runCase(await evalDeps(c.repository, c.labels), c)
      console.log(JSON.stringify({ event: 'eval_case', ...result }))
      return result
    },
    {
      budgetUsd: Number(env.EVALS_BUDGET_USD ?? 15),
      concurrency: Number(env.EVALS_CONCURRENCY ?? 2),
      sandboxUsdPerMs: E2B_USD_PER_MS,
    },
  )
  const record = {
    commit: git('rev-parse', 'HEAD'),
    ranAt: new Date().toISOString(),
    setup: await currentSetup(cases),
    spentUsd: spentOn(ran.results, E2B_USD_PER_MS),
    summary: summarize(ran.results),
    skipped: ran.skipped,
    results: ran.results,
  }
  mkdirSync('.evals', { recursive: true })
  writeJson(`.evals/run-${record.ranAt.replace(/[:.]/g, '-')}.json`, record)
  console.log(JSON.stringify({ event: 'eval_run', ...record, results: undefined }))
  return record
}

function chosenCases(): EvalCase[] {
  const all = readJson<EvalCase[]>(CASES)
  if (env.EVALS_CASES) {
    const ids = env.EVALS_CASES.split(',').map((s) => s.trim())
    return all.filter((c) => ids.includes(c.id))
  }
  return env.EVALS_SET === 'all' ? all : all.filter((c) => c.quick)
}

describe.runIf(mode === 'cases')('the cases', () => {
  it('are written from the tasks the factory delivered', async () => {
    const app = githubAppFromEnv(env)
    const chosen = selectCandidates(await deliveredCandidates(getDb()), {
      count: Number(env.EVALS_COUNT ?? 30),
      maxDurationMs: 35 * 60_000,
    })
    const cases: EvalCase[] = []
    for (const candidate of chosen) {
      const { token } = await app.installationToken(candidate.repository)
      cases.push(
        await toCase(candidate, {
          issue: (repo, n) => fetchIssue(repo, n, token),
          parentOf: async (repo, sha) => {
            const answer = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}`, {
              headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
            })
            if (!answer.ok)
              throw new Error(`GitHub answered ${answer.status} reading ${repo}@${sha}`)
            return ((await answer.json()) as { parents: { sha: string }[] }).parents[0].sha
          },
          config: async (repo) => {
            const config = await loadRepoConfig(getDb(), repo)
            return { integrationBranch: integrationBranch(config), egress: config.egress }
          },
        }),
      )
    }
    writeJson(CASES, markQuick(cases, Number(env.EVALS_QUICK ?? 5)))
    expect(cases.length).toBeGreaterThan(0)
  })
})

describe.runIf(mode === 'run')('a run of the suite', () => {
  it('runs the chosen cases and writes what each came to', async () => {
    const record = await runCases(chosenCases())
    if (env.EVALS_BASELINE === '1') {
      const baseline: Baseline = {
        commit: record.commit,
        ranAt: record.ranAt,
        setup: record.setup,
        results: record.results,
      }
      writeJson(BASELINE, { ...baseline, spentUsd: record.spentUsd, summary: record.summary })
    } else if (env.EVALS_COMPARE !== '0') {
      const compared = compareWithBaseline(record.results, readJson<Baseline>(BASELINE))
      console.log(JSON.stringify({ event: 'eval_compared', ...compared }))
    }
    expect(record.results.length).toBeGreaterThan(0)
  })
})

describe.runIf(mode === 'check')('the agent configuration', () => {
  it('is no worse than the baseline when it changed since then', async () => {
    const baseline = readJson<Baseline>(BASELINE)
    const changedPaths = [
      ...git('diff', '--name-only', baseline.commit, 'HEAD').split('\n'),
      ...git('diff', '--name-only', 'HEAD').split('\n'),
    ].filter(Boolean)
    const quick = readJson<EvalCase[]>(CASES).filter((c) => c.quick)
    const checked = await checkBeforeDeploy({
      baseline,
      changedPaths,
      setup: await currentSetup(quick),
      runQuick: async () => (await runCases(quick)).results,
    })
    console.log(JSON.stringify({ event: 'eval_check', ...checked }))
    expect(checked.reasons).toEqual([])
    expect(checked.ok).toBe(true)
  })
})
