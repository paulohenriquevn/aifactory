import { createGithubApi } from '../github/pulls'

import { factoryDeps } from './deps'
import { optionsFor } from './engine-models'
import { DEFAULT_HARNESS, harnessRegistry, pickHarness } from './harness-registry'
import type { PlanDeps } from './plan'

/** What planning needs, from the same environment a run reads. */
export function planDeps(env: NodeJS.ProcessEnv = process.env): PlanDeps {
  const deps = factoryDeps(env)
  // The planner is the builder's agent unless the owner gave it another, with its own model and effort.
  const planner = env.FACTORY_PLANNER || env.FACTORY_HARNESS || DEFAULT_HARNESS
  return {
    db: deps.db,
    github: deps.github,
    api: createGithubApi(),
    sandbox: deps.sandbox,
    knowledge: deps.knowledge,
    harness: (labels) =>
      pickHarness(harnessRegistry(env), planner, labels, 'harness', (engine) =>
        optionsFor(env, 'planner', engine),
      ),
  }
}
