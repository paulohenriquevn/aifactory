import { createGithubApi } from '../github/pulls'

import { factoryDeps } from './deps'
import { harnessRegistry, pickHarness } from './harness-registry'
import type { PlanDeps } from './plan'

/** What planning needs, from the same environment a run reads. */
export function planDeps(env: NodeJS.ProcessEnv = process.env): PlanDeps {
  const deps = factoryDeps(env)
  const choice = deps.harness
  const builder = typeof choice === 'function' ? choice : () => choice
  // The planner is the builder's agent unless the owner gave it another.
  const planner = env.FACTORY_PLANNER
  return {
    db: deps.db,
    github: deps.github,
    api: createGithubApi(),
    sandbox: deps.sandbox,
    harness: planner ? (labels) => pickHarness(harnessRegistry(env), planner, labels) : builder,
  }
}
