import { agentConfigurationChanged } from './cases'
import { compareWithBaseline, type AgentSetup, type Baseline, type CaseResult } from './compare'

/**
 * What a second of an E2B sandbox of the factory's size costs: 4 vCPUs at US$ 0.000014 and 8 GiB at
 * US$ 0.0000045 each, as https://e2b.dev/pricing listed on 2026-11-11. Per millisecond, about US$ 0.33 an
 * hour. The agents' own cost comes from what each agent reports.
 */
export const E2B_USD_PER_MS = (4 * 0.000014 + 8 * 0.0000045) / 1000

/** What the cases cost: what the agents reported plus the time their sandboxes ran. */
export function spentOn(results: CaseResult[], sandboxUsdPerMs: number): number {
  return results.reduce((sum, r) => sum + r.costUsd + r.durationMs * sandboxUsdPerMs, 0)
}

/**
 * Runs the cases `concurrency` at a time. Before a case starts, what the finished ones cost is added up, and
 * once it reaches `budgetUsd` no other case starts: the ones left are named in `skipped`. A case already
 * running finishes, so the total can pass the budget by what the cases in flight cost.
 */
export async function runSuite(
  ids: string[],
  runOne: (id: string) => Promise<CaseResult>,
  options: { budgetUsd: number; concurrency: number; sandboxUsdPerMs: number },
): Promise<{ results: CaseResult[]; skipped: string[] }> {
  const done = new Map<string, CaseResult>()
  const skipped: string[] = []
  const queue = [...ids]
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (spentOn([...done.values()], options.sandboxUsdPerMs) >= options.budgetUsd) {
        skipped.push(id)
        continue
      }
      done.set(id, await runOne(id))
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker))
  return {
    results: ids.filter((id) => done.has(id)).map((id) => done.get(id)!),
    skipped: ids.filter((id) => skipped.includes(id)),
  }
}

/** The settings that differ between the baseline's setup and this one, as `key: before -> now`. */
function setupChanges(before: AgentSetup, now: AgentSetup): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(now)])].sort()
  return keys
    .filter((key) => before[key] !== now[key])
    .map((key) => `${key}: ${before[key] ?? '(none)'} -> ${now[key] ?? '(none)'}`)
}

/** Which agents a run gets and the model and effort each is told to use, `default` when nothing is set. */
export function agentSetup(
  env: NodeJS.ProcessEnv,
  builder: string,
  reviewer: string,
  options: (
    env: NodeJS.ProcessEnv,
    role: 'builder' | 'reviewer',
    engine: string,
  ) => { model?: string; effort?: string },
): AgentSetup {
  const b = options(env, 'builder', builder)
  const r = options(env, 'reviewer', reviewer)
  return {
    builder,
    builderModel: b.model ?? 'default',
    builderEffort: b.effort ?? 'default',
    reviewer,
    reviewerModel: r.model ?? 'default',
    reviewerEffort: r.effort ?? 'default',
  }
}

export type DeployCheck = { ran: boolean; ok: boolean; reasons: string[]; changed: string[] }

/**
 * The gate before a deploy: when a file that steers the agents changed since the baseline's commit, or the
 * agents or their models are not the baseline's, the quick set runs and is compared with the baseline.
 * Nothing changed, nothing runs.
 */
export async function checkBeforeDeploy(input: {
  baseline: Baseline
  changedPaths: string[]
  setup: AgentSetup
  runQuick: () => Promise<CaseResult[]>
}): Promise<DeployCheck> {
  const changed = [
    ...agentConfigurationChanged(input.changedPaths),
    ...setupChanges(input.baseline.setup, input.setup),
  ]
  if (changed.length === 0) return { ran: false, ok: true, reasons: [], changed }
  const compared = compareWithBaseline(await input.runQuick(), input.baseline)
  return { ran: true, ok: compared.ok, reasons: compared.reasons, changed }
}
