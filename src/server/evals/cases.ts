import type { CheckSpec } from '../factory/evidence'

/** A task the factory delivered, as the database recorded its last run. */
export type Candidate = {
  taskId: number
  repository: string
  issueNumber: number
  /** The commit the first checks ran on: the builder's, or the fix commit on top of it. */
  firstSha: string
  /**
   * The builder's first commit when the first checks ran on a fix commit on top of it: its parent is the
   * commit the run started from. Absent when the first checks ran on the builder's commit (`firstSha`).
   */
  startSha?: string
  mergedSha: string
  costUsd: number
  durationMs: number
  attempts: number
  /** The checks that ran on that commit, which are what accepted the work. */
  checks: CheckSpec[]
}

/** One case of the suite: a past task, from the commit it started on, with what accepted it. */
export type EvalCase = {
  /** `owner/repo#issue`. */
  id: string
  repository: string
  issueNumber: number
  title: string
  body: string
  labels: string[]
  kind: 'bug' | 'feature'
  integrationBranch: string
  baseSha: string
  checks: CheckSpec[]
  /** The repository's fix commands, run before each round of checks; absent means none. */
  fixes?: string[]
  /** Domains the repository's checks reach besides the registry, as the owner set them. */
  egress: string[]
  /** What the factory's own run of this task came to, for comparison. */
  original: {
    taskId: number
    costUsd: number
    durationMs: number
    attempts: number
    mergedSha: string
  }
  /** Part of the small set run before a deploy. */
  quick?: boolean
}

/** Takes one item from each group in turn until `count`, the groups in the order of their keys. */
function inTurn<T>(groups: Map<string, T[]>, count: number): T[] {
  const queues = [...groups.keys()].sort().map((key) => [...groups.get(key)!])
  const taken: T[] = []
  while (taken.length < count && queues.some((q) => q.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift()
      if (next !== undefined && taken.length < count) taken.push(next)
    }
  }
  return taken
}

function byRepository<T extends { repository: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items)
    groups.set(item.repository, [...(groups.get(item.repository) ?? []), item])
  return groups
}

/**
 * The tasks to turn into cases: each repository in turn, the most recent first, so the suite covers every
 * repository the factory works on. A run longer than `maxDurationMs`, one with no check (nothing accepted
 * it) or one with no cost recorded cannot be compared and is left out.
 */
export function selectCandidates(
  pool: Candidate[],
  options: { count: number; maxDurationMs: number },
): Candidate[] {
  const usable = pool
    .filter((c) => c.durationMs <= options.maxDurationMs && c.checks.length > 0 && c.costUsd > 0)
    .sort((a, b) => b.taskId - a.taskId)
  return inTurn(byRepository(usable), options.count)
}

/**
 * Marks `count` cases as the quick set run before a deploy: the shortest of each repository in turn, so the
 * set is cheap and still reaches every repository it can.
 */
export function markQuick(cases: EvalCase[], count: number): EvalCase[] {
  const groups = byRepository(cases)
  for (const [key, group] of groups) {
    groups.set(
      key,
      [...group].sort((a, b) => a.original.durationMs - b.original.durationMs),
    )
  }
  const quick = new Set(inTurn(groups, count).map((c) => c.id))
  return cases.map((c) => ({ ...c, quick: quick.has(c.id) }))
}

export const kindOf = (labels: string[]): EvalCase['kind'] =>
  labels.some((l) => l.toLowerCase() === 'bug') ? 'bug' : 'feature'

/**
 * The files whose change can change what the agents do: their prompts, the harnesses that run them, the
 * models they are given, the facts the factory checks without a model, and the sandbox they work in.
 */
export const AGENT_CONFIGURATION = [
  'src/server/factory/harness.ts',
  'src/server/factory/harness-claude.ts',
  'src/server/factory/harness-codex.ts',
  'src/server/factory/harness-registry.ts',
  'src/server/factory/review.ts',
  'src/server/factory/waiting.ts',
  'src/server/factory/engine-models.ts',
  'src/server/factory/models.ts',
  'src/server/factory/guards.ts',
  'src/server/factory/required-files.ts',
  'src/server/factory/evidence.ts',
  'src/server/factory/e2b-template.ts',
  'src/server/factory/security-floor.ts',
  'src/server/factory/security-scan.ts',
  'src/server/knowledge/prompt.ts',
  'ops/sandbox/Dockerfile',
]
/** Everything under this folder is an agent's prompt, skill or hook. */
const AGENTS_FOLDER = 'src/server/agents/'

const isTest = (path: string) => /\.test\.[cm]?[jt]sx?$/.test(path)

/**
 * The quality gates and the guard against weakened tests: what decides whether work is good enough. A change
 * to one is never integrated by the factory on its own, since no evaluation measures it: the owner reads it.
 * A path that ends in `/` names a folder.
 */
export const QUALITY_GATES = [
  'quality/',
  'scripts/crap.mjs',
  'stryker.config.json',
  'vitest.stryker.config.ts',
  'vitest.config.ts',
  '.jscpd.json',
  '.github/workflows/',
  'src/server/factory/test-weakening.ts',
]

/** The paths among `changed` that belong to the agents' configuration. */
export function agentConfigurationChanged(changed: string[]): string[] {
  return changed.filter(
    (path) =>
      !isTest(path) && (AGENT_CONFIGURATION.includes(path) || path.startsWith(AGENTS_FOLDER)),
  )
}

/** The factory's own repository: the one whose code `AGENT_CONFIGURATION` names. */
export const FACTORY_REPOSITORY = 'paulohenriquevn/aifactory'

/**
 * The agent configuration a change of `repository` touches. The factory never integrates such a change on
 * its own: it waits for `pnpm evals:check` and the owner. Another repository's files of the same name are
 * its own code, so nothing there is held. `own` is the factory's repository, another name for a fork.
 */
export function heldForEvaluation(
  repository: string,
  changed: string[],
  own: string = FACTORY_REPOSITORY,
): string[] {
  return repository === own ? agentConfigurationChanged(changed) : []
}

/**
 * The quality gates a change of `repository` touches. Like the agent configuration, the factory never
 * integrates such a change on its own; unlike it, no evaluation measures it, so the owner reviews it.
 */
export function heldForReview(
  repository: string,
  changed: string[],
  own: string = FACTORY_REPOSITORY,
): string[] {
  if (repository !== own) return []
  return changed.filter(
    (path) =>
      !isTest(path) &&
      QUALITY_GATES.some((gate) => (gate.endsWith('/') ? path.startsWith(gate) : path === gate)),
  )
}
